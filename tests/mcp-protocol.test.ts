// E 阶段：stdio MCP 协议真实测试（最小 MCP 客户端 ↔ entry.js ↔ 回环控制通道 ↔ TaskService）
// 模拟测试：任务执行用 mock 适配器；协议链路（stdio JSON-RPC）为真实实现。
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child from 'node:child_process';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import { ControlServer } from '../src/main/controlServer';
import type { MockScript } from '../src/main/adapters/mock';

const ROOT = path.resolve(path.dirname(decodeURI(new URL(import.meta.url).pathname)), '..');

let tmp: string;
let store: Store;
let ts: TaskService;
let control: ControlServer;
let childProc: child.ChildProcess | null = null;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mcp-'));
  store = new Store(path.join(tmp, 'wb.db'));
  ts = new TaskService(store, new CredentialManager());
  ts.broadcast = () => {};
  control = new ControlServer(ts);
  await control.start(path.join(tmp, 'control.json'));
});

afterEach(() => {
  childProc?.kill('SIGKILL');
  childProc = null;
  control.stop();
  ts.shutdown();
  try { store.close(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Rpc {
  proc: child.ChildProcess;
  buf: string;
  waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[];
  nextId: number;
}

function spawnEntry(parentTaskId?: string): Rpc {
  const entryArgs = [path.join(ROOT, 'dist/main/mcp/entry.js'), '--control', path.join(tmp, 'control.json')];
  if (parentTaskId) entryArgs.push('--parent-task-id', parentTaskId);
  const proc = child.spawn(process.execPath, entryArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc: Rpc = { proc, buf: '', waiters: [], nextId: 1 };
  proc.stdout!.on('data', (d) => {
    rpc.buf += d.toString();
    let idx;
    while ((idx = rpc.buf.indexOf('\n')) >= 0) {
      const line = rpc.buf.slice(0, idx).trim();
      rpc.buf = rpc.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const i = rpc.waiters.findIndex((w) => w.match(msg));
        if (i >= 0) rpc.waiters.splice(i, 1)[0].resolve(msg);
      } catch { /* ignore */ }
    }
  });
  proc.stderr!.on('data', () => { /* 调试时可打印 */ });
  return rpc;
}

function send(rpc: Rpc, method: string, params?: any): Promise<any> {
  const id = rpc.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP 超时: ${method}`)), 10000);
    rpc.waiters.push({ match: (m) => m.id === id, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    rpc.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(rpc: Rpc, method: string) {
  rpc.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params: {} }) + '\n');
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

test('MCP：可启动、initialize、列工具', async () => {
  const rpc = spawnEntry();
  childProc = rpc.proc;
  const init = await send(rpc, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'protocol-test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'agent-workbench-task-service');
  notify(rpc, 'notifications/initialized');
  const tools = await send(rpc, 'tools/list', {});
  const names = tools.result.tools.map((t: any) => t.name);
  for (const n of ['workbench_list_projects', 'workbench_create_task', 'workbench_send_message', 'workbench_get_task', 'workbench_get_task_events', 'workbench_read_task_result', 'workbench_cancel_task', 'workbench_merge_task',
    'workbench_list_project_memories','workbench_search_project_memories','workbench_get_project_memory_entry','workbench_get_project_memory_history',
    'workbench_create_project_memory_draft','workbench_update_project_memory_entry','workbench_set_project_memory_status',
    'workbench_replace_project_memory_entry','workbench_create_task_handoff_draft','workbench_get_task_memory_used']) {
    assert.ok(names.includes(n), `工具存在: ${n}`);
  }
  assert.ok(names.includes('workbench_list_agent_options'));
  const createSchema = tools.result.tools.find((tool: any) => tool.name === 'workbench_create_task').inputSchema;
  assert.equal(createSchema.properties.readRoots.type, 'array');
  assert.equal(createSchema.properties.readRoots.maxItems, 20);
  const options = await send(rpc, 'tools/call', { name: 'workbench_list_agent_options', arguments: {} });
  const optionsData = JSON.parse(options.result.content[0].text);
  assert.deepEqual(optionsData.agents.map((agent: any) => agent.agentId).sort(), ['claude-code', 'dsh', 'grok', 'zcode']);
  assert.ok(Array.isArray(optionsData.combinations));
  assert.ok(!JSON.stringify(optionsData).includes('apiKey'));
});

test('MCP：记忆 CRUD、中文搜索、状态和任务使用快照共用受控服务',async()=>{
  const p=ts.createProject(path.join(tmp,'memory-project'));
  const other=ts.createProject(path.join(tmp,'memory-other'));
  const rpc=spawnEntry();childProc=rpc.proc;
  await send(rpc,'initialize',{protocolVersion:'2025-06-18'});
  const call=async(name:string,args:any)=>{
    const response=await send(rpc,'tools/call',{name,arguments:args});
    return {result:JSON.parse(response.result.content[0].text),isError:response.result.isError};
  };
  const created=await call('workbench_create_project_memory_draft',{projectId:p.id,kind:'lesson',title:'Node 包管理器',body:'包管理器固定使用 pnpm。',source:'docs/development.md',requestId:'mcp-create-1'});
  assert.equal(created.result.entry.status,'draft');
  const adopted=await call('workbench_set_project_memory_status',{projectId:p.id,id:created.result.entry.id,expectedVersion:1,status:'adopted'});
  assert.equal(adopted.result.entry.status,'adopted');
  const found=await call('workbench_search_project_memories',{projectId:p.id,query:'项目使用什么包管理器？'});
  assert.ok(found.result.matches.some((match:any)=>match.entry.id===created.result.entry.id));
  const denied=await call('workbench_get_project_memory_entry',{projectId:other.id,id:created.result.entry.id});
  assert.equal(denied.isError,true);
  assert.match(denied.result.error,/不存在/);

  ts.registerMockScript('memory-noop',{id:'memory-noop',steps:[]});
  const task=ts.createMainSession({projectId:p.id,title:'Node 包管理器任务',agentId:'mock',mockScript:'memory-noop'});
  // No model is launched for the readback assertion; preparation uses the same stored TaskService path.
  ts.memory.prepareTaskInjection(task.id,'项目需要选择包管理器');
  const used=await call('workbench_get_task_memory_used',{taskId:task.id});
  assert.equal(used.result.injection.entries[0].id,created.result.entry.id);
  assert.ok(used.result.injection.entries[0].injectedText.includes('来源：docs/development.md'));

  store.appendEvent(task.id,'result',{isError:false,numTurns:1,text:'Agent 报告了 pnpm 配置。'});
  store.updateSession(task.id,{status:'idle'});
  const handoff=await call('workbench_create_task_handoff_draft',{taskId:task.id});
  assert.equal(handoff.result.entry.status,'draft');
  assert.ok(handoff.result.entry.body.includes('Agent 报告，待核对'));
});

test('MCP：Agent 子任务桥仅暴露并操作所属主任务', async () => {
  const root = path.join(tmp, 'agent-project');
  fs.mkdirSync(root);
  ts.registerMockScript('agent-script', { id: 'agent', steps: [{ t: 'result', text: '完成' }] });
  const project = ts.createProject(root);
  const parent = ts.createMainSession({ projectId: project.id, title: '父任务', agentId: 'mock', mockScript: 'agent-script', prompt: '开始' });
  const other = ts.createMainSession({ projectId: project.id, title: '其他主任务', agentId: 'mock', mockScript: 'agent-script' });
  const rpc = spawnEntry(parent.id);
  childProc = rpc.proc;
  await send(rpc, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-test', version: '0' } });
  const listed = await send(rpc, 'tools/list', {});
  const names = listed.result.tools.map((tool: any) => tool.name);
  assert.ok(names.includes('delegate_task'));
  assert.ok(!names.includes('workbench_create_task'));
  const delegated = await send(rpc, 'tools/call', { name: 'delegate_task', arguments: { title: '子任务', instructions: '只回复完成' } });
  const created = JSON.parse(delegated.result.content[0].text);
  assert.equal(created.ok, true);
  assert.equal(ts.getSession(created.taskId)?.parentSessionId, parent.id);
  const deniedGlobal = await send(rpc, 'tools/call', { name: 'workbench_create_task', arguments: { projectId: project.id, title: '越权', prompt: 'x' } });
  assert.equal(JSON.parse(deniedGlobal.result.content[0].text).ok, false);
  const deniedOther = await send(rpc, 'tools/call', { name: 'read_task_result', arguments: { task_id: other.id } });
  assert.equal(JSON.parse(deniedOther.result.content[0].text).ok, false);
});

test('MCP：下发任务→事件→读结果→取消 全链路（模拟执行）', async () => {
  const fast: MockScript = { id: 'fast', steps: [{ t: 'write', relPath: 'mcp-out.txt', content: 'from mcp' }, { t: 'result', text: 'MCP 子任务完成' }] };
  ts.registerMockScript('mock-fast', fast);
  const proj = ts.createProject(path.join(tmp, 'proj'));
  const rpc = spawnEntry();
  childProc = rpc.proc;
  await send(rpc, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'protocol-test', version: '0' } });
  notify(rpc, 'notifications/initialized');

  // 列项目
  const projects = await send(rpc, 'tools/call', { name: 'workbench_list_projects', arguments: {} });
  const pj = JSON.parse(projects.result.content[0].text);
  assert.equal(pj.projects.length, 1);

  // 建任务（mock 执行）
  const created = await send(rpc, 'tools/call', { name: 'workbench_create_task', arguments: { projectId: proj.id, title: 'MCP任务', prompt: '写个文件', agentId: 'mock', mockScript: 'mock-fast' } });
  const task = JSON.parse(created.result.content[0].text);
  assert.ok(task.task.id, '任务已创建');
  assert.equal(JSON.parse(ts.getSession(task.task.id)!.scopeJson).fileWrite, false, 'MCP 未显式授权时默认只读');

  await wait(250);
  // 查询任务
  const got = await send(rpc, 'tools/call', { name: 'workbench_get_task', arguments: { taskId: task.task.id } });
  const gotTask = JSON.parse(got.result.content[0].text);
  assert.ok(['idle', 'completed', 'running'].includes(gotTask.task.status));

  // 事件回读
  const events = await send(rpc, 'tools/call', { name: 'workbench_get_task_events', arguments: { taskId: task.task.id } });
  const ev = JSON.parse(events.result.content[0].text);
  assert.ok(ev.events.length > 0, '事件非空');
  assert.ok(ev.events.some((e: any) => e.type === 'result'), '含结果事件');

  // 读结果
  const res = await send(rpc, 'tools/call', { name: 'workbench_read_task_result', arguments: { taskId: task.task.id } });
  const rr = JSON.parse(res.result.content[0].text);
  assert.ok(rr.result.filesChanged.some((f: any) => f.path === 'mcp-out.txt'));

  // 发消息（继续）
  const messageArgs = { taskId: task.task.id, message: '再跑一轮', clientMsgId: 'mcp-repeat-test' };
  const sent = await send(rpc, 'tools/call', { name: 'workbench_send_message', arguments: messageArgs });
  assert.equal(JSON.parse(sent.result.content[0].text).ok, true);
  const repeated = await send(rpc, 'tools/call', { name: 'workbench_send_message', arguments: messageArgs });
  assert.equal(JSON.parse(repeated.result.content[0].text).duplicate, true);
  assert.equal(ts.listEvents(task.task.id).filter((e) => e.type === 'message' && e.payload.role === 'user' && e.payload.text === '再跑一轮').length, 1);

  // 取消
  const canceled = await send(rpc, 'tools/call', { name: 'workbench_cancel_task', arguments: { taskId: task.task.id } });
  assert.equal(JSON.parse(canceled.result.content[0].text).ok, true);
});

test('MCP：额外只读目录透传、固化与非法范围拒绝', async () => {
  ts.registerMockScript('roots', { id: 'roots', steps: [{ t: 'result', text: 'done' }] });
  const proj = ts.createProject(path.join(tmp, 'roots-project'));
  const external = path.join(tmp, 'skills'); fs.mkdirSync(external);
  const rpc = spawnEntry(); childProc = rpc.proc;
  await send(rpc, 'initialize', { protocolVersion: '2025-06-18' });
  const create = async (extra: any) => {
    const response = await send(rpc, 'tools/call', { name: 'workbench_create_task', arguments: {
      projectId: proj.id, title: '读取范围', prompt: 'done', agentId: 'mock', mockScript: 'roots', ...extra,
    } });
    return JSON.parse(response.result.content[0].text);
  };
  const created = await create({ readRoots: [external], clientRequestId: 'mcp-roots' });
  assert.equal(created.ok, true);
  assert.deepEqual(JSON.parse(ts.getSession(created.task.id)!.scopeJson).readRoots, [fs.realpathSync(external)]);
  assert.equal((await create({ readRoots: [external], clientRequestId: 'mcp-roots' })).task.id, created.task.id);
  assert.equal((await create({ readRoots: [], clientRequestId: 'mcp-roots' })).ok, false);
  for (const readRoots of [['relative'], ['/'], [path.join(tmp, 'missing')]])
    assert.equal((await create({ readRoots })).ok, false);
});

test('MCP：应用未运行时给出明确错误', async () => {
  const rpc = spawnEntry();
  childProc = rpc.proc;
  await send(rpc, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  notify(rpc, 'notifications/initialized');
  control.stop();
  fs.rmSync(path.join(tmp, 'control.json'), { force: true });
  const r = await send(rpc, 'tools/call', { name: 'workbench_list_projects', arguments: {} });
  const parsed = JSON.parse(r.result.content[0].text);
  assert.equal(r.result.isError, true);
  assert.ok(parsed.error.includes('未运行') || parsed.error.includes('未找到'), `明确报错: ${parsed.error}`);
});

test('MCP：建任务携带背景→事件与结果可读→取消（同一运行中服务闭环）', async () => {
  ts.registerMockScript('mock-slow', { id: 'slow', steps: [{ t: 'wait', ms: 1500 }, { t: 'write', relPath: 'out.md', content: '# 结果' }, { t: 'result', text: '完成' }] } as any);
  ts.registerMockScript('mock-bg', { id: 'bg', steps: [{ t: 'write', relPath: 'bg-done.md', content: 'bg done' }, { t: 'result', text: '背景任务完成' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-bg'));
  const rpc = spawnEntry();
  childProc = rpc.proc;
  await send(rpc, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  notify(rpc, 'notifications/initialized');

  // 建任务：提示词携带项目背景（背景传入）
  const created = await send(rpc, 'tools/call', {
    name: 'workbench_create_task',
    arguments: {
      projectId: proj.id, title: '背景闭环任务',
      prompt: '【项目背景】计数页面使用纯 HTML+JS。\n【任务背景快照】根目录 ' + proj.rootPath + '\n【要求】创建 bg-done.md 并说明背景已收到。',
      agentId: 'mock', mockScript: 'mock-bg',
    },
  });
  const task = JSON.parse(created.result.content[0].text).task;
  assert.ok(task.id);
  await wait(300);
  // UI 能看到 = 事件流可读且含用户背景
  const events = await send(rpc, 'tools/call', { name: 'workbench_get_task_events', arguments: { taskId: task.id } });
  const ev = JSON.parse(events.result.content[0].text).events;
  assert.ok(ev.some((e: any) => e.type === 'message' && String(e.payload.text).includes('项目背景')), '背景传入事件流');
  assert.ok(ev.some((e: any) => e.type === 'file_change'), '文件变更可见');
  const res = await send(rpc, 'tools/call', { name: 'workbench_read_task_result', arguments: { taskId: task.id } });
  const rr = JSON.parse(res.result.content[0].text).result;
  assert.ok(['idle', 'completed'].includes(rr.status), `结果可读 status=${rr.status}`);
  // 再建一个并取消
  const slow = await send(rpc, 'tools/call', { name: 'workbench_create_task', arguments: { projectId: proj.id, title: '待取消', prompt: '慢慢做', agentId: 'mock', mockScript: 'mock-slow' } });
  const slowTask = JSON.parse(slow.result.content[0].text).task;
  await wait(100);
  const canceled = await send(rpc, 'tools/call', { name: 'workbench_cancel_task', arguments: { taskId: slowTask.id } });
  assert.equal(JSON.parse(canceled.result.content[0].text).ok, true, '取消成功');
  await wait(80);
  assert.ok(['stopped', 'canceled'].includes(ts.getSession(slowTask.id)!.status), '任务已停止');
});

test('MCP：读取具体授权、拒绝跨任务响应、允许后恢复、重复响应失败',async()=>{
 ts.registerMockScript('perm-noop',{id:'perm-noop',steps:[]});
 const project=ts.createProject(tmp,'permission-test');
 const task=ts.createMainSession({projectId:project.id,title:'permission',agentId:'mock',mockScript:'perm-noop'});
 const waiting=(ts as any).requestPermission(task,'Bash',{command:'git status'});
 const rpc=spawnEntry();childProc=rpc.proc;
 await send(rpc,'initialize',{protocolVersion:'2025-06-18'});
 const call=async(name:string,args:any)=>{
  const r=await send(rpc,'tools/call',{name,arguments:args});return JSON.parse(r.result.content[0].text);
 };
 const list=await call('workbench_list_permissions',{taskId:task.id});
 assert.equal(list.permissions[0].input.command,'git status');
 const permissionId=list.permissions[0].permissionId;
 assert.equal((await call('workbench_respond_permission',{taskId:'wrong',permissionId,decision:'allow'})).ok,false);
 assert.equal((await call('workbench_respond_permission',{taskId:task.id,permissionId,decision:'allow'})).ok,true);
 assert.equal((await waiting).behavior,'allow');
 assert.equal((await call('workbench_respond_permission',{taskId:task.id,permissionId,decision:'allow'})).ok,false);
});
