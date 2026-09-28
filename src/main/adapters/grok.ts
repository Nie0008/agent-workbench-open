import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentSessionHandle, AgentSessionOpts } from './types';
import { GROK_SUPER_PROVIDER_ID, isGrokConfigProviderId, grokConfigModelFromId } from '../grok-models';

const MAX_LINE_CHARS = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 2500;

export interface GrokAdapterDeps {
  scriptPath?: string;
  grokPath?: string;
  workbenchMcpEntry?: string;
  nodePath?: string;
  pythonPath?: string;
  spawn?: typeof spawn;
  tempRoot?: string;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

type RpcId = number | string;
interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}
interface PendingPermission {
  id: RpcId;
  toolCallId: string;
  name: string;
  input: any;
  settled: boolean;
}

export function resolveGrokEntry(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env.WORKBENCH_GROK_ENTRY,
    path.resolve(process.cwd(), 'scripts/grok-glm.py'),
    resourcesPath ? path.join(resourcesPath, 'app', 'scripts', 'grok-glm.py') : undefined,
    resourcesPath ? path.join(resourcesPath, 'app.asar', 'scripts', 'grok-glm.py') : undefined,
  ].filter((v): v is string => !!v);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  throw new Error('找不到固定 Grok GLM 启动入口 scripts/grok-glm.py');
}

function resolveWorkbenchMcpEntry(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'dist/main/mcp/entry.js'),
    path.resolve(moduleDir, '../mcp/entry.js'),
    resourcesPath ? path.join(resourcesPath, 'app', 'dist/main/mcp/entry.js') : undefined,
    resourcesPath ? path.join(resourcesPath, 'app.asar', 'dist/main/mcp/entry.js') : undefined,
  ].filter((v): v is string => !!v);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  throw new Error('找不到 Workbench MCP stdio 入口 dist/main/mcp/entry.js');
}

function resolveNodeExecutable(): string {
  const configured = process.env.WORKBENCH_NODE_PATH;
  if (configured) {
    try { if (fs.statSync(configured).isFile()) return configured; } catch { /* try PATH */ }
  }
  try {
    const node = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
    if (node) return node;
  } catch { /* Electron can run as Node with the child env flag */ }
  return process.execPath;
}

