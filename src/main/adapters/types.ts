// Agent 适配器统一接口：start / send / interrupt / close(+resume via opts)
import type { AdapterEvent, PermissionContext, PermissionOutcome } from '../../shared/types';

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
  // ctx 携带执行器原生调用 ID（toolUseId/requestId）：统一策略据此对同一原生调用的
  // 协议重试去重。适配器必须尽力传递；拿不到时可不传（策略退化为并发期内容合并）。
  canUseTool?: (toolName: string, input: any, ctx?: PermissionContext) => Promise<PermissionOutcome>;
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
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findExecutable } from '../configDiscovery';

export interface RuntimeLookupOptions { env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform; }
function runtimeBins(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const bins=[path.join(home,'.local','bin'),path.join(home,'.npm-global','bin'),path.join(home,'.volta','bin')];
  for(const root of [path.join(home,'.local'),path.join(home,'.nvm','versions','node')]) {
    try { for(const entry of fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).slice(0,32)) {
      if(root.endsWith('.local') && !entry.name.startsWith('node-'))continue;
      bins.push(path.join(root,entry.name,'bin'));
    } } catch { /* optional user installations */ }
  }
  if(platform==='win32'){if(env.APPDATA)bins.push(path.join(env.APPDATA,'npm'));}
  else bins.push('/opt/homebrew/bin','/usr/local/bin','/usr/bin');
  return bins;
}
export function resolveRuntimeExecutable(command: string, override: string, options: RuntimeLookupOptions = {}): string | null {
  const env=options.env ?? process.env, platform=options.platform ?? process.platform;
  const home=options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const configured=env[override]?.trim();
  if(configured)return findExecutable(configured,{env,platform});
  return findExecutable(command,{env,platform}) ?? findExecutable(command,{env:{PATH:'',PATHEXT:env.PATHEXT},platform,extraPaths:runtimeBins(home,env,platform)});
}
export function resolveClaudeExecutable(options: RuntimeLookupOptions = {}): string | undefined {
  // Undefined lets the SDK select its own platform-specific optional binary.
  const executable = resolveRuntimeExecutable('claude','WORKBENCH_CLAUDE_PATH',options);
  return (options.platform ?? process.platform) === 'win32' && /\.(cmd|bat)$/i.test(executable ?? '')
    ? undefined : executable ?? undefined;
}
export function resolveNodeExecutable(options: RuntimeLookupOptions = {}): string {
  return resolveRuntimeExecutable('node','WORKBENCH_NODE_PATH',options) ?? process.execPath;
}
export function resolvePythonExecutable(options: RuntimeLookupOptions = {}): string {
  for(const name of ['python3','python',...(options.platform==='win32' || (!options.platform && process.platform==='win32') ? ['py'] : [])]){
    const executable=resolveRuntimeExecutable(name,'WORKBENCH_PYTHON',options);if(executable)return executable;
  }
  throw new Error('未找到 Python 3，请加入 PATH 或设置 WORKBENCH_PYTHON');
}
export function pythonArguments(executable: string): string[] { return /^py(?:\.exe)?$/i.test(path.win32.basename(executable)) ? ['-3'] : []; }

/** Called only with the current child PID retained by the adapter. Never uses
 * image-name matching, broad process enumeration, or a shared application PID. */
export function signalOwnedProcess(pid: number, signal: NodeJS.Signals, options: {
  platform?: NodeJS.Platform; kill?: typeof process.kill; spawnSync?: typeof spawnSync;
} = {}): void {
  if(!Number.isSafeInteger(pid) || pid<=0 || pid===process.pid)throw new Error('拒绝清理非子进程 PID');
  if((options.platform ?? process.platform)!=='win32'){(options.kill ?? process.kill)(-pid,signal);return;}
  const result=(options.spawnSync ?? spawnSync)('taskkill.exe',['/PID',String(pid),'/T',...(signal==='SIGKILL'?['/F']:[])],
    {windowsHide:true,stdio:'ignore',timeout:3000});
  if(result.error)throw result.error;
}
