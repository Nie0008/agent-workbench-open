// 任务服务：会话生命周期、事件落盘与广播、授权路由、委派与并发限制、
// 冲突/合并、恢复语义。renderer、Agent 工具、外部 MCP 共用此服务。
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Store } from './store';
import { MemoryService, MEMORY_CONTEXT_HEADER, type MemoryEntryInput, type MemoryEntryPatch } from './memoryService';
import { TaskWaiter, type WatchTarget } from './scheduler';
import { CredentialManager, type LocalSourceInput } from './credentials';
import { ClaudeCodeAdapter } from './adapters/claude';
import { DshAdapter } from './adapters/dsh';
import { GrokAdapter } from './adapters/grok';
import { ZCodeAdapter } from './adapters/zcode';
import { ModelCatalog, AGENT_IDS, type ModelProfileInput } from './modelCatalog';
import { GROK_SUPER_MODEL, GROK_SUPER_PROVIDER, GROK_SUPER_PROVIDER_ID,
  isGrokConfigProviderId, listGrokConfigProviders, grokSuperConfigAvailable, grokNativeEnv } from './grok-models';
import { MockAdapter, MockScript } from './adapters/mock';
import type { AgentAdapter, AgentSessionHandle, AgentSessionOpts } from './adapters/types';
import type { WorkbenchEvent, SessionRow, TaskScope, FileChangeInfo, SessionStatus, TaskUsageSummary, UsageField, UsageFieldCoverage, ProviderInfo, ModelProfile, MemoryKind, MemoryStatus } from '../shared/types';
import {
  isGitRepo, createWorktree, removeWorktree, worktreeApply, worktreeMergeCheck,
  gitStatusChanges, WriteConflictGuard, canonicalPath, buildBackgroundSnapshot,
} from './files';

export interface Settings {
  taskTimeoutSec: number;          // 连续无输出或工具进展的超时秒数；等待授权暂停
  maxConcurrentSubtasks: number;   // 默认 2
  maxDelegationsPerTask: number;   // 委派次数上限
}

const DEFAULT_SETTINGS: Settings = { taskTimeoutSec: 900, maxConcurrentSubtasks: 2, maxDelegationsPerTask: 20 };

const WORKBENCH_TOOLS = [
  'delegate_task', 'list_subtasks', 'read_task_result', 'append_task_message', 'cancel_task', 'get_task_events',
] as const;

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const EXTERNAL_AGENTS = new Set(['grok', 'dsh', 'zcode']);

interface Runtime {
  handle: AgentSessionHandle;
  adapter: AgentAdapter;
  timer: NodeJS.Timeout | null;
  idleTimer?: NodeJS.Timeout;
  closing?: Promise<void>;
  closed?: boolean;
  recentToolInputs: Map<string, { name: string; input: any }>;
  pendingTurn: boolean;
  ended?: boolean;
  resumeRetryPending?: boolean;   // 原生恢复后首轮空结果时自动重发一次
  lastUserText?: string;
}

export interface DelegateResult {
  ok: boolean;
  taskId?: string;
  error?: string;
}

export class TaskService {
  private runtimes = new Map<string, Runtime>();
  private runtimeGeneration = new Map<string, number>();
  private runtimeLocks = new Map<string, Promise<void>>();
  private pendingPermissions = new Map<string, {
    sessionId: string; toolName: string; input: any; createdAt: string; resolve: (r: { behavior: 'allow' | 'deny'; message?: string }) => void;
  }>();
  private writeGuards = new Map<string, WriteConflictGuard>();   // canonical cwd → guard（worktree 相互隔离）
  private writeLocks = new Map<string, string>();                // projectId → 占用者 sessionId（非 git 单写者）
  private notificationSeq = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private mockScripts = new Map<string, MockScript>();
  broadcast: (e: WorkbenchEvent) => void = () => {};

  readonly waiter: TaskWaiter;
  readonly modelCatalog: ModelCatalog;
  readonly memory: MemoryService;
  constructor(public store: Store, public credentials: CredentialManager,
    private readonly grokModelProviderList: (refresh?: boolean) => ProviderInfo[] =
      (refresh) => listGrokConfigProviders({ refresh })) {
    this.waiter = new TaskWaiter(store);
    this.modelCatalog = new ModelCatalog(store, credentials, () => this.grokModelProviderList());
    this.memory = new MemoryService(store);
  }
  waitTaskEvents(targets: WatchTarget[], timeoutMs?: number, signal?: AbortSignal) { return this.waiter.wait(targets, timeoutMs, signal); }
  progress(projectId?: string) {
    const sessions = this.store.recentSessions(projectId);
    const now = Date.now();
    return {ok:true, serverTime:new Date(now).toISOString(), tasks:sessions.map(s => {
      const last = this.store.latestEvent(s.id, true);
      const active = s.status === 'running';
      const lastAt = last?.createdAt ?? s.createdAt;
      return {taskId:s.id,projectId:s.projectId,parentTaskId:s.parentSessionId,title:s.title,agentId:s.agentId,model:s.model,status:s.status,
        runtimePresent:this.runtimes.has(s.id) && !this.runtimes.get(s.id)?.ended,lastActivityAt:lastAt,lastEventType:last?.type ?? null,
        quietSeconds:Math.max(0,Math.floor((now-Date.parse(lastAt))/1000)),
        suspectedStall:active && now-Date.parse(lastAt)>120000,
        waitReason:s.status==='waiting_permission'?'等待授权':active && last?.type==='tool_request'?'工具执行中':active?'等待执行器输出':s.status==='resuming'?'需发送消息恢复':null,
        latestSeq:this.store.lastSeq(s.id),summary:s.summary?.slice(0,400) ?? null};
    })};
  }
  projectMemory(projectId: string) {
    if (!this.store.getProject(projectId)) throw new Error('项目不存在');
    const value = this.store.getKV(`memory:${projectId}`);
    return value ? JSON.parse(value) : {version:0,facts:this.projectFacts(projectId),source:'legacy',updatedAt:null};
  }
  updateMemory(projectId: string, facts: string, expectedVersion: number, source: string) {
    if (typeof facts !== 'string' || facts.length > 20000) throw new Error('背景限 20000 字符');
    if (typeof source !== 'string' || !source.trim() || source.length>200) throw new Error('需要有效来源（不超过200字符）');
    const current=this.projectMemory(projectId);
    if (current.version!==expectedVersion) throw new Error('背景版本冲突，请重新读取再合并');
    const next={facts,version:current.version+1,source,updatedAt:new Date().toISOString()};
    this.store.setKV(`memory-history:${projectId}:${next.version}`,JSON.stringify(next));
    this.store.setKV(`memory:${projectId}`,JSON.stringify(next));
    this.store.setKV(`facts:${projectId}`,facts);
    return next;
  }

