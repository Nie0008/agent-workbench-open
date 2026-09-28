import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { AgentAdapter, AgentSessionHandle, AgentSessionOpts } from './types';


function launcherPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'app', 'scripts', 'agent-glm.py') : '',
    path.join(process.cwd(), 'scripts', 'agent-glm.py'),
    path.resolve(here, '..', '..', '..', 'scripts', 'agent-glm.py'),
    path.resolve(here, '..', '..', 'scripts', 'agent-glm.py'),
    path.resolve(here, '..', 'scripts', 'agent-glm.py')];
  const found = candidates.find((item) => fs.existsSync(item));
  if (!found) throw new Error('DSH 模型启动器未随 Workbench 安装');
  return found;
}

export class DshSession implements AgentSessionHandle {
  private nativeId: string | null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private runDir: string | null = null;
  private eventFile: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readOffset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private assistantText = '';
  private reportedModel = false;
  private toolCalls = new Map<string, { name: string; input: unknown }>();
  private pendingReplies = new Set<string>();
  private stopped = false;
  private disposed = false;
  private turnFinished = false;
  private stderrTail = '';
  private stdout = '';
  private closePromise: Promise<void> | null = null;
  private processDone: Promise<void> = Promise.resolve();

  constructor(private opts: AgentSessionOpts,
              private launcher: string = launcherPath(),
              private python: string = '/usr/bin/python3') {
    this.nativeId = opts.resumeNativeSessionId ?? null;
  }

  nativeSessionId() { return this.nativeId; }