function bounded(value: unknown, max: number): string {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)} [truncated]` : s;
}

function redact(value: unknown, env: Record<string, string>): string {
  let message = bounded(value, 1200);
  for (const [key, secret] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && secret && secret.length >= 4) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/\b(?:xai|sk-ant|glm)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

function toolName(toolCall: any): string {
  const explicit = toolCall?._meta?.toolName ?? toolCall?.name;
  if (typeof explicit === 'string' && explicit) return explicit;
  switch (toolCall?.kind) {
    case 'read': return 'Read';
    case 'edit': return 'Edit';
    case 'delete': return 'Edit';
    case 'search': return 'Grep';
    case 'execute': return 'Bash';
    default: return String(toolCall?.title ?? 'AgentTool');
  }
}

function toolInput(toolCall: any): any {
  return toolCall?.rawInput ?? toolCall?.input ?? {};
}

function resultText(content: any): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map((item) => item?.content?.text ?? item?.text ?? '').filter(Boolean).join('\n');
}

export class GrokSession implements AgentSessionHandle {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private nativeId: string | null;
  private disposed = false;
  private ended = true;
  private stopping = false;
  private processPromise: Promise<void> | null = null;
  private sessionPromise: Promise<void> | null = null;
  private runPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private permissions = new Map<RpcId, PendingPermission>();
  private recentTools = new Map<string, { name: string; input: any }>();
  private assistantText = '';
  private suppressUpdates = false;
  private fatalProtocolError: string | null = null;
  private delegationServers: any[] | null = null;
  private readonly deps: Required<GrokAdapterDeps>;

  constructor(private readonly opts: AgentSessionOpts, deps: GrokAdapterDeps = {}) {
    this.nativeId = opts.resumeNativeSessionId ?? null;
    this.deps = {
      scriptPath: deps.scriptPath ?? (opts.providerId === GROK_SUPER_PROVIDER_ID
        || isGrokConfigProviderId(opts.providerId ?? '') ? '' : resolveGrokEntry()),
      grokPath: deps.grokPath ?? path.join(os.homedir(), '.grok', 'bin', 'grok'),
      workbenchMcpEntry: deps.workbenchMcpEntry ?? '',
      nodePath: deps.nodePath ?? '',
      pythonPath: deps.pythonPath ?? process.env.WORKBENCH_PYTHON ?? 'python3',
      spawn: deps.spawn ?? spawn,
      tempRoot: deps.tempRoot ?? os.tmpdir(),
      signalProcess: deps.signalProcess ?? ((pid, signal) => {
        if (process.platform !== 'win32') process.kill(-pid, signal);
        else process.kill(pid, signal);
      }),
    };
  }

  nativeSessionId() { return this.nativeId; }

  async send(text: string): Promise<void> {
    if (this.disposed) throw new Error('Grok runtime 已关闭；需由任务服务创建新的恢复会话');
    if (!this.ended) throw new Error('Grok 会话仍在运行');
    if (this.runPromise) await this.runPromise;
    if (this.disposed) throw new Error('Grok runtime 已关闭；需由任务服务创建新的恢复会话');
    this.ended = false;
    this.stopping = false;
    this.assistantText = '';
    this.fatalProtocolError = null;
    this.runPromise = this.runPrompt(text);
    await Promise.resolve();
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = (async () => {
      await this.ensureProcess();
      const init = await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      if (init?.protocolVersion !== 1) throw new Error('Grok ACP 不支持协商的协议版本 1');
      this.notify('initialized', {});

      this.suppressUpdates = true;
      try {
        const capabilities = init.agentCapabilities ?? {};
        const isNew = !this.nativeId;
        let method = 'session/new';
        if (!isNew) {
          if (capabilities.loadSession === true) method = 'session/load';
          else if (capabilities.sessionCapabilities?.resume) method = 'session/resume';
          else throw new Error('Grok ACP 未声明原生会话恢复能力');
        }
        const session = await this.request(method, {
          ...(this.nativeId ? { sessionId: this.nativeId } : {}),
          cwd: this.opts.cwd,
          mcpServers: this.mcpServers(),
          ...(!this.nativeId && this.opts.systemPromptAppend ? { _meta: { rules: this.opts.systemPromptAppend } } : {}),
        });
        if (isNew) {
          if (!session?.sessionId || typeof session.sessionId !== 'string') throw new Error('Grok ACP 未返回有效原生会话 ID');
          this.nativeId = session.sessionId;
        }
        let configOptions = session.configOptions;
        const isNative = this.opts.providerId === GROK_SUPER_PROVIDER_ID
          || grokConfigModelFromId(this.opts.providerId ?? '') === this.opts.model;
        if (isNew && isNative && this.reportedModel(configOptions) !== this.opts.model) {
          // Grok Build currently reports the user default from session/new even
          // when --model was passed. Set and verify before the first prompt.
          const changed = await this.request('session/set_config_option', {
            sessionId: this.nativeId, configId: 'model', value: this.opts.model,
          });
          configOptions = changed?.configOptions;
        }
        this.assertModel(configOptions, true);
        this.opts.onEvent({ kind: 'system', nativeSessionId: this.nativeId!, model: this.opts.model });
      } finally { this.suppressUpdates = false; }
    })().catch((error) => {
      this.sessionPromise = null;
      throw error;
    });
    return this.sessionPromise;
  }

  private mcpServers(): any[] {
    if (!this.opts.allowDelegation) return [];
    if (!this.opts.taskId) throw new Error('Workbench 委派会话缺少 taskId');
    if (this.delegationServers) return this.delegationServers;
    const entry = this.deps.workbenchMcpEntry || resolveWorkbenchMcpEntry();
    const node = this.deps.nodePath || resolveNodeExecutable();
    const env = [{
      name: 'WORKBENCH_DATA_DIR',
      value: this.opts.env.WORKBENCH_DATA_DIR
        ?? path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Agent Workbench'),
    }];
    if (node === process.execPath && /electron/i.test(path.basename(node))) {
      env.push({ name: 'ELECTRON_RUN_AS_NODE', value: '1' });
    }
    this.delegationServers = [{
      name: 'workbench',
      command: node,
      args: [entry, '--parent-task-id', this.opts.taskId],
      env,
    }];
    return this.delegationServers;
  }

  private async ensureProcess(): Promise<void> {
    if (this.processPromise) return this.processPromise;
    this.processPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        const isNative = this.opts.providerId === GROK_SUPER_PROVIDER_ID
          || grokConfigModelFromId(this.opts.providerId ?? '') === this.opts.model;
        if (!isNative && (!this.opts.model || !this.opts.providerId))
          throw new Error('Grok 任务缺少有效的模型与供应商绑定');
        const args = isNative
          ? ['agent', '--no-leader', '--model', this.opts.model, 'stdio']
          : [this.deps.scriptPath, 'acp', '--cwd', this.opts.cwd, '--provider-id', this.opts.providerId!, '--model', this.opts.model];
        if (!isNative && this.opts.taskId) args.push('--workbench-task-id', this.opts.taskId);
        child = this.deps.spawn(isNative ? this.deps.grokPath : this.deps.pythonPath, args, {
          cwd: this.opts.cwd,
          env: this.opts.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (e: any) { reject(e); return; }
      this.proc = child;
      let ready = false;
      const onReady = () => { if (!ready) { ready = true; resolve(); } };
      const onError = (error: Error) => {
        if (!ready) reject(error);
        else this.fail(error);
      };
      child.once('spawn', onReady);
      child.once('error', onError);
      child.stderr?.on('data', () => { /* stderr may contain credential-bearing diagnostics; never retain it */ });
      child.stdout?.on('error', onError);
      if (child.stdout) {
        this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.rl.on('line', (line) => {
          if (line.length > MAX_LINE_CHARS) {
            this.fatalProtocolError = 'Grok ACP 输出超过单行大小上限';
            this.signal('SIGTERM');
            return;
          }
          this.receive(line);
        });
      }
      child.once('close', (code, signal) => {
        if (!ready) reject(new Error('Grok ACP 子进程未启动'));
        const err = new Error(`Grok ACP 子进程退出 (${code ?? signal ?? 'unknown'})`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(err);
        }
        this.pending.clear();
        if (!this.ended && !this.stopping && !this.disposed) this.fail(this.fatalProtocolError ?? err);
        this.proc = null;
        this.rl?.close();
        this.rl = null;
        this.processPromise = null;
        this.sessionPromise = null;
      });
    });
    return this.processPromise;
  }

  private request(method: string, params: any, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<any> {
    const proc = this.proc;
    if (!proc?.stdin || proc.stdin.destroyed) return Promise.reject(new Error('Grok ACP stdin 不可用'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP ${method} 请求超时`));
      }, timeoutMs);
      timer?.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      proc.stdin!.write(`${line}\n`, (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        reject(error);
      });
    });
  }

  private notify(method: string, params: any) {
    const proc = this.proc;
    if (!proc?.stdin || proc.stdin.destroyed) return;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private receive(line: string) {
    if (!line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); }
    catch {
      this.fatalProtocolError = 'Grok ACP 返回无效 JSON-RPC 消息';
      this.signal('SIGTERM');
      return;
    }
    if (message?.method === 'session/update') {
      if (!this.suppressUpdates) this.dispatchUpdate(message.params?.update);
      return;
    }
    if (message?.method === 'session/request_permission' && message.id !== undefined) {
      void this.handlePermission(message);
      return;
    }
    if (message?.id !== undefined && message?.method) {
      this.respond(message.id, { error: { code: -32601, message: 'Unsupported ACP client request' } });
      return;
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(redact(message.error.message ?? message.error, this.opts.env)));
      else pending.resolve(message.result ?? {});
    }
  }

  private respond(id: RpcId, body: { result?: any; error?: any }) {
    const proc = this.proc;
    if (!proc?.stdin || proc.stdin.destroyed) return;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  }

  private async handlePermission(message: any) {
    const id = message.id as RpcId;
    const params = message.params ?? {};
    const call = params.toolCall ?? {};
    const toolCallId = String(call.toolCallId ?? `grok-${String(id)}`);
    const name = toolName(call);
    const input = toolInput(call);
    this.announceTool(toolCallId, name, input);
    const pending: PendingPermission = { id, toolCallId, name, input, settled: false };
    this.permissions.set(id, pending);
    try {
      const decision = this.stopping || !this.opts.canUseTool
        ? { behavior: 'deny' as const }
        : await this.opts.canUseTool(name, input);
      if (pending.settled || !this.permissions.has(id)) return;
      const wanted = decision.behavior === 'allow' ? 'allow_once' : 'reject_once';
      const option = (params.options ?? []).find((item: any) => item.kind === wanted);
      if (option?.optionId) {
        pending.settled = true;
        this.permissions.delete(id);
        this.respond(id, { result: { outcome: { outcome: 'selected', optionId: option.optionId } } });
      } else {
        pending.settled = true;
        this.permissions.delete(id);
        this.respond(id, { result: { outcome: { outcome: 'cancelled' } } });
      }
    } catch {
      if (pending.settled || !this.permissions.has(id)) return;
      pending.settled = true;
      this.permissions.delete(id);
      this.respond(id, { result: { outcome: { outcome: 'cancelled' } } });
    }
  }

  private dispatchUpdate(update: any) {
    if (!update || typeof update.sessionUpdate !== 'string') return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.text;
        if (typeof text === 'string' && text) {
          this.assistantText = bounded(this.assistantText + text, 100_000);
          this.opts.onEvent({ kind: 'text_delta', text });
        }
        break;
      }
      case 'agent_thought_chunk':
        // Keep private reasoning out of the durable Workbench transcript.
        if (typeof update.content?.text === 'string' && update.content.text)
          this.opts.onEvent({ kind: 'activity' });
        break;
      case 'tool_call': {
        const call = update;
        this.announceTool(String(call.toolCallId ?? ''), toolName(call), toolInput(call));
        break;
      }
      case 'tool_call_update': {
        const id = String(update.toolCallId ?? '');
        const status = String(update.status ?? '');
        if (['completed', 'failed', 'cancelled'].includes(status)) {
          const tool = this.recentTools.get(id);
          this.opts.onEvent({ kind: 'tool_result', toolUseId: id, name: tool?.name, isError: status !== 'completed', content: resultText(update.content) });
        } else if (id && (status === 'in_progress' || update.rawOutput !== undefined || update.content?.length)) {
          this.opts.onEvent({ kind: 'activity' });
        }
        break;
      }
      case 'config_option_update':
        this.assertModel(update.configOptions, false);
        break;
      default:
        break;
    }
  }

  private announceTool(id: string, name: string, input: any) {
    if (!id || this.recentTools.has(id)) return;
    this.recentTools.set(id, { name, input });
    this.opts.onEvent({ kind: 'tool_use', toolUseId: id, name, input });
  }

  private reportedModel(configOptions: any): string | null {
    if (!Array.isArray(configOptions)) return null;
    const selected = configOptions.find((item) => item?.id === 'model' || item?.configId === 'model');
    return selected?.currentValue ?? selected?.value?.value ?? null;
  }

  private assertModel(configOptions: any, required: boolean): boolean {
    if (!Array.isArray(configOptions)) {
      if (required) throw new Error('Grok ACP 未返回模型配置，无法核验所选模型');
      return false;
    }
    const selected = this.reportedModel(configOptions);
    if (selected !== this.opts.model) {
      const message = `Grok ACP 模型配置未核验为所选模型 ${this.opts.model} (${String(selected ?? 'unknown')})`;
      this.fatalProtocolError = message;
      this.opts.onEvent({ kind: 'error', message });
      if (required) throw new Error(message);
      this.signal('SIGTERM');
      return false;
    }
    return true;
  }

  private async runPrompt(text: string): Promise<void> {
    try {
      await this.ensureSession();
      if (this.disposed) return this.finish('interrupted');
      const response = await this.request('session/prompt', {
        sessionId: this.nativeId,
        prompt: [{ type: 'text', text }],
      }, null); // TaskService owns inactivity timeout and pauses it for user permission.
      if (this.stopping || response.stopReason === 'cancelled') {
        this.finish('interrupted');
        return;
      }
      if (this.fatalProtocolError) throw new Error(this.fatalProtocolError);
      const isError = !['end_turn', 'max_tokens', 'refusal'].includes(String(response.stopReason ?? 'end_turn'));
      // ACP does not expose a reliable per-prompt turn count or headless modelUsage.
      this.opts.onEvent({ kind: 'result', isError, numTurns: 1, text: this.assistantText });
      this.finish('done');
    } catch (e: any) {
      if (this.stopping || this.disposed) this.finish('interrupted');
      else this.fail(e);
    } finally {
      this.runPromise = null;
    }
  }

  private fail(error: unknown) {
    if (this.ended) return;
    const message = redact((error as any)?.message ?? error, this.opts.env);
    this.opts.onEvent({ kind: 'error', message: `Grok ACP 会话异常: ${message}` });
    this.finish('error', message);
  }

  private finish(reason: 'done' | 'interrupted' | 'error', error?: string) {
    if (this.ended) return;
    this.ended = true;
    this.opts.onEnd(reason, error);
  }

  private signal(signal: NodeJS.Signals) {
    const child = this.proc;
    if (!child?.pid) return;
    try { this.deps.signalProcess(child.pid, signal); } catch { /* already exited */ }
  }

  async interrupt(): Promise<void> {
    if (this.ended) return;
    this.stopping = true;
    for (const permission of this.permissions.values()) {
      permission.settled = true;
      this.respond(permission.id, { result: { outcome: { outcome: 'cancelled' } } });
    }
    this.permissions.clear();
    if (this.nativeId) this.notify('session/cancel', { sessionId: this.nativeId });
    await this.waitForStop();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.disposed) return Promise.reject(new Error('Grok runtime 已关闭'));
    this.disposed = true;
    this.stopping = true;
    this.closePromise = (async () => {
      for (const permission of this.permissions.values()) {
        permission.settled = true;
        this.respond(permission.id, { result: { outcome: { outcome: 'cancelled' } } });
      }
      this.permissions.clear();
      if (this.nativeId && this.proc?.stdin && !this.proc.stdin.destroyed) {
        this.notify('session/cancel', { sessionId: this.nativeId });
      }
      this.signal('SIGTERM');
      await this.waitForStop();
      if (this.proc) this.signal('SIGKILL');
    })();
    return this.closePromise;
  }

  private async waitForStop() {
    const prompt = this.runPromise;
    if (!prompt) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const exited = await Promise.race([prompt.then(() => true), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
        timer.unref();
      })]);
      if (exited) return;
      this.signal('SIGKILL');
      await Promise.race([prompt, new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Grok ACP close timed out after SIGKILL')),
          STOP_GRACE_MS);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok';
  readonly displayName = 'Grok Build';
  constructor(private readonly deps: GrokAdapterDeps = {}) {}
  start(opts: AgentSessionOpts): AgentSessionHandle {
    return new GrokSession(opts, this.deps);
  }
}
