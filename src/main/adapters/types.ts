// Agent 适配器统一接口：start / send / interrupt / close(+resume via opts)
import type { AdapterEvent, PermissionOutcome } from '../../shared/types';

export interface AgentSessionOpts {
  taskId?: string;
  providerId?: string;
  allowDelegation?: boolean;
  cwd: string;
  model: string;
  reasoningLevel?: string;
  env: Record<string, string>;
  systemPromptAppend?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  canUseTool?: (toolName: string, input: any) => Promise<PermissionOutcome>;
  resumeNativeSessionId?: string | null;
  onEvent: (e: AdapterEvent) => void;
  onEnd: (reason: 'done' | 'interrupted' | 'error', error?: string) => void;
}

export interface AgentSessionHandle {
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;   // 停止当前轮，会话保持可继续
  close(): Promise<void>;       // 硬终止进程
  nativeSessionId(): string | null;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  start(opts: AgentSessionOpts): AgentSessionHandle;
}

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function resolveClaudeExecutable(): string {
  const candidates = [
    process.env.WORKBENCH_CLAUDE_PATH,
    `${process.env.HOME}/.local/bin/claude`,
  ];
  for (const c of candidates) {
    if (c) { try { fs.accessSync(c); return c; } catch { /* next */ } }
  }
  try {
    const out = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* fallthrough */ }
  return 'claude';
}
