// 外部 stdio MCP 入口：供 Codex 等外部客户端调用同一任务服务。
// 协议：MCP JSON-RPC over stdio；工具调用经回环控制通道转发给运行中的工作台。
// 用法: node dist/main/mcp/entry.js [--control <control.json路径>]
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as http from 'node:http';

interface Control { port: number; token: string; }

const args = process.argv.slice(2);
const parentIndex = args.indexOf('--parent-task-id');
const parentTaskId = parentIndex >= 0 ? args[parentIndex + 1] : '';
let controlPath = '';
const ci = args.indexOf('--control');
if (ci >= 0) controlPath = args[ci + 1];
if (!controlPath) {
  const dataDir = process.env.WORKBENCH_DATA_DIR
    ?? path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Agent Workbench');
  controlPath = path.join(dataDir, 'control.json');
}

function loadControl(): Control | null {
  try {
    const c = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    if (typeof c.port === 'number' && typeof c.token === 'string') return c;
    return null;
  } catch { return null; }
}

function rpc(method: string, params: any): Promise<any> {
  const control = loadControl();
  if (!control) return Promise.resolve({ ok: false, error: '工作台应用未运行（未找到 control.json）。请先启动 Agent Workbench。' });
  return new Promise((resolve) => {
    const body = JSON.stringify({ method, params });
    const req = http.request({
      host: '127.0.0.1', port: control.port, method: 'POST', path: '/v1/rpc',
      agent: false,   // 短连接：不保留 keep-alive 套接字
      headers: { 'content-type': 'application/json', authorization: `Bearer ${control.token}`, 'content-length': Buffer.byteLength(body) },
      timeout: method === 'tasks.wait' ? 25000 : 15000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: '控制通道响应解析失败' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: `控制通道连接失败: ${e.message}（工作台可能未运行）` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '控制通道超时' }); });
    req.end(body);
  });
}

