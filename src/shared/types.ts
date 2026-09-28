// 共享类型：主进程 / renderer / MCP 共用的最小契约

export type SessionKind = 'main' | 'sub';
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'resuming'
  | 'interrupted'
  | 'timeout';

export type EventType =
  | 'session'              // 状态变更 payload:{status, reason?}
  | 'text_delta'           // payload:{text}
  | 'message'              // 完整消息 payload:{role:'assistant'|'user', text}
  | 'tool_request'         // payload:{toolUseId,name,input}
  | 'tool_result'          // payload:{toolUseId,name,ok,brief}
  | 'permission_request'   // payload:{permissionId,toolName,input,reason}
  | 'permission_resolved'  // payload:{permissionId,decision:'allow'|'deny'}
  | 'file_change'          // payload:{path,change:'add'|'modify'|'delete',origin}
  | 'task_delegated'       // payload:{subTaskId,title,instructions}
  | 'subtask_status'       // payload:{subTaskId,status,summary?}
  | 'usage'                // payload:仅记录执行器上报的字段（inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens）
                          //   +costUSD?:null；缺失字段=未上报（未知），不补零
  | 'result'               // payload:{isError,numTurns,text}
  | 'error'                // payload:{message}
  | 'conflict'             // payload:{kind:'write'|'merge', path?, detail}
  | 'notice';              // payload:{text}

export interface WorkbenchEvent {
  id?: number;
  seq: number;
  sessionId: string;
  type: EventType;
  payload: any;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  isGit: boolean;
  createdAt: string;
}

export type MemoryKind = 'fact' | 'decision' | 'lesson' | 'handoff';
export type MemoryStatus = 'draft' | 'adopted' | 'inactive' | 'superseded';
export interface MemoryEntry {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  source: string;
  taskId: string | null;
  evidenceRefs: string[];
  status: MemoryStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  replacedById: string | null;
}
export interface MemoryInjectionSnapshot {
  taskId: string;
  projectId: string;
  query: string;
  createdAt: string;
  charBudget: number;
  entries: Array<MemoryEntry & { matchedTerms: string[]; injectedText: string }>;
}

export interface SessionRow {
  id: string;
  projectId: string;
  kind: SessionKind;
  parentSessionId: string | null;
  title: string;
  agentId: string;
  model: string;
  status: SessionStatus;
  nativeSessionId: string | null;
  cwd: string;                    // 主任务=项目根；子任务=worktree 或项目根
  scopeJson: string;              // {fileWrite:boolean}
  delegationJson: string | null;  // {instructions, contextFiles, acceptance, snapshot?}
  summary: string | null;         // 最近一次 result 摘要
  providerId: string | null;      // 会话绑定供应商；NULL=旧数据未绑定
  createdAt: string;
  updatedAt: string;
}

export interface TaskScope {
  fileWrite: boolean;   // 允许在项目（或 worktree）内写文件
}

export interface ProviderInfo {
  providerId: string;
  profileId?: string;
  name: string;
  baseUrl: string;
  model: string;
  isCurrent?: boolean;
}

export type ModelAgentId = 'claude-code' | 'grok' | 'dsh' | 'zcode';
export interface ModelProfile {
  id: string;
  name: string;
  providerId: string;
  model: string;
  agents: ModelAgentId[];
  reasoningLevel?: string;
  sourceFingerprint?: string;
}

export interface AdapterDescriptor {
  id: string;
  displayName: string;
  verified: boolean;   // 仅展示已真实接入验证的组合
}

// Agent 适配器接口：所有 Agent（真实/模拟）实现同一能力面
export type AdapterEvent =
  | { kind: 'activity' } // Progress signal only; never carries private reasoning text.
  | { kind: 'system'; nativeSessionId?: string; model?: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_message'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: any }
  | { kind: 'tool_result'; toolUseId: string; name?: string; content?: string; isError: boolean }
  | { kind: 'usage'; usage: Record<string, number>; costUSD: number | null }
  | { kind: 'result'; isError: boolean; numTurns: number; text: string }
  | { kind: 'error'; message: string };

export interface PermissionOutcome {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface TurnOptions {
  cwd: string;
  model: string;
  env: Record<string, string>;      // 含凭据，仅用于子进程环境，禁止记录
  systemPromptAppend?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  canUseTool?: (toolName: string, input: any) => Promise<PermissionOutcome>;
  resumeNativeSessionId?: string;
  abortSignal: AbortSignal;
  onEvent: (e: AdapterEvent) => void;
  maxTurns?: number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  runTurn(prompt: string, opts: TurnOptions): Promise<void>;
}

// taskService 对外能力（renderer、MCP、Agent 工具共用）
export interface TaskSummary {
  id: string;
  projectId: string;
  kind: SessionKind;
  parentSessionId: string | null;
  title: string;
  status: SessionStatus;
  agentId: string;
  model: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileChangeInfo {
  path: string;
  change: 'add' | 'modify' | 'delete';
  origin: string;
}

// 单类别用量的回合覆盖情况：complete=false 表示合计只是部分已知值（部分回合未上报）
export interface UsageFieldCoverage {
  roundsReported: number;   // 上报过该类别的已记录回合数
  roundsMissing: number;    // 未上报该类别的已记录回合数
  complete: boolean;        // 全部已记录回合均已上报（合计才是完整值）
}

export type UsageField = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens';

// 任务用量汇总：仅累计“已记录”的用量事件（执行器在每回合结果时上报；SDK 口径为主循环
// 用量，不含子Agent/辅助调用，因此不等于任务全部真实消耗）。
// 未知与零严格区分：值为 null 表示没有任何已记录回合上报该类别；不冒充已知费用或总量。
export interface TaskUsageSummary {
  roundsRecorded: number;          // 已记录用量的回合数
  inputTokens: number | null;      // 各回合合计；null=无记录（≠0）；部分回合未上报时仅为部分小计（见 fieldCoverage）
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  fieldCoverage: Record<UsageField, UsageFieldCoverage>;  // 每类别已上报/缺失回合数与完整性
  costUSD: number | null;          // 仅当所有已记录回合费用都已知时为各回合合计；任一回合未知则为 null（部分已知不冒充总费用）
  costKnown: boolean;              // true 仅当所有已记录回合的费用都已知
  costMissingRounds: number;       // 费用未知的已记录回合数
  fieldsNotReported: string[];     // 所有已记录事件均未上报的类别（未知，≠0）
  scopeNote: string;               // 统计口径说明（不含中断/未上报的消耗）
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface DiffLine { type: 'ctx' | 'add' | 'del'; text: string; }

export interface Settings {
  taskTimeoutSec: number;
  maxConcurrentSubtasks: number;
  maxDelegationsPerTask: number;
}
