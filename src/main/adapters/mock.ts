// 模拟适配器：可脚本化的假 Agent（测试专用，身份在事件与 UI 中显式标注 mock）
// 脚本步骤：text / tool / permission / usage / result / wait / fail / write
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentAdapter, AgentSessionHandle, AgentSessionOpts } from './types';
import type { AdapterEvent } from '../../shared/types';

export type MockStep =
  | { t: 'text'; text: string; chunk?: number }
  | { t: 'tool'; name: string; input: any; resultText: string; isError?: boolean }
  | { t: 'write'; relPath: string; content: string }             // 直接写文件并产生 tool 事件
  | { t: 'permission'; toolName: string; input: any; expect: 'allow' | 'deny' | 'any' }
  | { t: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; costUSD?: number }
  | { t: 'result'; text: string; isError?: boolean }
  | { t: 'wait'; ms: number }
  | { t: 'fail'; message: string };

export interface MockScript {
  id: string;                 // 脚本身份，如 'mock-reviewer'
  steps: MockStep[];
  turns?: Record<string, MockStep[]>;  // 按用户消息内容路由的附加脚本
}

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly displayName = '模拟 Agent（仅测试）';
  constructor(private script: MockScript) {}

  start(opts: AgentSessionOpts): AgentSessionHandle {
    const session = new MockSession(this.script, opts);
    session.begin();
    return session;
  }
}

class MockSession implements AgentSessionHandle {
  private native: string;
  private aborted = false;
  private closed = false;
  private turnCount = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private script: MockScript, private opts: AgentSessionOpts) {
    this.native = opts.resumeNativeSessionId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  }

  nativeSessionId() { return this.native; }

  begin() {
    this.opts.onEvent({ kind: 'system', nativeSessionId: this.native, model: this.opts.model });
  }

  async send(text: string): Promise<void> {
    if (this.closed || this.aborted) return;
    let steps = this.script.steps;
    if (this.turnCount > 0 && this.script.turns) {
      const key = Object.keys(this.script.turns).find((k) => text.includes(k));
      if (key) steps = this.script.turns[key];
    }
    this.turnCount++;
    this.queue = this.queue.then(() => this.runSteps(steps, text));
    await this.queue;
  }

  private async emit(e: AdapterEvent) {
    if (this.closed) return;
    this.opts.onEvent(e);
  }

  private sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

  private async runSteps(steps: MockStep[], userText: string): Promise<void> {
    try {
      await this.emit({ kind: 'text_delta', text: '' });
      for (const step of steps) {
        if (this.aborted || this.closed) { this.opts.onEnd('interrupted'); return; }
        switch (step.t) {
          case 'text': {
            const chunk = step.chunk ?? 6;
            for (let i = 0; i < step.text.length; i += chunk) {
              if (this.aborted || this.closed) { this.opts.onEnd('interrupted'); return; }
              await this.emit({ kind: 'text_delta', text: step.text.slice(i, i + chunk) });
              await this.sleep(5);
            }
            const full = (this as any).__text || '';
            (this as any).__text = full + step.text;
            break;
          }
          case 'permission': {
            await this.emit({ kind: 'text_delta', text: '' });
            const outcome = this.opts.canUseTool
              ? await this.opts.canUseTool(step.toolName, step.input)
              : { behavior: 'deny' as const };
            const ok = outcome.behavior === 'allow';
            if (step.expect !== 'any' && ok !== (step.expect === 'allow')) {
              await this.emit({ kind: 'result', isError: true, numTurns: this.turnCount, text: `授权结果不符合预期: ${outcome.behavior}` });
              this.opts.onEnd('done');
              return;
            }
            await this.emit({ kind: 'tool_result', toolUseId: `mock-${Date.now()}`, name: step.toolName, isError: !ok, content: ok ? 'allowed' : 'denied by user' });
            break;
          }
          case 'tool': {
            const id = `mocktool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            await this.emit({ kind: 'tool_use', toolUseId: id, name: step.name, input: step.input });
            await this.sleep(20);
            await this.emit({ kind: 'tool_result', toolUseId: id, name: step.name, isError: !!step.isError, content: step.resultText });
            break;
          }
          case 'write': {
            const abs = path.join(this.opts.cwd, step.relPath);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, step.content, 'utf8');
            const id = `mockw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            await this.emit({ kind: 'tool_use', toolUseId: id, name: 'Write', input: { file_path: abs, content: step.content } });
            await this.sleep(20);
            await this.emit({ kind: 'tool_result', toolUseId: id, name: 'Write', isError: false, content: `Wrote ${step.relPath}` });
            break;
          }
          case 'usage': {
            // 与真实适配器同口径：只上报脚本给出的字段（缺省类别不上报=未知，不补零）
            const usage: Record<string, number> = { input_tokens: step.inputTokens, output_tokens: step.outputTokens };
            if (step.cacheReadTokens != null) usage.cache_read_tokens = step.cacheReadTokens;
            if (step.cacheCreationTokens != null) usage.cache_creation_tokens = step.cacheCreationTokens;
            await this.emit({ kind: 'usage', usage, costUSD: step.costUSD ?? null });
            break;
          }
          case 'result':
            await this.emit({ kind: 'assistant_message', text: (this as any).__text || step.text });
            await this.emit({ kind: 'result', isError: !!step.isError, numTurns: this.turnCount, text: step.text });
            (this as any).__text = '';
            this.opts.onEnd('done');
            return;
          case 'wait':
            await this.sleep(step.ms);
            break;
          case 'fail':
            await this.emit({ kind: 'error', message: step.message });
            this.opts.onEnd('error', step.message);
            return;
        }
      }
      await this.emit({ kind: 'assistant_message', text: (this as any).__text || `（模拟完成）收到: ${userText}` });
      await this.emit({ kind: 'result', isError: false, numTurns: this.turnCount, text: (this as any).__text || '模拟回合完成' });
      (this as any).__text = '';
      this.opts.onEnd('done');
    } catch (e: any) {
      await this.emit({ kind: 'error', message: String(e?.message ?? e) });
      this.opts.onEnd('error', String(e?.message ?? e));
    }
  }

  async interrupt(): Promise<void> {
    this.aborted = true;
    this.opts.onEnd('interrupted');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.aborted = true;
    this.opts.onEnd('interrupted');
  }
}