  // ---- 设置 ----
  getSettings(): Settings {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(this.store.getKV('settings') ?? '{}') }; }
    catch { return DEFAULT_SETTINGS; }
  }
  setSettings(patch: Partial<Settings>): Settings {
    const s = { ...this.getSettings(), ...patch };
    this.store.setKV('settings', JSON.stringify(s));
    return s;
  }

  registerMockScript(name: string, script: MockScript) { this.mockScripts.set(name, script); }

  adapters(): AgentAdapter[] {
    const list: AgentAdapter[] = [new ClaudeCodeAdapter(), new GrokAdapter(), new DshAdapter(), new ZCodeAdapter()];
    if (this.mockScripts.size > 0) list.push(new MockAdapter({ id: 'mock', steps: [] }));
    return list;
  }

  agentOptions(refresh = false) {
    if (refresh) this.grokModelProviderList(true);
    const agents = this.adapters().filter((adapter) => adapter.id !== 'mock').map((adapter) =>
      ({ agentId: adapter.id, displayName: adapter.displayName }));
    const sources = this.modelCatalog.sourceOptions();
    const sourceMap = new Map(sources.map((source) => [source.providerId, source]));
    const profiles = this.modelCatalog.availableProfiles(sources);
    const providers = profiles.map((profile) => ({ ...sourceMap.get(profile.providerId)!,
      profileId: profile.id, name: profile.name, model: profile.model }));
    const combinations = agents.flatMap((agent) => profiles.filter((profile) =>
      profile.agents.includes(agent.agentId as any)
        && (profile.providerId !== GROK_SUPER_PROVIDER_ID || profile.model !== GROK_SUPER_MODEL || grokSuperConfigAvailable()))
      .map((profile) => ({ agentId: agent.agentId, profileId: profile.id,
        providerId: profile.providerId, model: profile.model })));
    let defaultTaskCombo: (typeof combinations)[number] | null = null;
    try {
      const saved = JSON.parse(this.store.getKV('defaultTaskCombo') ?? 'null');
      defaultTaskCombo = combinations.find((combo) => combo.agentId === saved?.agentId
        && combo.providerId === saved?.providerId && combo.model === saved?.model) ?? null;
    } catch { /* invalid preference falls back to the first available combination */ }
    return { agents, providers, profiles: this.modelCatalog.list(), sources, combinations,
      defaultProviderId: this.store.getKV('defaultProviderId') ?? null, defaultTaskCombo };
  }

  saveModelProfile(input: ModelProfileInput) { return this.modelCatalog.save(input); }
  deleteModelProfile(id: string) { this.modelCatalog.remove(id); return { deleted: id }; }
  importModelProfiles() { return this.modelCatalog.importAvailable(); }
  saveCredentialSource(input: LocalSourceInput) {
    const source = this.credentials.saveLocalSource(input);
    this.modelCatalog.importAvailable();
    if (!this.store.getKV('defaultProviderId')) this.store.setKV('defaultProviderId', source.providerId);
    return source;
  }
  importCcSwitchCredential(providerId: string) {
    if (!providerId || providerId.startsWith('workbench-local:') || providerId.startsWith('grok-'))
      throw new Error('请选择 CC Switch 凭据来源');
    return this.store.transaction(() => {
      const original = this.credentials.listProviderInfos().find((item) => item.providerId === providerId);
      if (!original) throw new Error('CC Switch 凭据来源不可用');
      const profiles = this.modelCatalog.list().filter((item) => item.providerId === providerId);
      const source = this.credentials.importCcSwitchSource(providerId);
      if (source.model && !profiles.some((item) => item.model === source.model)) {
        const zhipu = source.baseUrl.replace(/\/$/, '') === 'https://open.bigmodel.cn/api/anthropic';
        profiles.push({ id:'', name:source.name, providerId, model:source.model,
          agents:zhipu ? [...AGENT_IDS] : AGENT_IDS.filter((id) => id !== 'grok'), sourceFingerprint:'' });
      }
      let added = 0;
      const copied = new Map<string, ModelProfile>();
      for (const profile of profiles) {
        let target = this.modelCatalog.find(source.providerId, profile.model);
        if (!target) {
          target = this.modelCatalog.save({ name:profile.name, providerId:source.providerId,
            model:profile.model, agents:profile.agents, reasoningLevel:profile.reasoningLevel });
          added++;
        }
        copied.set(profile.model, target);
      }
      const defaultProviderId = this.store.getKV('defaultProviderId');
      const defaultChanged = !defaultProviderId || defaultProviderId === providerId;
      if (defaultChanged) this.store.setKV('defaultProviderId', source.providerId);
      for (const key of ['defaultTaskCombo', ...AGENT_IDS.map((id) => `defaultTaskCombo:${id}`)]) {
        const raw = this.store.getKV(key);
        if (!raw) continue;
        try {
          const saved = JSON.parse(raw);
          const target = saved?.providerId === providerId ? copied.get(saved.model) : undefined;
          if (target?.agents.includes(saved.agentId)) this.store.setKV(key, JSON.stringify({
            ...saved, providerId:source.providerId, profileId:target.id,
          }));
        } catch { /* unrelated or invalid preference stays unchanged */ }
      }
      const existingTasksStillBound = this.store.listProjects().flatMap((project) => this.store.listSessions(project.id))
        .filter((session) => session.providerId === providerId).length;
      return { source, profilesCopied:added, defaultChanged, existingTasksStillBound };
    });
  }
  deleteCredentialSource(providerId: string) { this.credentials.deleteLocalSource(providerId); return { deleted: providerId }; }

  setDefaultTaskCombo(agentId: string, providerId: string, model: string) {
    const selected = this.agentOptions().combinations.find((combo) => combo.agentId === agentId
      && combo.providerId === providerId && combo.model === model);
    if (!selected) throw new Error('所选 Agent 与模型组合已不可用；请刷新模型列表。');
    this.store.transaction(() => {
      this.store.setKV(`defaultTaskCombo:${agentId}`, JSON.stringify(selected));
      this.store.setKV('defaultTaskCombo', JSON.stringify(selected));
    });
    return selected;
  }

  private isSupportedCombination(agentId: string, providerId: string, model: string): boolean {
    const profile = this.modelCatalog.find(providerId, model);
    return !!profile && profile.agents.includes(agentId as any)
      && this.modelCatalog.availableProfiles().some((p) => p.id === profile.id)
      && (providerId !== GROK_SUPER_PROVIDER_ID || model !== GROK_SUPER_MODEL || grokSuperConfigAvailable());
  }

  private adapterFor(session: SessionRow): AgentAdapter {
    if (session.agentId === 'mock') {
      const name = this.store.getKV(`mockScript:${session.id}`);
      const script = name ? this.mockScripts.get(name) : undefined;
      const effective = script ?? { id: 'mock-default', steps: [{ t: 'text' as const, text: '（默认模拟回复）' }, { t: 'result' as const, text: '模拟完成' }] };
      return new MockAdapter(effective);
    }
    switch (session.agentId) {
      case 'claude-code': return new ClaudeCodeAdapter();
      case 'grok': return new GrokAdapter();
      case 'dsh': return new DshAdapter();
      case 'zcode': return new ZCodeAdapter();
      default: throw new Error(`执行器未接入：${session.agentId}`);
    }
  }

  // ---- 项目 ----
  createProject(rootPath: string, name?: string) {
    const id = crypto.randomUUID();
    const p = { id, name: name || path.basename(rootPath), rootPath, isGit: isGitRepo(rootPath), createdAt: new Date().toISOString() };
    this.store.createProject(p);
    return p;
  }
  listProjects() { return this.store.listProjects(); }

  updateProjectFacts(projectId: string, facts: string) {
    // 已确认事实/决定作为项目背景来源；写入需用户或主 Agent 明确确认（由调用方保证）
    this.updateMemory(projectId, facts, this.projectMemory(projectId).version, 'user-or-controller');
  }
  projectFacts(projectId: string): string { return this.store.getKV(`facts:${projectId}`) ?? ''; }

  listMemoryEntries(projectId: string, filters: { status?: MemoryStatus; kind?: MemoryKind } = {}) { return this.memory.list(projectId,filters); }
  getMemoryEntry(projectId: string, id: string) { return this.memory.get(projectId,id); }
  getMemoryHistory(projectId: string, id: string) { return this.memory.history(projectId,id); }
  searchMemory(projectId: string, query: string, options: { statuses?: MemoryStatus[]; kind?: MemoryKind; limit?: number; excludeExpired?: boolean } = {}) {
    return this.memory.search(projectId,query,options);
  }
  createMemoryEntry(input: MemoryEntryInput) { return this.memory.create(input); }
  updateMemoryEntry(projectId: string, id: string, patch: MemoryEntryPatch, expectedVersion: number) {
    return this.memory.update(projectId,id,patch,expectedVersion);
  }
  setMemoryStatus(projectId: string, id: string, status: 'adopted'|'inactive', expectedVersion: number) {
    return this.memory.setStatus(projectId,id,status,expectedVersion);
  }
  replaceMemoryEntry(projectId: string, id: string, expectedVersion: number, input: Omit<MemoryEntryInput,'projectId'>) {
    return this.memory.replace(projectId,id,expectedVersion,input);
  }
  taskMemoryUsed(taskId: string) { return this.memory.getTaskInjection(taskId); }

  createHandoffDraft(taskId: string) {
    const task = this.store.getSession(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.kind !== 'main' && task.kind !== 'sub') throw new Error('任务类型不支持交接');
    if (!['idle','completed'].includes(task.status)) throw new Error(`任务状态为${task.status}，不能生成成功交接草稿`);
    const resultEvent = this.store.listEvents(taskId).filter((event) => event.type === 'result' && event.payload?.isError === false)
      .slice(-1)[0];
    if (!resultEvent || typeof resultEvent.payload?.text !== 'string' || !resultEvent.payload.text.trim())
      throw new Error('任务没有可用的成功结果事件，无法生成交接草稿');
    const body = `Agent 报告，待核对\n\n${resultEvent.payload.text.slice(0,19500)}`;
    return this.createMemoryEntry({ projectId:task.projectId,kind:'handoff',title:`交接草稿：${task.title}`.slice(0,200),body,
      source:`Workbench 任务结果（task ${task.id}，event seq ${resultEvent.seq}）`,taskId:task.id,
      evidenceRefs:[`task:${task.id}`,`event:seq:${resultEvent.seq}`],requestId:`handoff:${task.id}:${resultEvent.seq}` });
  }

  // ---- 会话创建 ----
  createMainSession(input: {
    projectId: string; title: string; prompt?: string; scope?: TaskScope;
    agentId?: string; model?: string; providerId?: string; mockScript?: string; background?: string; clientRequestId?: string;
  }): SessionRow {
    const requestKey = input.clientRequestId ? `create:${input.projectId}:${input.clientRequestId}` : null;
    if (input.clientRequestId && input.clientRequestId.length>200) throw new Error('请求 ID 过长');
    const fingerprint = JSON.stringify([input.projectId,input.title,input.prompt??'',input.agentId??'claude-code',input.model??null,input.providerId??null,input.scope?.fileWrite??true,input.background??'',input.mockScript??null]);
    if (requestKey) {
      const prior=this.store.getKV(requestKey);
      if (prior) { const record=JSON.parse(prior); if(record.fingerprint!==fingerprint) throw new Error('相同请求 ID 的参数不一致'); return this.store.getSession(record.taskId)!; }
    }
    if (input.background != null && (typeof input.background !== 'string' || input.background.length>20000)) throw new Error('任务背景限20000字符');
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error('项目不存在');
    const agentId = input.agentId ?? 'claude-code';
    const isMock = agentId === 'mock';
    if (agentId !== 'claude-code' && !EXTERNAL_AGENTS.has(agentId) && !(isMock && input.mockScript && this.mockScripts.has(input.mockScript))) throw new Error('执行器未接入');
    // 供应商解析：显式指定 > 此 Agent 保存的模型 > CC Switch 默认。
    // 保存过的模型若已失效，后续校验会报错，不会静默切换。
    let preferred: { providerId?: string; model?: string } | null = null;
    if (!input.providerId && !isMock) {
      try { preferred = JSON.parse(this.store.getKV(`defaultTaskCombo:${agentId}`) ?? 'null'); }
      catch { /* fall back to the existing CC Switch default */ }
    }
    let providerId = input.providerId ?? preferred?.providerId ?? this.store.getKV('defaultProviderId') ?? '';
    const grokConfigProvider = agentId === 'grok' && isGrokConfigProviderId(providerId)
      ? this.grokModelProviderList().find((p) => p.providerId === providerId) : undefined;
    if (!isMock && !(agentId === 'grok' && providerId === GROK_SUPER_PROVIDER_ID) && !grokConfigProvider) {
      if (!providerId) throw new Error('未选择供应商：请为新任务选择一个已配置凭据的供应商组合。');
      const prov = this.credentials.listProviderInfos().find((p) => p.providerId === providerId);
      if (!prov) throw new Error(`所选供应商不可用或已删除（${providerId.slice(0, 8)}…），请重新选择；不会自动切换到其他供应商。`);
      if (input.providerId && input.providerId !== providerId) { /* 输入显式指定但被改写——不可能路径，防御 */ }
    } else {
      providerId = input.providerId ?? providerId; // mock 会话记录绑定但不校验（测试用）
    }
    const model = input.model ?? (preferred?.model && providerId === preferred.providerId ? preferred.model : null)
      ?? (isMock ? 'glm-5.3-flash'
      : agentId === 'grok' && providerId === GROK_SUPER_PROVIDER_ID ? GROK_SUPER_MODEL
      : grokConfigProvider ? grokConfigProvider.model
      : this.providerModel(providerId));
    if (!isMock && !this.isSupportedCombination(agentId, providerId, model))
      throw new Error(`${agentId} 的模型与供应商组合无效；请从模型配置中选择，不会回退到其他模型或端点`);
    const id = crypto.randomUUID();
    const scope = input.scope ?? { fileWrite: true };
    const session=this.store.transaction(() => {
    this.store.createSession({
      id, projectId: input.projectId, kind: 'main', parentSessionId: null, title: input.title,
      agentId, model, cwd: project.rootPath, scope, providerId,
      delegation: null,
    });
    const profile = this.modelCatalog.find(providerId, model);
    if (profile) this.store.setKV(`modelProfile:${id}`, JSON.stringify({
      id: profile.id, reasoningLevel: profile.reasoningLevel ?? null, sourceFingerprint: profile.sourceFingerprint ?? null,
    }));
    if (isMock && input.mockScript) this.store.setKV(`mockScript:${id}`, input.mockScript);
    // A per-task selection only binds this session. Defaults change through explicit settings.
    const memory=this.projectMemory(input.projectId);
    const snapshot={projectVersion:memory.version,source:memory.source,facts:memory.facts,background:input.background??'',createdAt:new Date().toISOString()};
    this.store.setKV(`background:${id}`,JSON.stringify(snapshot));
    if (requestKey) this.store.setKV(requestKey,JSON.stringify({fingerprint,taskId:id}));
      return this.store.getSession(id)!;
    });
    if (input.prompt) void this.send(id, input.prompt).catch(() => {});
    return session;
  }

  private providerModel(providerId: string): string {
    const prov = this.credentials.listProviderInfos().find((p) => p.providerId === providerId);
    if (!prov) throw new Error(`所选供应商不可用或已删除（${providerId.slice(0, 8)}…）；不会自动切换到其他供应商。`);
    if (!prov.model) throw new Error(`供应商 ${prov.name} 未配置模型 ID（ANTHROPIC_MODEL）。`);
    return prov.model;
  }

  // 会话供应商解析：绑定缺失/供应商删除都显式报错；绝不回退
  resolveSessionProvider(sessionId: string): { ok: boolean; providerId?: string; name?: string; model?: string; error?: string; needsProvider?: boolean } {
    const s = this.store.getSession(sessionId);
    if (!s) return { ok: false, error: '任务不存在' };
    if (s.agentId === 'mock') {
      if (s.providerId) {
        const prov = this.credentials.listProviderInfos().find((p) => p.providerId === s.providerId);
        if (!prov) return { ok: false, error: `该任务绑定的供应商已不存在（${s.providerId.slice(0, 8)}…）。请为其重新选择供应商；系统不会自动切换。`, needsProvider: true };
        return { ok: true, providerId: s.providerId, name: prov.name, model: s.model };
      }
      return { ok: true, providerId: undefined, model: s.model }; // mock 无绑定也可运行
    }
    if (!s.providerId) {
      return { ok: false, needsProvider: true, error: '该任务创建于旧版本，未记录供应商。请为它选择一个供应商并确认后才能继续（系统不会擅自绑定或切换）。' };
    }
    const savedProfile = this.store.getKV(`modelProfile:${sessionId}`);
    if (savedProfile) {
      const bound = JSON.parse(savedProfile);
      const current = this.modelCatalog.find(s.providerId, s.model);
      if (!current || current.id !== bound.id || (current.reasoningLevel ?? null) !== bound.reasoningLevel
        || (current.sourceFingerprint ?? null) !== bound.sourceFingerprint)
        return { ok: false, needsProvider: true, error: '此任务绑定的模型配置已改变；请重新绑定后继续，不会静默切换。' };
    }
    if (s.providerId === GROK_SUPER_PROVIDER_ID) {
      if (!this.isSupportedCombination(s.agentId, s.providerId, s.model))
        return { ok: false, error: 'Grok Super 任务的模型绑定无效，请新建任务选择模型。' };
      return { ok: true, providerId: s.providerId, name: GROK_SUPER_PROVIDER.name, model: s.model };
    }
    if (isGrokConfigProviderId(s.providerId)) {
      const current = this.grokModelProviderList().find((p) => p.providerId === s.providerId && p.model === s.model);
      if (s.agentId !== 'grok' || !current || !this.isSupportedCombination(s.agentId, s.providerId, s.model))
        return { ok: false, needsProvider: true, error: 'Grok 模型配置已更改或该模型不可用；为避免静默换端点，请恢复原配置或新建任务。' };
      return { ok: true, providerId: s.providerId, name: current.name, model: s.model };
    }
    const prov = this.credentials.listProviderInfos().find((p) => p.providerId === s.providerId);
    if (!prov) return { ok: false, needsProvider: true, error: `该任务绑定的供应商已不存在（${s.providerId.slice(0, 8)}…）。请重新选择并确认；系统不会自动切换到其他供应商。` };
    if (!this.isSupportedCombination(s.agentId, s.providerId, s.model))
      return { ok: false, needsProvider: true, error: `${s.agentId} 的模型配置已删除或该 Agent 不再可用，请重新绑定` };
    return { ok: true, providerId: s.providerId, name: prov.name, model: s.model };
  }

  // 用户显式为旧任务绑定供应商
  bindSessionProvider(sessionId: string, providerId: string, requestedModel?: string): { ok: boolean; error?: string } {
    const s = this.store.getSession(sessionId);
    if (!s) return { ok: false, error: '任务不存在' };
    if (s.nativeSessionId && s.providerId && s.providerId !== providerId)
      return { ok: false, error: '该任务已有原生会话；切换模型请新建任务，避免恢复到另一模型的历史会话。' };
    const model = requestedModel ?? this.modelCatalog.list().find((p) => p.providerId === providerId
      && p.agents.includes(s.agentId as any))?.model;
    if (!model || !this.isSupportedCombination(s.agentId, providerId, model))
      return { ok: false, error: '所选 Agent 与模型配置不可用，请刷新模型列表。' };
    if (s.nativeSessionId && s.model !== model)
      return { ok: false, error: '该任务已有原生会话；切换模型请新建任务，避免恢复到另一模型的历史会话。' };
    if (providerId === GROK_SUPER_PROVIDER_ID) {
      this.store.bindProvider(sessionId, providerId);
      this.store.updateSession(sessionId, { model });
      this.saveModelSnapshot(sessionId, providerId, model);
      const ev = this.store.appendEvent(sessionId, 'notice', { text: `已绑定 ${GROK_SUPER_PROVIDER.name}（模型 ${model}）。此绑定仅属于本任务。` });
      this.broadcast(ev);
      return { ok: true };
    }
    if (isGrokConfigProviderId(providerId)) {
      const current = this.grokModelProviderList().find((p) => p.providerId === providerId);
      if (s.agentId !== 'grok' || !current || current.model !== model) return { ok: false, error: 'Grok 模型配置已更改或该模型不可用，请刷新模型列表。' };
      this.store.bindProvider(sessionId, providerId);
      this.store.updateSession(sessionId, { model: current.model });
      this.saveModelSnapshot(sessionId, providerId, model);
      const ev = this.store.appendEvent(sessionId, 'notice', { text: `已绑定 ${current.name}。此绑定仅属于本任务。` });
      this.broadcast(ev);
      return { ok: true };
    }
    const prov = this.credentials.listProviderInfos().find((p) => p.providerId === providerId);
    if (!prov) return { ok: false, error: '供应商不存在或无凭据，无法绑定。' };
    this.store.bindProvider(sessionId, providerId);
    this.store.updateSession(sessionId, { model });
    this.saveModelSnapshot(sessionId, providerId, model);
    const ev = this.store.appendEvent(sessionId, 'notice', { text: `已绑定供应商「${prov.name}」（模型 ${model}）。此绑定仅属于本任务。` });
    this.broadcast(ev);
    return { ok: true };
  }

  private saveModelSnapshot(sessionId: string, providerId: string, model: string) {
    const profile = this.modelCatalog.find(providerId, model);
    if (!profile) return;
    this.store.setKV(`modelProfile:${sessionId}`, JSON.stringify({ id: profile.id,
      reasoningLevel: profile.reasoningLevel ?? null, sourceFingerprint: profile.sourceFingerprint ?? null }));
  }

  listSessions(projectId: string) { return this.store.listSessions(projectId); }
  getSession(sessionId: string) { return this.store.getSession(sessionId); }
  listSubtasks(parentSessionId: string) { return this.store.listSubtasks(parentSessionId); }
  listEvents(sessionId: string, sinceSeq = 0) { return this.store.listEvents(sessionId, sinceSeq); }

  // ---- 发送 / 取消 ----
  async send(sessionId: string, text: string, clientMsgId?: string): Promise<{ ok: boolean; error?: string; duplicate?: boolean; needsProvider?: boolean }> {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, error: '任务不存在' };
    if (clientMsgId && clientMsgId.length > 200) return { ok: false, error: '消息请求 ID 过长' };
    // 供应商绑定校验（真实 Agent 必须有可用绑定；缺失/删除时阻止并明确报错）
    const prov = this.resolveSessionProvider(sessionId);
    if (!prov.ok && session.agentId !== 'mock') {
      const ev = this.store.appendEvent(sessionId, 'error', { message: prov.error ?? '供应商不可用' });
      this.broadcast(ev);
      return { ok: false, error: prov.error, needsProvider: prov.needsProvider };
    }
    if (clientMsgId) {
      const guard = this.store.firstRun(sessionId, `send:${clientMsgId}`);
      if (!guard.first) return { ok: true, duplicate: true };
    }
    const rt0 = this.runtimes.get(sessionId);
    if (rt0) rt0.lastUserText = text;
    const priorUserMessage = this.store.listEvents(sessionId).some((event) => event.type === 'message' && event.payload?.role === 'user');
    if (!priorUserMessage) {
      const raw=this.store.getKV(`background:${sessionId}`);
      const bg = raw ? JSON.parse(raw) : null;
      const injection = this.memory.prepareTaskInjection(sessionId,`${session.title}\n${text}`);
      const sections: string[] = [];
      if (bg && (bg.facts || bg.background)) sections.push(`项目已确认背景（版本 ${bg.projectVersion}，来源 ${bg.source}）：\n${bg.facts}\n任务交接背景：\n${bg.background}`);
      if (injection.entries.length) sections.push(`${MEMORY_CONTEXT_HEADER}${injection.entries.map((entry) => entry.injectedText).join('\n\n')}`);
      if (sections.length) text=`${sections.join('\n\n')}\n\n本次要求：\n${text}`;
    }
    this.store.appendEvent(sessionId, 'message', { role: 'user', text });
    this.broadcast(this.store.listEvents(sessionId).slice(-1)[0]);
    try {
      await this.ensureRuntime(session, text);
    } catch (e: any) {
      if (!this.shuttingDown) {
        try {
          const ev = this.store.appendEvent(sessionId, 'error', { message: String(e?.message ?? e) });
          this.broadcast(ev);
        } catch { /* shutdown may already have closed durable storage */ }
      }
      return { ok: false, error: String(e?.message ?? e) };
    }
    return { ok: true };
  }

  cancel(sessionId: string, opts?: { cascade?: boolean; reason?: string }): { ok: boolean } {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false };
    const rt = this.runtimes.get(sessionId);
    // 拒绝所有待授权：取消后不再执行任何工具
    for (const [pid, p] of this.pendingPermissions) {
      if (p.sessionId === sessionId) {
        p.resolve({ behavior: 'deny', message: '任务已停止' });
        this.pendingPermissions.delete(pid);
        const ev = this.store.appendEvent(sessionId, 'permission_resolved', { permissionId: pid, decision: 'deny', reason: '任务已停止' });
        this.broadcast(ev);
      }
    }
    if (rt) {
      rt.closing = rt.handle.interrupt().then(() => rt.handle.close()).then(() => {
        rt.closed = true;
        if (this.runtimes.get(sessionId) === rt) {
          this.runtimes.delete(sessionId);
          this.retireRuntime(sessionId);
        }
      }).catch((error) => {
        rt.closing = undefined;
        const ev = this.store.appendEvent(sessionId, 'error', { message: `任务停止后的 Agent 进程关闭失败：${String(error?.message ?? error)}` });
        this.broadcast(ev);
        throw error;
      });
      void rt.closing.catch(() => {});
      this.clearTimer(sessionId);
    }
    this.setStatus(sessionId, 'stopped', opts?.reason ?? '用户停止');
    if (session.kind === 'main' && opts?.cascade !== false) {
      for (const sub of this.store.listSubtasks(sessionId)) {
        if (['running', 'waiting_permission', 'idle', 'resuming'].includes(sub.status)) {
          this.cancel(sub.id, { cascade: false, reason: '父任务已停止' });
          this.setStatus(sessionId, 'stopped');
          this.emitTo(sessionId, 'subtask_status', { subTaskId: sub.id, status: 'canceled' });
        }
      }
    }
    // 非 git 项目单写者锁释放
    const lockOwner = this.writeLocks.get(session.projectId);
    if (lockOwner === sessionId) this.writeLocks.delete(session.projectId);
    return { ok: true };
  }

  // ---- 授权 ----
  listPendingPermissions(taskId: string) {
    if (!this.store.getSession(taskId)) return { ok: false, error: '任务不存在' };
    return { ok: true, permissions: [...this.pendingPermissions].filter(([,p]) => p.sessionId === taskId)
      .map(([permissionId,p]) => ({permissionId, taskId, toolName:p.toolName, input:p.input, createdAt:p.createdAt})) };
  }

  respondPermission(permissionId: string, decision: 'allow' | 'deny', taskId?: string) {
    if (decision !== 'allow' && decision !== 'deny') return { ok:false, error:'无效授权决定' };
    const p = this.pendingPermissions.get(permissionId);
    if (!p) return { ok: false, error:'授权请求已处理或不存在' };
    if (taskId && p.sessionId !== taskId) return { ok:false, error:'授权请求与任务不匹配' };
    this.pendingPermissions.delete(permissionId);
    p.resolve(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝了该操作' });
    const ev = this.store.appendEvent(p.sessionId, 'permission_resolved', { permissionId, decision });
    this.broadcast(ev);
    const s = this.store.getSession(p.sessionId);
    if (s && s.status === 'waiting_permission' && ![...this.pendingPermissions.values()].some(x=>x.sessionId===p.sessionId)) {
      this.setStatus(p.sessionId, 'running');
      this.armTimer(p.sessionId);
    }
    return { ok: true };
  }

  private async requestPermission(session: SessionRow, toolName: string, input: any): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
    const permissionId = crypto.randomUUID();
    this.clearTimer(session.id);
    return new Promise((resolve) => {
      this.pendingPermissions.set(permissionId, { sessionId:session.id, toolName, input, createdAt:new Date().toISOString(), resolve });
      this.setStatus(session.id, 'waiting_permission');
      const ev = this.store.appendEvent(session.id, 'permission_request', { permissionId, toolName, input });
      this.broadcast(ev);
    });
  }

  // 范围授权策略：项目内读自动允许；项目内写按任务 scope；其余一律询问用户
  private async policyCheck(session: SessionRow, toolName: string, input: any): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
    const dbg = (msg: string) => { if (process.env.WORKBENCH_DEBUG) console.error(`[perm] ${toolName} ${msg}`); };
    dbg(`input=${JSON.stringify(input).slice(0, 120)}`);
    if (session.agentId === 'mock') return { behavior: 'allow' };
    if (WORKBENCH_TOOLS.some((tool) => toolName === `mcp__workbench__${tool}` || toolName === `workbench__${tool}`))
      return { behavior: 'allow' };
    const rawTarget: string | undefined = input?.file_path ?? input?.filePath ?? input?.notebook_path ?? input?.path
      ?? (Array.isArray(input?.edits) ? input.edits[0]?.file_path ?? input?.file_path : undefined);
    const targetPath = typeof rawTarget === 'string' ? path.resolve(session.cwd, rawTarget) : undefined;
    if (FILE_READ_TOOLS.has(toolName)) {
      if (!targetPath) return { behavior: 'allow' };              // Glob/Grep 的 pattern 形式
      return isInsideDir(session.cwd, targetPath) ? { behavior: 'allow' } : this.requestPermission(session, toolName, input);
    }
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const inCwd = targetPath ? isInsideDir(session.cwd, targetPath) : false;
      const scope: TaskScope = JSON.parse(session.scopeJson || '{}');
      if (inCwd && scope.fileWrite) {
        dbg(`inCwd=${inCwd} scope=${scope.fileWrite} -> allow`);
        const guard = this.writeGuards.get(canonicalPath(session.cwd));
        if (guard && targetPath) {
          const rel = path.relative(session.cwd, targetPath);
          const check = guard.checkBeforeWrite(rel);
          if (!check.ok) {
            const ev = this.store.appendEvent(session.id, 'conflict', { kind: 'write', path: rel, detail: check.reason });
            this.broadcast(ev);
            return { behavior: 'deny', message: check.reason };
          }
        }
        return { behavior: 'allow' };
      }
      return this.requestPermission(session, toolName, input);
    }
    if (toolName === 'TodoWrite' || toolName === 'TaskCreate' || toolName === 'TaskUpdate') return { behavior: 'allow' };
    return this.requestPermission(session, toolName, input);     // Bash、网络等需用户授权
  }

  // ---- 运行时 ----
  private buildEnv(session: SessionRow): Record<string, string> | null {
    if (session.agentId === 'mock') return { ...process.env } as Record<string, string>;
    if ((session.agentId === 'grok' && session.providerId === GROK_SUPER_PROVIDER_ID)
      || (session.agentId === 'grok' && isGrokConfigProviderId(session.providerId ?? ''))) {
      return grokNativeEnv();
    }
    // 使用会话绑定供应商（不含全局默认值）；轮换凭据经 CredentialManager 缓存过期自动生效
    const providerId = session.providerId ?? '';
    if (!providerId) throw new Error('该任务未绑定供应商，已阻止真实调用。请先为其选择供应商。');
    const env = this.credentials.buildSessionEnv(providerId, {
      ANTHROPIC_MODEL: session.model,
      USE_BUILTIN_RIPGREP: '0',
    });
    if (!env) {
      throw new Error(`供应商（${providerId.slice(0, 8)}…）凭据不可用或已删除；不会自动切换到其他供应商。请为该任务重新选择供应商。`);
    }
    return env;
  }

  private async ensureRuntime(session: SessionRow, firstText: string): Promise<void> {
    // Serialize runtime replacement and the first send. In particular, two sends
    // arriving while idle close is in flight must not start two SDK queries.
    const previous = this.runtimeLocks.get(session.id) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.runtimeLocks.set(session.id, lock);
    await previous;
    try {
      if (this.shuttingDown) throw new Error('任务服务正在关闭，无法启动 Agent');
      await this.ensureRuntimeLocked(this.store.getSession(session.id) ?? session, firstText);
    }
    finally {
      if (this.runtimeLocks.get(session.id) === lock) this.runtimeLocks.delete(session.id);
      release();
    }
  }

  private async ensureRuntimeLocked(session: SessionRow, firstText: string): Promise<void> {
    let rt = this.runtimes.get(session.id);
    if (rt?.idleTimer) { clearTimeout(rt.idleTimer); rt.idleTimer = undefined; }
    if (rt?.closing) {
      await rt.closing;
      if (this.shuttingDown) throw new Error('任务服务正在关闭，无法恢复 Agent');
      if (rt.closed) {
        if (this.runtimes.get(session.id) === rt) {
          this.runtimes.delete(session.id);
          this.retireRuntime(session.id);
        }
        rt = undefined;
      }
    }
    const resumeNative = session.nativeSessionId;
    if (!rt) {
      const adapter = this.adapterFor(session);
      const env = this.buildEnv(session) ?? {};
      const opts: AgentSessionOpts = {
        taskId: session.id,
        providerId: session.providerId ?? undefined,
        allowDelegation: session.kind === 'main',
        cwd: session.cwd,
        model: session.model,
        reasoningLevel: this.modelCatalog.find(session.providerId ?? '', session.model)?.reasoningLevel,
        env,
        canUseTool: (toolName, input) => this.policyCheck(session, toolName, input),
        resumeNativeSessionId: resumeNative ?? undefined,
        onEvent: (e) => this.onAdapterEvent(session.id, e),
        onEnd: (reason, error) => this.onAdapterEnd(session.id, reason, error),
        ...(session.kind === 'main' && session.agentId === 'claude-code' ? {
          mcpServers: this.mcpServerFactory ? await (this.mcpServerFactory as any)(session.id) : undefined,
        } : {}),
        ...(session.kind === 'sub' && session.agentId === 'claude-code' ? {
          disallowedTools: ['Task', 'Agent', 'WebFetch', 'WebSearch'],
        } : {}),
      };
      if (this.shuttingDown) throw new Error('任务服务正在关闭，无法启动 Agent');
      const generation = (this.runtimeGeneration.get(session.id) ?? 0) + 1;
      this.runtimeGeneration.set(session.id, generation);
      const handle = adapter.start({ ...opts,
        onEvent: (event) => { if (this.runtimeGeneration.get(session.id) === generation) this.onAdapterEvent(session.id, event); },
        onEnd: (reason, error) => { if (this.runtimeGeneration.get(session.id) === generation) this.onAdapterEnd(session.id, reason, error); },
      });
      rt = { handle, adapter, timer: null, recentToolInputs: new Map(), pendingTurn: true, resumeRetryPending: !!resumeNative, lastUserText: firstText };
      this.runtimes.set(session.id, rt);
      this.armTimer(session.id);
      if (resumeNative) this.setStatus(session.id, 'resuming');
      else this.setStatus(session.id, 'running');
    } else {
      rt.ended = false;
      this.armTimer(session.id);
      this.setStatus(session.id, 'running');
      await rt.handle.send(firstText);
    }
    if (rt.pendingTurn) {
      rt.pendingTurn = false;
      await rt.handle.send(firstText);
    }
  }

  // Release execution resources, retaining the native session and durable history.
  private scheduleIdleRelease(sessionId: string, delayMs: number) {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    if (rt.idleTimer) clearTimeout(rt.idleTimer);
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = undefined;
      const s = this.store.getSession(sessionId);
      if (this.shuttingDown || this.runtimes.get(sessionId) !== rt || !s ||
          !['idle', 'completed', 'failed'].includes(s.status)) return;
      if ([...this.pendingPermissions.values()].some(p => p.sessionId === sessionId)) return;
      const children = this.store.listSubtasks(sessionId);
      if (children.some(c => ['running', 'waiting_permission', 'resuming'].includes(c.status))) {
        this.scheduleIdleRelease(sessionId, 300000);
        return;
      }
      rt.closing = rt.handle.close().then(() => {
        rt!.closed = true;
        if (this.runtimes.get(sessionId) === rt) {
          this.runtimes.delete(sessionId);
          this.retireRuntime(sessionId);
          this.emitTo(sessionId, 'notice', {text: '空闲 Agent 进程已回收，任务记录保留；发送消息将恢复原生会话。'});
        }
      }).catch((error) => {
        rt!.closing = undefined;
        const ev = this.store.appendEvent(sessionId, 'error', { message: `空闲 Agent 进程回收失败，未确认资源已释放：${String(error?.message ?? error)}` });
        this.broadcast(ev);
      });
    }, delayMs);
    rt.idleTimer.unref();
  }

  private retireRuntime(sessionId: string) {
    this.runtimeGeneration.set(sessionId, (this.runtimeGeneration.get(sessionId) ?? 0) + 1);
  }

  private armTimer(sessionId: string) {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    this.clearTimer(sessionId);
    const sec = this.getSettings().taskTimeoutSec;
    rt.timer = setTimeout(() => {
      const ev = this.store.appendEvent(sessionId, 'notice', { text: `无响应超时（${sec}s 未收到输出或工具进展），自动停止` });
      this.broadcast(ev);
      this.cancel(sessionId, { reason: '无响应超时' });
      this.store.updateSession(sessionId, { status: 'timeout' });
      const ev2 = this.store.appendEvent(sessionId, 'session', { status: 'timeout', reason: '无响应超时' });
      this.broadcast(ev2);
    }, sec * 1000);
  }
  private clearTimer(sessionId: string) {
    const rt = this.runtimes.get(sessionId);
    if (rt?.timer) { clearTimeout(rt.timer); rt.timer = null; }
  }

  // ---- 适配器事件 → 事件流 ----
  private onAdapterEvent(sessionId: string, e: import('../shared/types').AdapterEvent) {
    try {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    if (['stopped','completed','failed','canceled','interrupted','timeout'].includes(session.status)) return;
    const rt = this.runtimes.get(sessionId);
    const activity = e.kind === 'activity' || e.kind === 'system' || e.kind === 'tool_use' || e.kind === 'tool_result'
      || ((e.kind === 'text_delta' || e.kind === 'assistant_message') && e.text.length > 0);
    // Refresh only an armed timer: waiting for permission and completed turns stay paused.
    if (activity) rt?.timer?.refresh();
    switch (e.kind) {
      case 'system':
        if (e.nativeSessionId) this.store.updateSession(sessionId, { nativeSessionId: e.nativeSessionId });
        if (session.status === 'resuming') this.setStatus(sessionId, 'running');
        break;
      case 'text_delta': {
        const ev = this.store.appendEvent(sessionId, 'text_delta', { text: e.text });
        this.broadcast(ev);
        break;
      }
      case 'assistant_message': {
        const ev = this.store.appendEvent(sessionId, 'message', { role: 'assistant', text: e.text });
        this.broadcast(ev);
        break;
      }
      case 'tool_use': {
        rt?.recentToolInputs.set(e.toolUseId, { name: e.name, input: e.input });
        const ev = this.store.appendEvent(sessionId, 'tool_request', { toolUseId: e.toolUseId, name: e.name, input: e.input });
        this.broadcast(ev);
        break;
      }
      case 'tool_result': {
        const info = rt?.recentToolInputs.get(e.toolUseId);
        const ev = this.store.appendEvent(sessionId, 'tool_result', {
          toolUseId: e.toolUseId, name: info?.name ?? e.name, ok: !e.isError, brief: (e.content ?? '').slice(0, 500),
        });
        this.broadcast(ev);
        // 成功写入推进自己的基线；失败或重复结果不能吸收外部修改。
        rt?.recentToolInputs.delete(e.toolUseId);
        if (!e.isError && info && FILE_WRITE_TOOLS.has(info.name)) {
          const p: string | undefined = info.input?.file_path ?? info.input?.notebook_path;
          if (p) {
            if (isInsideDir(session.cwd, p)) {
              const rel = path.relative(canonicalPath(session.cwd), canonicalPath(p));
              this.writeGuards.get(canonicalPath(session.cwd))?.snapshot([rel]);
            }
            this.emitFileChange(session, p);
          }
        }
        break;
      }
      case 'usage': {
        // 只持久化执行器上报的字段：缺失=未知（历史/未报告类别可辨识），不补零冒充已知
        const reported: Record<string, number> = {};
        if (typeof e.usage.input_tokens === 'number') reported.inputTokens = e.usage.input_tokens;
        if (typeof e.usage.output_tokens === 'number') reported.outputTokens = e.usage.output_tokens;
        if (typeof e.usage.cache_read_tokens === 'number') reported.cacheReadTokens = e.usage.cache_read_tokens;
        if (typeof e.usage.cache_creation_tokens === 'number') reported.cacheCreationTokens = e.usage.cache_creation_tokens;
        const ev = this.store.appendEvent(sessionId, 'usage', { ...reported, costUSD: e.costUSD });
        this.broadcast(ev);
        break;
      }
      case 'result': {
        this.store.updateSession(sessionId, { summary: e.text.slice(0, 2000) });
        const ev = this.store.appendEvent(sessionId, 'result', { isError: e.isError, numTurns: e.numTurns, text: e.text });
        this.broadcast(ev);
        this.clearTimer(sessionId);
        // 原生恢复被打断的会话时，CLI 可能返回空回合（numTurns=0 且无文本）并吞掉消息：自动重发一次
        if (e.numTurns === 0 && !e.isError && !e.text && rt?.resumeRetryPending && rt.lastUserText) {
          rt.resumeRetryPending = false;
          const ev2 = this.store.appendEvent(sessionId, 'notice', { text: '恢复后首轮为空（原会话在执行中被中断），已自动重发继续消息。' });
          this.broadcast(ev2);
          void this.send(sessionId, rt.lastUserText, `resume-retry-${sessionId}-${Date.now()}`);
          break;
        }
        if (rt) rt.resumeRetryPending = false;
        this.sweepFileChanges(session);
        if (session.kind === 'sub') {
          const status: SessionStatus = e.isError ? 'failed' : 'completed';
          this.setStatus(sessionId, status, e.text.slice(0, 300));
          this.notifyParent(session, status);
          this.releaseSubResources(session);
        } else {
          this.setStatus(sessionId, e.isError ? 'failed' : 'idle');
        }
        this.scheduleIdleRelease(sessionId, session.kind === 'sub' ? 0 : 300000);
        break;
      }
      case 'error': {
        const ev = this.store.appendEvent(sessionId, 'error', { message: e.message });
        this.broadcast(ev);
        break;
      }
    }
    } catch { /* 存储已关闭等场景：忽略晚到事件 */ }
  }

  private onAdapterEnd(sessionId: string, reason: 'done' | 'interrupted' | 'error', error?: string) {
    const runtime=this.runtimes.get(sessionId); if(runtime)runtime.ended=true;
    if (this.shuttingDown) return;   // 主动关停：状态不因进程退出而变化
    try {
    const session = this.store.getSession(sessionId);
    this.clearTimer(sessionId);
    if (!session) return;
    const current = this.store.getSession(sessionId)!;
    if (['completed', 'failed', 'stopped', 'canceled', 'timeout'].includes(current.status)) {
      // 终态已由 result/cancel 决定；done 的进程退出不改变状态
      if (reason === 'error' && current.status === 'running') this.setStatus(sessionId, 'failed', error);
      return;
    }
    if (reason === 'error') {
      // 原生恢复失败等情况：如实标记中断
      const ev = this.store.appendEvent(sessionId, 'session', { status: 'interrupted', reason: error ?? '会话异常退出' });
      this.broadcast(ev);
      this.store.updateSession(sessionId, { status: 'interrupted' });
    } else if (reason === 'interrupted') {
      if (current.status === 'running' || current.status === 'waiting_permission' || current.status === 'resuming') {
        this.setStatus(sessionId, 'stopped', '会话已停止');
      }
    } else {
      if (current.status === 'running' || current.status === 'waiting_permission') {
        this.setStatus(sessionId, session.kind === 'sub' ? 'completed' : 'idle');
      }
    }
    } catch { /* 存储已关闭等场景 */ }
  }

  private emitFileChange(session: SessionRow, absPath: string) {
    const rel = path.isAbsolute(absPath)
      ? path.relative(canonicalPath(session.cwd), canonicalPath(absPath))
      : absPath;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    let change: FileChangeInfo['change'] = 'modify';
    try { const fs = require('node:fs'); if (!fs.existsSync(absPath)) change = 'delete'; } catch { /* keep modify */ }
    const ev = this.store.appendEvent(session.id, 'file_change', { path: rel, change, origin: session.id });
    this.broadcast(ev);
  }

  // 回合结束后的 git 状态扫描（git 项目权威来源；worktree 内同样适用）
  private sweepFileChanges(session: SessionRow) {
    if (session.agentId === 'mock' && !isGitRepo(session.cwd)) {
      // 模拟会话也做 mtime 快照，供写冲突守卫使用
      return;
    }
    const changes = gitStatusChanges(session.cwd);
    const seen = new Set<string>();
    for (const c of changes) {
      const key = `${c.path}:${c.change}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ev = this.store.appendEvent(session.id, 'file_change', { path: c.path, change: c.change, origin: session.id });
      this.broadcast(ev);
    }
    // 快照当前改动文件 mtime，作为非 git 单写者冲突检测基线
    const guard = this.writeGuards.get(canonicalPath(session.cwd)) ?? new WriteConflictGuard(session.cwd);
    guard.snapshot(changes.map((c) => c.path));
    this.writeGuards.set(canonicalPath(session.cwd), guard);
  }

  private notifyParent(sub: SessionRow, status: SessionStatus) {
    if (!sub.parentSessionId) return;
    const parent = this.store.getSession(sub.parentSessionId);
    if (!parent) return;
    this.emitTo(parent.id, 'subtask_status', { subTaskId: sub.id, status, summary: sub.summary?.slice(0, 300) });
    if (['completed', 'failed', 'canceled', 'timeout'].includes(status) && parent.status !== 'stopped') {
      // 任务通知：推送到父会话，由主 Agent 决定读取结果与汇总
      this.notificationSeq++;
      void this.send(parent.id,
        `[任务通知] 子任务「${sub.title}」(${sub.id}) 状态: ${status}。可调用 read_task_result 查看结果并继续。`,
        `notify-${sub.id}-${status}-${this.notificationSeq}`);
    }
  }

  private releaseSubResources(sub: SessionRow) {
    const project = this.store.getProject(sub.projectId);
    if (!project) return;
    const lockOwner = this.writeLocks.get(project.id);
    if (lockOwner === sub.id) this.writeLocks.delete(project.id);
    if (project.isGit && sub.cwd !== project.rootPath) {
      // 保留 worktree 供用户查看差异；合并后由用户/流程清理
    }
  }

  private setStatus(sessionId: string, status: SessionStatus, reason?: string) {
    const prev = this.store.getSession(sessionId)?.status;
    if (prev === status) return;
    this.store.updateSession(sessionId, { status });
    const ev = this.store.appendEvent(sessionId, 'session', { status, reason, previous: prev });
    this.broadcast(ev);
  }

  private emitTo(sessionId: string, type: string, payload: any) {
    const ev = this.store.appendEvent(sessionId, type as any, payload);
    this.broadcast(ev);
  }

  // ---- 委派（供主 Agent 工具调用）----
  async delegate(parentSessionId: string, args: {
    title: string; instructions: string; context_files?: string[]; acceptance?: string;
  }, toolKey?: string): Promise<DelegateResult> {
    const parent = this.store.getSession(parentSessionId);
    if (!parent) return { ok: false, error: '父任务不存在' };
    if (parent.kind !== 'main') return { ok: false, error: '子任务不允许再委派（第一版禁止递归）' };
    const key = toolKey ?? `delegate:${sha1(parentSessionId + '|' + args.title + '|' + args.instructions)}`;
    const guard = this.store.firstRun(parentSessionId, key);
    if (!guard.first) {
      return { ok: true, taskId: guard.previous?.taskId, error: guard.previous?.error };
    }
    const finalize = async (r: DelegateResult) => { this.store.completeTool(parentSessionId, key, r); return r; };

    const settings = this.getSettings();
    const subs = this.store.listSubtasks(parentSessionId);
    const running = subs.filter((s) => ['running', 'waiting_permission', 'resuming', 'idle'].includes(s.status));
    if (running.length >= settings.maxConcurrentSubtasks) {
      return finalize({ ok: false, error: `并发子任务已达上限（${settings.maxConcurrentSubtasks}）。请等待运行中的子任务完成，或先 cancel_task。` });
    }
    if (subs.length >= settings.maxDelegationsPerTask) {
      return finalize({ ok: false, error: `本任务委派次数已达上限（${settings.maxDelegationsPerTask}）。` });
    }
    const project = this.store.getProject(parent.projectId)!;
    const subId = crypto.randomUUID();
    let cwd = project.rootPath;
    let writeScope = false;
    let readOnlyNote = false;
    const parentCanWrite = JSON.parse(parent.scopeJson || '{}').fileWrite === true;
    if (project.isGit) {
      try { cwd = createWorktree(project.rootPath, subId); writeScope = parentCanWrite; readOnlyNote = !parentCanWrite; }
      catch (e: any) { return finalize({ ok: false, error: `worktree 创建失败: ${String(e.message).slice(0, 200)}` }); }
    } else {
      const lockOwner = this.writeLocks.get(project.id);
      if (!parentCanWrite || (lockOwner && lockOwner !== subId && this.runtimes.has(lockOwner))) {
        // 非 git 项目单写者：后来者自动降级为只读
        writeScope = false;
        readOnlyNote = true;
      } else {
        writeScope = true;
        this.writeLocks.set(project.id, subId);
      }
    }
    const facts = this.projectFacts(project.id);
    // 背景快照：委派时生成文件内容/版本与未提交补丁（子任务 worktree 看不到主树未提交改动）
    const snapshotFiles = Array.from(new Set([...(args.context_files ?? [])]));
    const snap = buildBackgroundSnapshot(project.rootPath, snapshotFiles);
    const prompt = [
      `# 子任务：${args.title}`,
      `## 项目背景（已确认事实/决定）`, facts || '（暂无）', '',
      `## 任务背景快照`,
      `- 项目根目录: ${cwd}`,
      `- 所属主任务: ${parent.title} (${parent.id})`,
      '', `## 相关文件`,
      (snapshotFiles.length ? snapshotFiles.map((f) => `- ${f}`).join('\n') : '- （无）'), '',
      ...(snap.sections ? [`## 背景快照（委派时刻生成；版本 ${snap.meta.isGit ? `git HEAD ${snap.meta.head}` : '非git'}；子任务工作区如与快照不一致，以快照为审查基线）`, snap.sections, ''] : []),
      `## 要求`, args.instructions, '',
      args.acceptance ? `## 验收标准\n${args.acceptance}\n` : '',
      `## 约束`,
      '- 只在当前项目目录内读写文件；不要访问目录外资源。',
      ...(readOnlyNote ? ['- 本子任务为只读模式：父任务未授予写入，或当前写入锁已占用；禁止修改文件。'] : []),
      '- 网络访问等未授权操作会被用户拒绝，请不要依赖。',
      '- 完成后输出明确的结果摘要（做了什么、改动哪些文件、结论）。',
    ].filter(Boolean).join('\n');

    this.store.createSession({
      id: subId, projectId: project.id, kind: 'sub', parentSessionId, title: args.title,
      agentId: parent.agentId, model: parent.model, cwd, scope: { fileWrite: writeScope },
      providerId: parent.providerId,   // 子任务继承父任务的供应商与模型绑定
      delegation: { instructions: args.instructions, contextFiles: args.context_files, acceptance: args.acceptance, snapshot: snap.meta },
    });
    const parentModelProfile = this.store.getKV(`modelProfile:${parentSessionId}`);
    if (parentModelProfile) this.store.setKV(`modelProfile:${subId}`, parentModelProfile);
    if (parent.agentId === 'mock') {
      const scriptName = (args as any).mock_script ?? this.store.getKV(`mockScript:${parentSessionId}`);
      if (scriptName) this.store.setKV(`mockScript:${subId}`, String(scriptName));
    }
    const ev = this.store.appendEvent(parentSessionId, 'task_delegated', { subTaskId: subId, title: args.title, instructions: args.instructions.slice(0, 500) });
    this.broadcast(ev);
    void this.send(subId, prompt, `delegate-${subId}`);
    return finalize({ ok: true, taskId: subId });
  }

  // ---- 结果读取 / 子任务管理 ----
  readTaskResult(taskId: string): { ok: boolean; error?: string; result?: any } {
    const s = this.store.getSession(taskId);
    if (!s) return { ok: false, error: '任务不存在' };
    const files: FileChangeInfo[] = this.store.listEvents(taskId)
      .filter((e) => e.type === 'file_change')
      .map((e) => ({ path: e.payload.path, change: e.payload.change, origin: e.payload.origin }));
    const usageEvents = this.store.listEvents(taskId).filter((e) => e.type === 'usage');
    return {
      ok: true,
      result: {
        taskId, title: s.title, status: s.status, summary: s.summary,
        providerId: s.providerId, model: s.model,
        delegation: s.delegationJson ? JSON.parse(s.delegationJson) : null,
        filesChanged: files,
        usage: this.summarizeUsage(usageEvents),
      },
    };
  }

  // 用量汇总：只累计“已记录”的用量事件（执行器在每回合结果时上报，一回合一条）。
  // 未知 ≠ 零：没有任何已记录回合上报的类别为 null 并列入 fieldsNotReported；
  // 部分回合未上报的类别保留已报告小计，但经 fieldCoverage 标明为部分已知（complete=false）；
  // 费用只在全部已记录回合都已知时才给出合计（部分已知时宁缺勿冒充总费用）。
  // 中断/未上报的消耗无法统计，因此这不是任务的全部真实消耗。
  private summarizeUsage(usageEvents: WorkbenchEvent[]): TaskUsageSummary {
    const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;
    const sums = new Map<string, number>();
    const reportedRounds = new Map<string, number>();
    let costSum = 0;
    let costKnownRounds = 0;
    for (const e of usageEvents) {
      const p = e.payload ?? {};
      for (const f of fields) {
        const v = p[f];
        if (typeof v === 'number') {
          sums.set(f, (sums.get(f) ?? 0) + v);
          reportedRounds.set(f, (reportedRounds.get(f) ?? 0) + 1);
        }
      }
      if (typeof p.costUSD === 'number') { costSum += p.costUSD; costKnownRounds++; }
    }
    const rounds = usageEvents.length;
    const costAllKnown = rounds > 0 && costKnownRounds === rounds;
    const fieldCoverage = {} as Record<UsageField, UsageFieldCoverage>;
    for (const f of fields) {
      const reported = reportedRounds.get(f) ?? 0;
      fieldCoverage[f] = {
        roundsReported: reported,
        roundsMissing: rounds - reported,
        complete: rounds > 0 && reported === rounds,
      };
    }
    return {
      roundsRecorded: rounds,
      inputTokens: sums.get('inputTokens') ?? null,
      outputTokens: sums.get('outputTokens') ?? null,
      cacheReadTokens: sums.get('cacheReadTokens') ?? null,
      cacheCreationTokens: sums.get('cacheCreationTokens') ?? null,
      fieldCoverage,
      costUSD: costAllKnown ? costSum : null,
      costKnown: costAllKnown,
      costMissingRounds: rounds - costKnownRounds,
      fieldsNotReported: fields.filter((f) => !reportedRounds.get(f)),
      scopeNote: rounds === 0
        ? '该任务没有已记录的用量事件；这不代表零消耗——中断或未上报的用量（含子Agent与辅助调用）无法统计。'
        : '仅累计已记录的主循环回合用量（执行器在每回合结果时上报，每回合一条；不含子Agent与辅助调用）；中断或未上报的消耗不在内，不代表任务全部真实消耗。各类别完整性见 fieldCoverage（complete=false 表示合计为部分已知值）。',
    };
  }

  async appendToSubtask(taskId: string, message: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.store.getSession(taskId);
    if (!s) return { ok: false, error: '任务不存在' };
    if (s.kind !== 'sub') return { ok: false, error: '仅子任务支持侧边追加（主任务请直接在主对话发送）' };
    const r = await this.send(taskId, message);
    return { ok: r.ok, error: r.error };
  }

  cancelSubtask(taskId: string) { return this.cancel(taskId, { cascade: false }); }

  getTaskEvents(taskId: string, sinceSeq = 0) {
    return { ok: true, events: this.store.listEvents(taskId, sinceSeq).map(compactEvent) };
  }

  // ---- 合并（git 项目 worktree → 主树）----
  previewMerge(taskId: string): { ok: boolean; reason?: string; changedPaths: string[]; dirtyPaths: string[] } {
    const sub = this.store.getSession(taskId);
    if (!sub || sub.kind !== 'sub') return { ok: false, reason: '任务不存在或不是子任务', changedPaths: [], dirtyPaths: [] };
    const project = this.store.getProject(sub.projectId)!;
    if (!project.isGit) return { ok: true, changedPaths: [], dirtyPaths: [], reason: '非 git 项目：改动直接位于主树' };
    return worktreeMergeCheck(project.rootPath, taskId);
  }

  mergeSubtask(taskId: string): { ok: boolean; reason?: string; changedPaths: string[] } {
    const sub = this.store.getSession(taskId);
    if (!sub || sub.kind !== 'sub') return { ok: false, reason: '任务不存在或不是子任务', changedPaths: [] };
    const project = this.store.getProject(sub.projectId)!;
    if (!project.isGit) return { ok: false, reason: '非 git 项目无 worktree，可直接在主树查看改动', changedPaths: [] };
    const check = worktreeMergeCheck(project.rootPath, taskId);
    if (!check.ok) {
      const ev = this.store.appendEvent(sub.id, 'conflict', { kind: 'merge', detail: check.reason, paths: check.dirtyPaths });
      this.broadcast(ev);
      return { ok: false, reason: check.reason, changedPaths: check.changedPaths };
    }
    const r = worktreeApply(project.rootPath, taskId);
    if (r.ok) {
      const ev = this.store.appendEvent(sub.id, 'notice', { text: `已合并到主树: ${r.changedPaths.join(', ')}` });
      this.broadcast(ev);
    }
    return r;
  }

  cleanupWorktree(taskId: string): { ok: boolean } {
    const sub = this.store.getSession(taskId);
    if (!sub) return { ok: false };
    const project = this.store.getProject(sub.projectId)!;
    if (project.isGit) removeWorktree(project.rootPath, taskId);
    return { ok: true };
  }

  // MCP 工具工厂由 mcp/agentTools.ts 注入（避免循环依赖）
  mcpServerFactory: ((parentSessionId: string) => Promise<unknown>) | null = null;

  // ---- 启动恢复 ----
  restoreOnStartup(): string[] {
    const ids = this.store.markRunningAsResuming();
    for (const id of ids) {
      const ev = this.store.appendEvent(id, 'session', { status: 'resuming', reason: '应用重启，等待用户继续以恢复原生会话' });
      this.broadcast(ev);
    }
    return ids;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.waiter.close();
    const closing: Promise<unknown>[] = [];
    for (const [id, rt] of this.runtimes) {
      if (rt.idleTimer) clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
      this.retireRuntime(id);
      try { closing.push(rt.closing ?? rt.handle.close()); } catch { /* continue closing other adapters */ }
      this.clearTimer(id);          // 关键：清掉执行超时定时器，否则测试进程/应用退出被最长 taskTimeoutSec 的定时器拖住
    }
    this.runtimes.clear();
    // 拒绝所有未决授权，避免悬空 Promise
    for (const [pid, p] of this.pendingPermissions) {
      try { p.resolve({ behavior: 'deny', message: '服务已关闭' }); } catch { /* ignore */ }
      this.pendingPermissions.delete(pid);
    }
    this.shutdownPromise = Promise.allSettled(closing).then(() => {});
    return this.shutdownPromise;
  }

  // 泄漏测试：检索本地库（仅测试哨兵用）
  leakScan(needle: string) { return this.store.countOccurrences(needle); }
}

function isInsideDir(root: string, target: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export function compactEvent(e: WorkbenchEvent) {
  const payload = { ...e.payload };
  if (typeof payload.input === 'object' && payload.input) {
    const s = JSON.stringify(payload.input);
    if (s.length > 1200) payload.input = { truncated: true, originalChars: s.length, preview: s.slice(0, 1200) };
  }
  return { seq: e.seq, type: e.type, payload, createdAt: e.createdAt };
}
