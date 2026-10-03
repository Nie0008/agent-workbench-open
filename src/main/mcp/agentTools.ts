// 主 Agent 专属工具（进程内 SDK MCP）：委派/查询/追加/取消/读结果/事件流。
// 与外部 stdio MCP 共享同一 TaskService。
// SDK 懒加载（模块初始化有相对 cwd 的目录扫描，见 adapters/claude.ts 说明）。
import type { TaskService } from '../taskService';

export function isOwnSubtask(taskService: TaskService, parentSessionId: string, taskId: string): boolean {
  const task = taskService.getSession(taskId);
  return !!task && task.kind === 'sub' && task.parentSessionId === parentSessionId;
}

function text(r: any, isError = false): any {
  return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }], isError };
}

export async function createWorkbenchMcpServer(taskService: TaskService, parentSessionId: string): Promise<Record<string, unknown>> {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');
  const delegateTask = tool(
    'delegate_task',
    '委派一个子任务并行执行。携带项目背景、相关文件、要求与验收标准。系统会为 context_files 生成"背景快照"（文件内容+版本+主树未提交补丁），子任务据此可见你的当前改动——请把需要审查/处理的文件都列入 context_files。并发上限与委派次数由系统限制。禁止在子任务内再委派。',
    {
      title: z.string().describe('子任务标题，简短'),
      instructions: z.string().describe('详细要求：做什么、怎么做、注意什么'),
      context_files: z.array(z.string()).optional().describe('相关文件相对路径列表'),
      acceptance: z.string().optional().describe('验收标准：完成后如何核对'),
    },
    async (args) => {
      const r = await taskService.delegate(parentSessionId, args as any);
      if (!r.ok) return text({ error: r.error }, true);
      return text({ taskId: r.taskId, status: 'running', note: '可用 get_task_events 跟踪进度，read_task_result 读取结果。' });
    },
  );

  const listSubtasks = tool(
    'list_subtasks',
    '列出当前主任务的全部子任务及状态。',
    {},
    async () => {
      const subs = taskService.listSubtasks(parentSessionId);
      return text(subs.map((s) => ({ taskId: s.id, title: s.title, status: s.status, summary: s.summary?.slice(0, 200) ?? null })));
    },
  );

  const readTaskResult = tool(
    'read_task_result',
    '读取子任务结果：状态、结果摘要、变更文件与用量。',
    { task_id: z.string().describe('子任务 ID') },
    async (args) => {
      if (!isOwnSubtask(taskService, parentSessionId, args.task_id)) return text({ error: '只能读取本主任务的子任务' }, true);
      const r = taskService.readTaskResult(args.task_id);
      if (!r.ok) return text({ error: r.error }, true);
      return text(r.result);
    },
  );

  const appendTaskMessage = tool(
    'append_task_message',
    '向运行中或已完成的子任务追加一条消息（补充要求、纠偏）。注意：追加后子任务会继续执行。',
    { task_id: z.string(), message: z.string() },
    async (args) => {
      if (!isOwnSubtask(taskService, parentSessionId, args.task_id)) return text({ error: '只能操作本主任务的子任务' }, true);
      const r = await taskService.appendToSubtask(args.task_id, args.message);
      if (!r.ok) return text({ error: r.error }, true);
      return text({ ok: true });
    },
  );

  const cancelTask = tool(
    'cancel_task',
    '取消一个子任务（停止其执行）。需要释放并发额度时使用。',
    { task_id: z.string() },
    async (args) => {
      if (!isOwnSubtask(taskService, parentSessionId, args.task_id)) return text({ error: '只能取消自己的子任务' }, true);
      taskService.cancelSubtask(args.task_id);
      return text({ ok: true });
    },
  );

  const getTaskEvents = tool(
    'get_task_events',
    '查看子任务事件流（文本增量、工具调用、文件变更等），用于跟踪进度。',
    { task_id: z.string(), since_seq: z.number().optional().describe('从该序号之后开始取') },
    async (args) => {
      if (!isOwnSubtask(taskService, parentSessionId, args.task_id)) return text({ error: '只能读取本主任务的子任务' }, true);
      const r = taskService.getTaskEvents(args.task_id, args.since_seq ?? 0);
      return text(r.events);
    },
  );

  const runIsolatedCheck = tool(
    'run_isolated_check',
    '运行本任务范围中明确授权的构建/测试命令。命令必须与授权清单完全一致；Workbench 将项目复制到无网络、无宿主凭据的本地容器，记录退出码与结果。普通 Bash 不因此获得宿主执行权限。',
    { command: z.string().describe('授权清单中的完整命令'),
      image: z.string().optional().describe('可选。仅申请清单外一次执行时提供本地镜像的完整 sha256 ID') },
    async (args) => {
      const r = await taskService.runIsolatedCheck(parentSessionId, args.command, args.image);
      return text(r, !r.ok);
    },
  );

  return {
    workbench: createSdkMcpServer({
      name: 'workbench',
      version: '0.1.0',
      tools: [delegateTask, listSubtasks, readTaskResult, appendTaskMessage, cancelTask, getTaskEvents, runIsolatedCheck],
    }),
  };
}