  async send(text: string): Promise<void> {
    if (this.disposed) throw new Error('DSH runtime 已关闭');
    if (this.child) throw new Error('DSH 当前回合尚未结束');
    if (!this.opts.model) throw new Error('DSH 任务未绑定模型');
    if (!this.opts.providerId) throw new Error('DSH 任务未绑定 CC Switch 供应商');
    this.turnFinished = false;
    this.stopped = false;
    this.reportedModel = false;
    this.assistantText = '';
    this.stderrTail = '';
    this.stdout = '';
    this.readOffset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.toolCalls.clear();
    this.pendingReplies.clear();

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dsh-turn-'));
    fs.chmodSync(runDir, 0o700);
    this.runDir = runDir;
    const promptFile = path.join(runDir, 'prompt.txt');
    this.eventFile = path.join(runDir, 'events.jsonl');
    const controlDir = path.join(runDir, 'control');
    fs.mkdirSync(controlDir, { mode: 0o700 });
    fs.writeFileSync(promptFile, text, { mode: 0o600 });

    const args = [this.launcher, 'dsh', 'run', '--cwd', this.opts.cwd,
      '--prompt-file', promptFile, '--provider-id', this.opts.providerId, '--model', this.opts.model,
      '--timeout', '14400', '--workbench-task-id', this.opts.taskId ?? path.basename(runDir),
      '--workbench-event-file', this.eventFile, '--workbench-control-dir', controlDir];
    if (this.nativeId) args.push('--resume', this.nativeId);
    const env = this.opts.providerId.startsWith('workbench-local:')
      ? { ...this.opts.env } : { ...process.env } as NodeJS.ProcessEnv;
    // CC Switch stays in its own DB; Workbench-owned secrets reach only this child env.
    const child = spawn(this.python, args, { cwd: this.opts.cwd, env, detached: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { this.stdout += chunk; if (this.stdout.length > 4_000_000) this.stdout = this.stdout.slice(-4_000_000); });
    child.stderr.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    this.pollTimer = setInterval(() => this.pollEvents(controlDir), 80);
    this.processDone = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.pollEvents(controlDir);
        this.child = null;
        if (!this.stopped && !this.disposed) this.finishTurn(code, error);
        if (this.runDir) fs.rmSync(this.runDir, { recursive: true, force: true });
        this.runDir = null;
        resolve();
      };
      child.once('error', (error) => finish(null, error));
      child.once('close', (code) => finish(code));
    });
  }

  private pollEvents(controlDir: string) {
    if (!this.eventFile || !fs.existsSync(this.eventFile)) return;
    try {
      const fd = fs.openSync(this.eventFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        while (this.readOffset < size) {
          const bytes = Math.min(size - this.readOffset, 65536);
          const buf = Buffer.allocUnsafe(bytes);
          const read = fs.readSync(fd, buf, 0, bytes, this.readOffset);
          if (!read) break;
          this.readOffset += read;
          const lines = (this.partial + this.decoder.write(buf.subarray(0, read))).split('\n');
          this.partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            try { this.handleEvent(JSON.parse(line), controlDir); }
            catch (error) { this.opts.onEvent({ kind: 'error', message: `DSH 事件解析失败: ${String(error)}` }); }
          }
        }
      } finally { fs.closeSync(fd); }
    } catch (error) { this.opts.onEvent({ kind: 'error', message: `DSH 事件读取失败: ${String(error)}` }); }
  }

  private handleEvent(event: any, controlDir: string) {
    if (event.type === 'session_opened' && typeof event.sessionId === 'string') {
      this.nativeId = event.sessionId;
      this.opts.onEvent({ kind: 'system', nativeSessionId: this.nativeId ?? undefined, model: this.opts.model });
      return;
    }
    if (event.type === 'permission_request') {
      const requestId = String(event.requestId ?? '');
      if (!/^[a-f0-9]{32}$/.test(requestId) || this.pendingReplies.has(requestId)) return;
      this.pendingReplies.add(requestId);
      const callId = String(event.request?.toolCall?.toolCallId ?? '');
      const call = this.toolCalls.get(callId);
      const name = call?.name ?? 'DSH 工具操作';
      const input = call?.input ?? { toolCallId: callId, details: event.request };
      void (this.opts.canUseTool?.(name, input) ?? Promise.resolve({ behavior: 'deny' as const }))
        .then((decision) => {
          if (!this.runDir || !this.child || this.stopped) return;
          const dest = path.join(controlDir, requestId + '.json');
          const temp = dest + '.tmp';
          fs.writeFileSync(temp, JSON.stringify({ decision: decision.behavior === 'allow' ? 'allow' : 'deny' }), { mode: 0o600 });
          fs.renameSync(temp, dest);
        }).catch((error) => {
          this.opts.onEvent({ kind: 'error', message: `DSH 授权处理失败: ${String(error)}` });
          if (!this.runDir || !this.child) return;
          const dest = path.join(controlDir, requestId + '.json');
          fs.writeFileSync(dest, JSON.stringify({ decision: 'deny' }), { mode: 0o600 });
        });
      return;
    }
    if (event.method !== 'session/update') return;
    const update = event.params?.update ?? {};
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
      const text = String(update.content.text ?? '');
      this.assistantText += text;
      if (text) this.opts.onEvent({ kind: 'text_delta', text });
    } else if (kind === 'tool_call') {
      const id = String(update.toolCallId ?? '');
      const name = String(update.title ?? update.kind ?? 'DSH 工具操作');
      const input = update.rawInput ?? { title: update.title, kind: update.kind, toolCallId: id };
      this.toolCalls.set(id, { name, input });
      this.opts.onEvent({ kind: 'tool_use', toolUseId: id, name, input });
    } else if (kind === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
      const id = String(update.toolCallId ?? '');
      const call = this.toolCalls.get(id);
      this.opts.onEvent({ kind: 'tool_result', toolUseId: id, name: call?.name,
        content: typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput ?? ''),
        isError: update.status === 'failed' });
      this.toolCalls.delete(id);
    }
  }

  private finishTurn(code: number | null, error?: Error) {
    if (this.turnFinished) return;
    this.turnFinished = true;
    let report: any;
    try { report = JSON.parse(this.stdout.trim()); } catch { /* reported below */ }
    const exactModel = report?.model === this.opts.model && Array.isArray(report?.requests) &&
      report.requests.length > 0 && report.requests.every((r: any) => r.model === this.opts.model && r.status === 200);
    const ok = code === 0 && report?.success === true && report?.session?.success === true && exactModel;
    if (report?.session?.sessionId && !this.nativeId) {
      this.nativeId = String(report.session.sessionId);
      this.opts.onEvent({ kind: 'system', nativeSessionId: this.nativeId, model: this.opts.model });
    }
    const text = String(report?.session?.text ?? this.assistantText);
    if (text) this.opts.onEvent({ kind: 'assistant_message', text });
    if (!ok) {
      const reason = String(report?.session?.error ?? report?.error ?? error?.message ?? (this.stderrTail || 'DSH 回合失败')).slice(0, 900);
      this.opts.onEvent({ kind: 'error', message: reason });
    }
    this.opts.onEvent({ kind: 'result', isError: !ok, numTurns: ok ? 1 : 0, text: ok ? text : (text || 'DSH 回合失败') });
    this.opts.onEnd(ok ? 'done' : 'error', ok ? undefined : 'DSH 回合失败');
  }

  async interrupt(): Promise<void> {
    this.stopped = true;
    if (this.child?.pid) {
      try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* already exited */ }
      await Promise.race([this.processDone, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
      if (this.child?.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* exited */ } }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.disposed = true;
    this.closePromise = this.interrupt().then(() => this.processDone);
    return this.closePromise;
  }
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DSH';
  start(opts: AgentSessionOpts): AgentSessionHandle { return new DshSession(opts); }
}
