// Claude Code 适配器：经官方 Agent SDK 驱动本机已安装的 claude 可执行文件。
// 流式输入多轮会话；授权经 canUseTool 上抛；凭据仅存在于子进程 env。
// 注意：SDK 必须懒加载——其模块初始化会做相对 cwd 的目录扫描，launchd 启动（cwd=/）时会扫穿文件系统。
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAdapter, AgentSessionHandle, AgentSessionOpts } from './types';
import { resolveClaudeExecutable } from './types';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { workbenchDataDir } from '../paths';

let sdkPromise: Promise<{ query: typeof import('@anthropic-ai/claude-agent-sdk')['query'] }> | null = null;
async function ensureSdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk').then((m) => ({ query: m.query }));
  return sdkPromise;
}

import * as fsDbg from 'node:fs';

const dbgLog = (msg: string) => {
  if (process.env.WORKBENCH_DEBUG) {
    try { fsDbg.appendFileSync('/tmp/wb-adapter-debug.log', `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
  }
};

const USER_MESSAGE_TYPE = 'user' as const;

export function skillSessionEnv(env: Record<string, string>): Record<string, string> {
  const source = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const config = path.join(workbenchDataDir(env), 'claude', createHash('sha256').update(source).digest('hex').slice(0, 16));
  fsDbg.mkdirSync(config, { recursive: true, mode: 0o700 });
  // 只挂载 Skill 与原生会话；不引入全局 hooks、模型设置或 MCP。
  for (const name of ['skills', 'projects']) {
    const target = path.join(config, name), original = path.join(source, name);
    const entry = fsDbg.lstatSync(target, { throwIfNoEntry: false });
    if (!entry) fsDbg.symlinkSync(original, target, process.platform === 'win32' ? 'junction' : 'dir');
    else if (!entry.isSymbolicLink() || path.resolve(config, fsDbg.readlinkSync(target)) !== original)
      throw new Error(`Claude 隔离目录冲突，未覆盖现有路径: ${target}`);
  }
  return { ...env, CLAUDE_CONFIG_DIR: config };
}

export class ClaudeCodeSession implements AgentSessionHandle {
  private q: Query | null = null;
  private abort = new AbortController();
  private pending: Array<{ role: 'user'; content: any[] }> = [];
  private wake: (() => void) | null = null;
  private finished = false;
  private nativeId: string | null;
  private ending = false;
  private disposed = false;
  private pump: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private opts: AgentSessionOpts, private loadSdk: () => Promise<{ query: typeof import('@anthropic-ai/claude-agent-sdk')['query'] }> = ensureSdk) {
    this.nativeId = opts.resumeNativeSessionId ?? null;
  }

  nativeSessionId() { return this.nativeId; }

  start() {
    this.pump = this.spawnAndPump(this.opts.resumeNativeSessionId ?? undefined);
  }

  private async *inputStream(): AsyncGenerator<any> {
    dbgLog('inputStream 启动');
    while (!this.finished) {
      while (this.pending.length === 0 && !this.finished) {
        await new Promise<void>((r) => { this.wake = r; });
      }
      if (this.finished) return;
      const msg = this.pending.shift()!;
      dbgLog('inputStream 产出用户消息');
      yield { type: USER_MESSAGE_TYPE, message: msg, parent_tool_use_id: null, session_id: this.nativeId ?? '' };
    }
  }

  private async spawnAndPump(resume?: string) {
    const stderrTail: string[] = [];
    try {
      const { query } = await this.loadSdk();
      dbgLog('SDK 已加载, 创建 query');
      this.q = query({
        prompt: this.inputStream(),
        options: {
          cwd: this.opts.cwd,
          model: this.opts.model,
          env: skillSessionEnv({ ...this.opts.env,
            ...(this.opts.reasoningLevel ? { CLAUDE_CODE_EFFORT_LEVEL: this.opts.reasoningLevel } : {}) }),
          pathToClaudeCodeExecutable: resolveClaudeExecutable(),
          permissionMode: 'default',               // 始终保留授权流程，绝不绕过
          // 原生 default 会自行批准只读调用；ask 规则确保全部工具先经过任务策略。
          settings: { permissions: { ask: ['*'] } },
          abortController: this.abort,
          settingSources: ['user'],                // 仅从隔离目录发现全局 Skill
          // 透传 SDK 的 toolUseID/requestId 给统一策略：同一原生调用的协议重试
          // （如传输断开后 reinitialize 重发 can_use_tool）据此共用一条待授权与决定
          ...(this.opts.canUseTool ? { canUseTool: (toolName: string, input: any, options?: any) =>
            this.opts.canUseTool!((toolName), input, {
              toolUseId: typeof options?.toolUseID === 'string' ? options.toolUseID : undefined,
              requestId: typeof options?.requestId === 'string' ? options.requestId : undefined,
            }) as any } : {}),
          ...(this.opts.systemPromptAppend ? {
            systemPrompt: { type: 'preset', preset: 'claude_code', append: this.opts.systemPromptAppend },
          } : { systemPrompt: { type: 'preset', preset: 'claude_code' } }),
          ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
          ...(this.opts.disallowedTools ? { disallowedTools: this.opts.disallowedTools } : {}),
          ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers as any } : {}),
          ...(resume ? { resume } : {}),
          stderr: (data: string) => {
            stderrTail.push(String(data));
            if (stderrTail.length > 20) stderrTail.shift();
          },
        },
      });
      for await (const msg of this.q as AsyncGenerator<any>) {
        this.dispatch(msg);
      }
      this.finish('done');
    } catch (e: any) {
      if (this.abort.signal.aborted || this.finished) {
        this.finish('interrupted');
      } else {
        const tail = stderrTail.join('').slice(-800);
        const stack = String(e?.stack ?? '').slice(0, 1600);
        this.opts.onEvent({ kind: 'error', message: `Claude 会话异常: ${String(e?.message ?? e)}${stack ? ` @ ${stack}` : ''}${tail ? ` | stderr: ${tail}` : ''}` });
        this.finish('error', String(e?.message ?? e));
      }
    }
  }

  private dispatch(msg: any) {
    const onEvent = this.opts.onEvent;
    switch (msg?.type) {
      case 'system': {
        if (msg.subtype === 'init' && msg.session_id) {
          this.nativeId = msg.session_id;
          onEvent({ kind: 'system', nativeSessionId: this.nativeId ?? undefined, model: msg.model });
        }
        break;
      }
      case 'stream_event': {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          onEvent({ kind: 'text_delta', text: ev.delta.text });
        }
        break;
      }
      case 'assistant': {
        const blocks = msg.message?.content ?? [];
        let textBuf = '';
        for (const b of blocks) {
          if (b.type === 'text') { textBuf += b.text; }
          else if (b.type === 'tool_use') {
            onEvent({ kind: 'tool_use', toolUseId: b.id, name: b.name, input: b.input });
          }
        }
        if (textBuf) onEvent({ kind: 'assistant_message', text: textBuf });
        break;
      }
      case USER_MESSAGE_TYPE: {
        // 回显消息中可能包含 tool_result；纯文本是我们自己发的，忽略避免重复
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool_result') {
              const text = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? '').join('') : '';
              onEvent({ kind: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, content: text });
            }
          }
        }
        break;
      }
      case 'result': {
        onEvent({
          kind: 'usage',
          usage: {
            input_tokens: msg.usage?.input_tokens ?? 0,
            output_tokens: msg.usage?.output_tokens ?? 0,
            cache_read_tokens: msg.usage?.cache_read_input_tokens ?? 0,
            cache_creation_tokens: msg.usage?.cache_creation_input_tokens ?? 0,
          },
          costUSD: null, // 端点计价不可靠：费用一律显示未知，不采用估算值
        });
        let text = String(msg.result ?? (Array.isArray(msg.errors) ? msg.errors.join('\n') : msg.is_error ? msg.subtype ?? 'Claude 执行失败' : ''));
        for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
          const secret = this.opts.env[key];
          if (secret) text = text.replaceAll(secret, '[REDACTED]');
        }
        onEvent({ kind: 'result', isError: !!msg.is_error, numTurns: msg.num_turns ?? 0, text });
        break;
      }
      default:
        break;
    }
  }

  private finish(reason: 'done' | 'interrupted' | 'error', error?: string) {
    if (this.ending) return;
    this.ending = true;
    this.finished = true;
    if (this.wake) { this.wake(); this.wake = null; }
    this.opts.onEnd(reason, error);
  }

  async send(text: string): Promise<void> {
    dbgLog(`send: finished=${this.finished}`);
    if (this.finished) {
      // 进程已结束：用原生会话恢复一个新的执行流
      await this.pump;
      if (this.disposed) throw new Error('Claude runtime 已关闭；需由任务服务创建新的恢复会话');
      this.ending = false;
      this.finished = false;
      this.abort = new AbortController();
      this.pump = this.spawnAndPump(this.nativeId ?? undefined);
    }
    if (this.disposed) throw new Error('Claude runtime 已关闭；需由任务服务创建新的恢复会话');
    this.pending.push({ role: 'user', content: [{ type: 'text', text }] });
    if (this.wake) { this.wake(); this.wake = null; }
  }

  async interrupt(): Promise<void> {
    try { await this.q?.interrupt(); } catch { /* 会话可能已退出 */ }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.disposed) return Promise.reject(new Error('Claude runtime is already disposed'));
    this.disposed = true;
    this.closePromise = this.closeAndWait();
    return this.closePromise;
  }

  private async closeAndWait(): Promise<void> {
    const query = this.q;
    try { query?.close(); } catch { /* abort and pump settlement remain authoritative */ }
    this.abort.abort();
    if (this.wake) { this.wake(); this.wake = null; }
    const pump = this.pump;
    if (!pump) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        pump,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Claude runtime close timed out while waiting for SDK pump')), 5000);
          timeout.unref();
        }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  start(opts: AgentSessionOpts): AgentSessionHandle {
    const s = new ClaudeCodeSession(opts);
    s.start();
    return s;
  }
}
