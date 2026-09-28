// 回环控制服务：外部 stdio MCP 入口进程经此 HTTP(127.0.0.1) 访问同一 TaskService。
// 仅绑定本机回环地址，Bearer 随机令牌写入数据目录（0600）。
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { TaskService } from './taskService';
import type { NightlyMemoryService } from './nightlyMemory';

export interface ControlServerInfo { port: number; token: string; }

export class ControlServer {
  private server: http.Server;
  private token = crypto.randomUUID().replace(/-/g, '');
  private port = 0;
  captureFn: (() => Promise<string>) | null = null;   // 返回 PNG base64
  evalFn: ((expr: string) => Promise<string>) | null = null;  // 仅调试
  desktopFn: ((action?: 'show' | 'hide') => Promise<unknown>) | null = null;

  constructor(private taskService: TaskService, private nightly?: NightlyMemoryService | null) {
    this.server = http.createServer((req, res) => this.route(req, res));
  }

  async start(controlFile: string): Promise<ControlServerInfo> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        resolve();
      });
    });
    fs.mkdirSync(path.dirname(controlFile), { recursive: true });
    fs.writeFileSync(controlFile, JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), { mode: 0o600 });
    return { port: this.port, token: this.token };
  }

  stop() {
    try {
      (this.server as any).closeAllConnections?.();   // 立即断开 keep-alive 连接，不拖住退出
      this.server.close();
    } catch { /* ignore */ }
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(401).end('unauthorized'); return; }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    req.on('end', async () => {
      let out: any;
      try {
        const { method, params } = JSON.parse(body);
        out = await this.handle(method, params ?? {}, abort.signal);
      } catch (e: any) {
        out = { ok: false, error: String(e?.message ?? e) };
      }
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  }

  private async handle(method: string, p: any, signal?: AbortSignal): Promise<any> {
    const ts = this.taskService;
    switch (method) {
      case 'app.window': {
        if (!this.desktopFn) return { ok: false, error: '桌面窗口不可用' };
        if (p.action !== undefined && p.action !== 'show' && p.action !== 'hide')
          return { ok: false, error: '未知窗口操作' };
        return { ok: true, desktop: await this.desktopFn(p.action) };
      }
      case 'app.capture': {
        if (!this.captureFn) return { ok: false, error: '截图能力不可用' };
        const png = await this.captureFn();
        return { ok: true, pngBase64: png };
      }
      case 'app.eval': {
        // 仅调试（WORKBENCH_DEBUG=1）开放：在 renderer 中执行诊断表达式
        if (!process.env.WORKBENCH_DEBUG) return { ok: false, error: '未开启调试' };
        if (!this.evalFn) return { ok: false, error: '不可用' };
        return { ok: true, value: await this.evalFn(String(p.expr ?? '')) };
      }
      case 'app.info':
        return { ok: true, version: ts.store.getKV('appVersion'), provider: ts.credentials.listProviderInfos() };
      case 'memory.nightly.status':
        return { ok:true, status:this.nightly?.status() ?? null };
      case 'agents.options': {
        return { ok: true, ...ts.agentOptions(p.refreshModels === true) };
      }
      case 'projects.list':
        return { ok: true, projects: ts.listProjects() };
      case 'projects.create': {
        const proj = ts.createProject(p.rootPath, p.name);
        return { ok: true, project: proj };
      }
      case 'tasks.list':
        return { ok: true, tasks: p.projectId ? ts.listSessions(p.projectId) : ts.listProjects().flatMap((pr) => ts.listSessions(pr.id)) };
      case 'task.get': {
        const s = ts.getSession(p.taskId);
        return s ? { ok: true, task: s } : { ok: false, error: '任务不存在' };
      }
      case 'tasks.wait': return ts.waitTaskEvents(p.targets, p.timeoutMs, signal);
      case 'tasks.progress': return ts.progress(p.projectId);
      case 'project.memory.get': return {ok:true,memory:ts.projectMemory(p.projectId)};
      case 'project.memory.set': return {ok:true,memory:ts.updateMemory(p.projectId,p.facts,p.expectedVersion,p.source)};
      case 'project.memory.entries.list': return {ok:true,entries:ts.listMemoryEntries(p.projectId,p.filters ?? {status:p.status,kind:p.kind})};
      case 'project.memory.entries.search': return {ok:true,matches:ts.searchMemory(p.projectId,String(p.query ?? ''),p.options ?? {statuses:p.statuses,kind:p.kind,limit:p.limit})};
      case 'project.memory.entries.get': return {ok:true,entry:ts.getMemoryEntry(p.projectId,p.id)};
      case 'project.memory.entries.history': return {ok:true,history:ts.getMemoryHistory(p.projectId,p.id)};
      case 'project.memory.entries.create': return {ok:true,...ts.createMemoryEntry(p)};
      case 'project.memory.entries.update': return {ok:true,entry:ts.updateMemoryEntry(p.projectId,p.id,p.patch ?? {},p.expectedVersion)};
      case 'project.memory.entries.status': return {ok:true,entry:ts.setMemoryStatus(p.projectId,p.id,p.status,p.expectedVersion)};
      case 'project.memory.entries.replace': return {ok:true,...ts.replaceMemoryEntry(p.projectId,p.id,p.expectedVersion,p.entry ?? {})};
      case 'project.memory.handoff.create': return {ok:true,...ts.createHandoffDraft(p.taskId)};
      case 'task.background': return {ok:true,background:JSON.parse(ts.store.getKV(`background:${p.taskId}`)??'null')};
      case 'task.memory.used': return {ok:true,injection:ts.taskMemoryUsed(p.taskId)};
      case 'task.events':
        return ts.getTaskEvents(p.taskId, p.sinceSeq ?? 0);
      case 'task.send': {
        const r = await ts.send(p.taskId, String(p.message ?? ''), p.clientMsgId);
        return r;
      }
      case 'task.create': {
        const s = ts.createMainSession({
          projectId: p.projectId, title: p.title ?? '外部任务', prompt: p.prompt, scope: { fileWrite: p.fileWrite === true },
          background:p.background, clientRequestId:p.clientRequestId,
          agentId: p.agentId ?? 'claude-code', model: p.model, providerId: p.providerId, mockScript: p.mockScript,
        });
        return { ok: true, task: s };
      }
      case 'task.cancel': {
        const r = ts.cancel(p.taskId, { cascade: true });
        return r;
      }
      case 'task.result':
        return ts.readTaskResult(p.taskId);
      case 'task.merge':
        return ts.mergeSubtask(p.taskId);
      case 'subtasks.list':
        return { ok: true, tasks: ts.listSubtasks(p.taskId) };
      // ACP/stdio Agent 的受限子任务桥：每次操作都核对父子关系。
      case 'agent.delegate':
        if (typeof p.parentTaskId !== 'string' || !p.parentTaskId) return { ok: false, error: '缺少主任务 ID' };
        if (!String(p.title ?? '').trim() || !String(p.instructions ?? '').trim()) return { ok: false, error: '子任务标题和要求不能为空' };
        if (String(p.title).length > 200 || String(p.instructions).length > 20000) return { ok: false, error: '子任务内容过长' };
        return ts.delegate(p.parentTaskId, {
          title: String(p.title ?? ''), instructions: String(p.instructions ?? ''),
          context_files: Array.isArray(p.context_files) ? p.context_files : [],
          acceptance: typeof p.acceptance === 'string' ? p.acceptance : undefined,
        });
      case 'agent.subtasks.list': {
        const parent = ts.getSession(p.parentTaskId);
        return parent?.kind === 'main' ? { ok: true, tasks: ts.listSubtasks(parent.id) } : { ok: false, error: '主任务不存在' };
      }
      case 'agent.subtask.result':
      case 'agent.subtask.events':
      case 'agent.subtask.append':
      case 'agent.subtask.cancel': {
        const child = ts.getSession(p.taskId);
        if (!child || child.parentSessionId !== p.parentTaskId) return { ok: false, error: '只能操作本主任务的子任务' };
        if (method === 'agent.subtask.result') return ts.readTaskResult(child.id);
        if (method === 'agent.subtask.events') return ts.getTaskEvents(child.id, p.sinceSeq ?? 0);
        if (method === 'agent.subtask.append') return ts.send(child.id, String(p.message ?? ''), p.clientMsgId);
        return ts.cancelSubtask(child.id);
      }
      case 'permissions.list': return ts.listPendingPermissions(p.taskId);
      case 'permissions.respondTask':
        if (typeof p.taskId !== 'string' || !p.taskId) return {ok:false,error:'必须指定任务'};
        return ts.respondPermission(p.permissionId, p.decision, p.taskId);
      case 'permissions.respond':
        return ts.respondPermission(p.permissionId, p.decision);
      case 'settings.get':
        return { ok: true, settings: ts.getSettings() };
      case 'settings.set':
        return { ok: true, settings: ts.setSettings(p) };
      default:
        return { ok: false, error: `未知方法: ${method}` };
    }
  }
}