const EXTRA: Record<string, {method:string,description:string,properties:any,required?:string[]}> = {
  workbench_list_agent_options:{method:'agents.options',description:'列出工作台真正接入的 Agent 和当前可用供应商/模型（仅元数据，不返回凭据）；下发前据此选择 agentId/providerId/model。',properties:{}},
  workbench_list_permissions:{method:'permissions.list',description:'读取指定任务的待授权操作详情。仅按已有用户授权处理，不扩大权限。',properties:{taskId:{type:'string'}},required:['taskId']},
  workbench_respond_permission:{method:'permissions.respondTask',description:'响应指定任务的一次授权请求；必须先读取操作详情并核对用户授权。',properties:{taskId:{type:'string'},permissionId:{type:'string'},decision:{type:'string',enum:['allow','deny']}},required:['taskId','permissionId','decision']},
  workbench_wait_task_events:{method:'tasks.wait',description:'等待1–8任务的关键事件；普通输出不唤醒，最多20秒，有游标重连。',properties:{targets:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{taskId:{type:'string'},sinceSeq:{type:'integer',minimum:0}},required:['taskId','sinceSeq'],additionalProperties:false}},timeoutMs:{type:'integer',minimum:0,maximum:20000}},required:['targets']},
  workbench_get_progress:{method:'tasks.progress',description:'轻量任务进度；运行时存在不等于执行进程健康。',properties:{projectId:{type:'string'}}},
  workbench_create_project:{method:'projects.create',description:'注册本地项目目录。',properties:{rootPath:{type:'string'},name:{type:'string'}},required:['rootPath']},
  workbench_get_project_memory:{method:'project.memory.get',description:'读取项目已确认背景与版本。',properties:{projectId:{type:'string'}},required:['projectId']},
  workbench_update_project_memory:{method:'project.memory.set',description:'更新已确认背景，必须携带读取到的版本与来源；冲突拒绝覆盖。',properties:{projectId:{type:'string'},facts:{type:'string',maxLength:20000},expectedVersion:{type:'integer',minimum:0},source:{type:'string',maxLength:200}},required:['projectId','facts','expectedVersion','source']},
  workbench_list_project_memories:{method:'project.memory.entries.list',description:'列出项目经验条目及状态、来源、版本、有效期。经验仅作参考，草稿不会自动注入。',properties:{projectId:{type:'string'},status:{type:'string',enum:['draft','adopted','inactive','superseded']},kind:{type:'string',enum:['fact','decision','lesson','handoff']}},required:['projectId']},
  workbench_search_project_memories:{method:'project.memory.entries.search',description:'在指定项目内做确定性的中英文关键词检索，返回命中词与词法分数，不代表语义正确率。',properties:{projectId:{type:'string'},query:{type:'string',maxLength:1000},statuses:{type:'array',items:{type:'string',enum:['draft','adopted','inactive','superseded']}},kind:{type:'string',enum:['fact','decision','lesson','handoff']},limit:{type:'integer',minimum:0,maximum:100}},required:['projectId','query']},
  workbench_get_project_memory_entry:{method:'project.memory.entries.get',description:'读取本项目内一条经验；跨项目或伪造 ID 不返回内容。',properties:{projectId:{type:'string'},id:{type:'string'}},required:['projectId','id']},
  workbench_get_project_memory_history:{method:'project.memory.entries.history',description:'读取本项目内经验条目的历史版本。',properties:{projectId:{type:'string'},id:{type:'string'}},required:['projectId','id']},
  workbench_create_project_memory_draft:{method:'project.memory.entries.create',description:'创建项目经验草稿。任务报告不得自动视为已采用事实；可传 requestId 安全重试。',properties:{projectId:{type:'string'},kind:{type:'string',enum:['fact','decision','lesson','handoff']},title:{type:'string',maxLength:200},body:{type:'string',maxLength:20000},source:{type:'string',maxLength:300},taskId:{type:'string'},evidenceRefs:{type:'array',items:{type:'string',maxLength:300},maxItems:30},expiresAt:{type:'string'},requestId:{type:'string',maxLength:200}},required:['projectId','kind','title','body','source']},
  workbench_update_project_memory_entry:{method:'project.memory.entries.update',description:'按 expectedVersion 修改同项目经验；冲突时须重新读取并合并。',properties:{projectId:{type:'string'},id:{type:'string'},expectedVersion:{type:'integer',minimum:1},patch:{type:'object',properties:{title:{type:'string',maxLength:200},body:{type:'string',maxLength:20000},source:{type:'string',maxLength:300},taskId:{type:['string','null']},evidenceRefs:{type:'array',items:{type:'string',maxLength:300},maxItems:30},expiresAt:{type:['string','null']}},additionalProperties:false}},required:['projectId','id','expectedVersion','patch']},
  workbench_set_project_memory_status:{method:'project.memory.entries.status',description:'按 expectedVersion 将草稿采用或停用；被替代项不能重启。',properties:{projectId:{type:'string'},id:{type:'string'},expectedVersion:{type:'integer',minimum:1},status:{type:'string',enum:['adopted','inactive']}},required:['projectId','id','expectedVersion','status']},
  workbench_replace_project_memory_entry:{method:'project.memory.entries.replace',description:'原子创建已采用的新条目并将旧条目标记为被替代，保留替代链接和历史版本。',properties:{projectId:{type:'string'},id:{type:'string'},expectedVersion:{type:'integer',minimum:1},entry:{type:'object',properties:{kind:{type:'string',enum:['fact','decision','lesson','handoff']},title:{type:'string',maxLength:200},body:{type:'string',maxLength:20000},source:{type:'string',maxLength:300},taskId:{type:'string'},evidenceRefs:{type:'array',items:{type:'string',maxLength:300},maxItems:30},expiresAt:{type:'string'},requestId:{type:'string',maxLength:200}},required:['kind','title','body','source'],additionalProperties:false}},required:['projectId','id','expectedVersion','entry']},
  workbench_create_task_handoff_draft:{method:'project.memory.handoff.create',description:'从指定项目任务最后一条成功结果事件创建“Agent 报告，待核对”的交接草稿；不调用模型、不接受失败或取消结果。',properties:{taskId:{type:'string'}},required:['taskId']},
  workbench_get_task_memory_used:{method:'task.memory.used',description:'读取任务首次输入时实际注入的经验 ID、版本、来源和正文快照。',properties:{taskId:{type:'string'}},required:['taskId']},
  workbench_get_task_background:{method:'task.background',description:'查看创建时的项目背景快照与任务交接。',properties:{taskId:{type:'string'}},required:['taskId']},
};
const TOOLS = [
  ...Object.entries(EXTRA).map(([name,t])=>({name,description:t.description,inputSchema:{type:'object',properties:t.properties,required:t.required??[],additionalProperties:false}})),
  {
    name: 'workbench_list_projects',
    description: '列出工作台中的项目。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workbench_list_tasks',
    description: '列出任务（会话），可按项目过滤。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string', description: '可选：按项目过滤' } }, additionalProperties: false },
  },
  {
    name: 'workbench_create_task',
    description: '在指定项目新建主任务并发送首个提示词。指定 agentId 且省略 providerId/model 时使用工作台为该 Agent 保存的默认模型；单次指定不修改默认。可用组合由 workbench_list_agent_options 返回。fileWrite 控制是否允许项目内写文件。',
    inputSchema: {
      type: 'object',
      properties: {
        agentId:{type:'string',enum:['claude-code','grok','dsh','zcode']}, model:{type:'string'}, providerId:{type:'string'},
        background:{type:'string',maxLength:20000}, clientRequestId:{type:'string',maxLength:200},
        projectId: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        fileWrite: { type: 'boolean', description: '默认 false；任务已获项目写入授权时才设 true' },
      },
      required: ['projectId', 'title', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_send_message',
    description: '向任务发送一条消息（继续对话）；重试时复用 clientMsgId 防止重复派发。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, message: { type: 'string' }, clientMsgId: { type: 'string', maxLength: 200 } }, required: ['taskId', 'message'], additionalProperties: false },
  },
  {
    name: 'workbench_get_task',
    description: '查询单个任务详情（状态、模型、cwd、摘要）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'workbench_get_task_events',
    description: '读取任务事件流（增量可选）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, sinceSeq: { type: 'number' } }, required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'workbench_read_task_result',
    description: '读取任务结果（状态/摘要/变更文件/用量）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'workbench_cancel_task',
    description: '取消任务（停止执行；父任务会级联停止运行中的子任务）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'workbench_merge_task',
    description: '将子任务 worktree 的改动合并回项目主树（合并前检查冲突，不覆盖未提交改动）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  },
];

// ACP Agent 仅看到绑定主任务的子任务工具。全局创建/取消接口不暴露给它。
const AGENT_TOOLS = [
  { name: 'delegate_task', description: '在当前 Workbench 主任务下创建可追踪子任务；带项目背景和验收标准。', properties: {
    title: { type: 'string' }, instructions: { type: 'string' }, context_files: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'string' },
  }, required: ['title', 'instructions'] },
  { name: 'list_subtasks', description: '列出当前主任务的子任务和状态。', properties: {}, required: [] },
  { name: 'read_task_result', description: '读取属于当前主任务的子任务结果。', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  { name: 'append_task_message', description: '向属于当前主任务的子任务追加反馈。', properties: { task_id: { type: 'string' }, message: { type: 'string' }, client_msg_id: { type: 'string' } }, required: ['task_id', 'message'] },
  { name: 'cancel_task', description: '停止属于当前主任务的子任务。', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  { name: 'get_task_events', description: '增量读取属于当前主任务的子任务事件。', properties: { task_id: { type: 'string' }, since_seq: { type: 'integer', minimum: 0 } }, required: ['task_id'] },
].map((tool) => ({ name: tool.name, description: tool.description,
  inputSchema: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false } }));

function write(msg: any) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function callTool(name: string, args: any): Promise<any> {
  let r: any;
  if (parentTaskId) {
    switch (name) {
      case 'delegate_task': r = await rpc('agent.delegate', { parentTaskId, ...args }); break;
      case 'list_subtasks': r = await rpc('agent.subtasks.list', { parentTaskId }); break;
      case 'read_task_result': r = await rpc('agent.subtask.result', { parentTaskId, taskId: args?.task_id }); break;
      case 'append_task_message': r = await rpc('agent.subtask.append', { parentTaskId, taskId: args?.task_id, message: args?.message, clientMsgId: args?.client_msg_id }); break;
      case 'cancel_task': r = await rpc('agent.subtask.cancel', { parentTaskId, taskId: args?.task_id }); break;
      case 'get_task_events': r = await rpc('agent.subtask.events', { parentTaskId, taskId: args?.task_id, sinceSeq: args?.since_seq }); break;
      default: r = { ok: false, error: '该 Agent 没有此 Workbench 工具' };
    }
  } else if (EXTRA[name]) r = await rpc(EXTRA[name].method,args);
  else switch (name) {
    case 'workbench_list_projects': r = await rpc('projects.list', {}); break;
    case 'workbench_list_tasks': r = await rpc('tasks.list', { projectId: args?.projectId }); break;
    case 'workbench_create_task': r = await rpc('task.create', args); break;
    case 'workbench_send_message': r = await rpc('task.send', { taskId: args?.taskId, message: args?.message, clientMsgId: args?.clientMsgId ?? `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }); break;
    case 'workbench_get_task': r = await rpc('task.get', { taskId: args?.taskId }); break;
    case 'workbench_get_task_events': r = await rpc('task.events', { taskId: args?.taskId, sinceSeq: args?.sinceSeq }); break;
    case 'workbench_read_task_result': r = await rpc('task.result', { taskId: args?.taskId }); break;
    case 'workbench_cancel_task': r = await rpc('task.cancel', { taskId: args?.taskId }); break;
    case 'workbench_merge_task': r = await rpc('task.merge', { taskId: args?.taskId }); break;
    default: r = { ok: false, error: `未知工具: ${name}` };
  }
  const isError = r && r.ok === false;
  return {
    content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
    isError,
  };
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const pending = new Map<string, (r: any) => void>();

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (method === 'initialize') {
      write({
        jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-workbench-task-service', version: '0.3.2' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) return;
    if (method === 'ping') { write({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') { write({ jsonrpc: '2.0', id, result: { tools: parentTaskId ? AGENT_TOOLS : TOOLS } }); return; }
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments);
      write({ jsonrpc: '2.0', id, result });
      return;
    }
    // 其余方法（resources/prompts 等）不支持
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  });

  rl.on('close', () => process.exit(0));
}

main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
