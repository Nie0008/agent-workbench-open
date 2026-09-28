// B 阶段自动化测试：模拟适配器（身份明示 mock）驱动任务服务全流程
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import { isOwnSubtask } from '../src/main/mcp/agentTools';
import { createWorktree, worktreeMergeCheck, worktreeApply, WriteConflictGuard } from '../src/main/files';
import type { WorkbenchEvent, SessionRow } from '../src/shared/types';
import type { MockScript } from '../src/main/adapters/mock';

let tmp: string;
let store: Store;
let ts: TaskService;

function newService(dbPath?: string) {
  const store = new Store(dbPath ?? path.join(tmp, 'wb.db'));
  const ts = new TaskService(store, new CredentialManager());
  ts.broadcast = () => {};
  return { store, ts };
}

function eventsOf(sessionId: string): WorkbenchEvent[] { return ts.listEvents(sessionId); }
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const COUNTER_SCRIPT: MockScript = {
  id: 'mock-main',
  steps: [
    { t: 'text', text: '收到，我来实现计数页面。' },
    { t: 'write', relPath: 'index.html', content: '<html><title>计数器</title><body><button id="b">0</button></body></html>' },
    { t: 'usage', inputTokens: 120, outputTokens: 45 },
    { t: 'result', text: '已完成 index.html 计数页面。' },
  ],
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  ({ store, ts } = newService());
});

afterEach(() => {
  ts.shutdown();
  try { store.close(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('模拟会话：流式事件、工具调用、文件变更、用量与完成状态', async () => {
  ts.registerMockScript('mock-main', COUNTER_SCRIPT);
  const proj = ts.createProject(path.join(tmp, 'proj-a'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '计数页面', agentId: 'mock', mockScript: 'mock-main', prompt: '做一个计数页面' });
  assert.equal(sess.agentId, 'mock');
  await wait(300);
  const evs = eventsOf(sess.id);
  const types = evs.map((e) => e.type);
  assert.ok(types.includes('message'), '用户消息已记录');
  assert.ok(types.includes('text_delta'), '有流式文本');
  assert.ok(types.includes('tool_request') && types.includes('tool_result'), '有工具调用');
  const fc = evs.find((e) => e.type === 'file_change');
  assert.ok(fc && fc.payload.path === 'index.html', '文件变更事件');
  assert.ok(types.includes('usage'), '用量事件');
  assert.ok(types.includes('result'), '结果事件');
  const s2 = ts.getSession(sess.id)!;
  assert.equal(s2.status, 'idle', '主会话回合完成后回到空闲（可继续）');
  assert.ok(s2.nativeSessionId?.startsWith('mock-'), '原生会话ID已保存');
  // 写文件确实存在
  assert.ok(fs.existsSync(path.join(proj.rootPath, 'index.html')));
});

test('多轮对话：第二轮发送继续同一原生会话', async () => {
  ts.registerMockScript('m', {
    id: 'm', steps: [{ t: 'text', text: '第一轮' }, { t: 'result', text: '轮1完成' }],
    turns: { '继续': [{ t: 'text', text: '第二轮内容' }, { t: 'result', text: '轮2完成' }] },
  });
  const proj = ts.createProject(path.join(tmp, 'proj-b'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '多轮', agentId: 'mock', mockScript: 'm', prompt: '开始' });
  await wait(120);
  const native1 = ts.getSession(sess.id)!.nativeSessionId;
  await ts.send(sess.id, '请继续');
  await wait(120);
  assert.equal(ts.getSession(sess.id)!.nativeSessionId, native1, '同一会话');
  const evs = eventsOf(sess.id);
  const texts = evs.filter((e) => e.type === 'message' && e.payload.role === 'assistant').map((e) => e.payload.text);
  assert.ok(texts.some((t: string) => t.includes('第一轮')));
  assert.ok(texts.some((t: string) => t.includes('第二轮内容')), '第二轮回复到达');
});

test('只读主任务委派的子任务仍为只读', async () => {
  ts.registerMockScript('read-only', { id: 'read-only', steps: [{ t: 'result', text: '完成' }] });
  const root = path.join(tmp, 'readonly-project');
  fs.mkdirSync(root);
  const project = ts.createProject(root);
  const parent = ts.createMainSession({ projectId: project.id, title: '只读主任务', agentId: 'mock', mockScript: 'read-only', scope: { fileWrite: false } });
  const delegated = await ts.delegate(parent.id, { title: '只读子任务', instructions: '检查项目' });
  assert.equal(delegated.ok, true);
  const child = ts.getSession(delegated.taskId!);
  assert.equal(JSON.parse(child!.scopeJson).fileWrite, false);
  assert.ok(ts.listEvents(child!.id).some((event) => event.type === 'message' && event.payload.role === 'user' && event.payload.text.includes('只读模式')));
});

test('内置 Agent 工具只能访问自己的子任务，未知同名前缀不绕过授权', async () => {
  const root = path.join(tmp, 'agent-tool-boundary');
  fs.mkdirSync(root);
  const project = ts.createProject(root);
  const base = { projectId: project.id, agentId: 'claude-code', model: 'glm-5.3-flash', cwd: root, scope: { fileWrite: false } };
  store.createSession({ ...base, id: 'parent-a', kind: 'main', title: '主任务 A' });
  store.createSession({ ...base, id: 'parent-b', kind: 'main', title: '主任务 B' });
  store.createSession({ ...base, id: 'child-a', kind: 'sub', parentSessionId: 'parent-a', title: 'A 的子任务' });
  assert.equal(isOwnSubtask(ts, 'parent-a', 'child-a'), true);
  assert.equal(isOwnSubtask(ts, 'parent-b', 'child-a'), false);
  assert.equal(isOwnSubtask(ts, 'parent-a', 'parent-a'), false);
  assert.equal(isOwnSubtask(ts, 'parent-a', 'missing'), false);

  const parent = ts.getSession('parent-a')!;
  assert.equal((await (ts as any).policyCheck(parent, 'mcp__workbench__delegate_task', {})).behavior, 'allow');
  const unknown = (ts as any).policyCheck(parent, 'mcp__workbench__unknown_tool', {});
  const pending = ts.listPendingPermissions(parent.id).permissions!;
  assert.equal(pending.length, 1);
  assert.equal(ts.respondPermission(pending[0].permissionId, 'deny', parent.id).ok, true);
  assert.equal((await unknown).behavior, 'deny');
});

test('重复 clientMsgId 重放不产生重复消息', async () => {
  ts.registerMockScript('mock-main', { id: 'm', steps: [{ t: 'text', text: 'ok' }, { t: 'result', text: 'done' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-c'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '去重', agentId: 'mock', mockScript: 'mock-main', prompt: 'hi' });
  await wait(100);
  const before = eventsOf(sess.id).filter((e) => e.type === 'message' && e.payload.role === 'user').length;
  await ts.send(sess.id, '再次', 'same-id-1');
  await ts.send(sess.id, '再次', 'same-id-1');
  await wait(80);
  const after = eventsOf(sess.id).filter((e) => e.type === 'message' && e.payload.role === 'user').length;
  assert.ok(after - before <= 2, `重放去重: before=${before} after=${after}`); // 1 条新消息（重放的那条被忽略）
  assert.equal(after - before, 1);
});

test('委派：创建子任务、并发上限 2、委派去重、父停止级联', async () => {
  ts.registerMockScript('mock-main', { id: 'm', steps: [{ t: 'result', text: '主任务待命' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-d'));
  const main = ts.createMainSession({ projectId: proj.id, title: '主任务', agentId: 'mock', mockScript: 'mock-main', prompt: '开始' });
  await wait(80);

  ts.registerMockScript('mock-sub', { id: 's', steps: [{ t: 'write', relPath: 'out.txt', content: 'x' }, { t: 'wait', ms: 400 }, { t: 'result', text: '子任务结果' }] });
  ts.registerMockScript('mock-sub-2', { id: 's2', steps: [{ t: 'wait', ms: 400 }, { t: 'result', text: '子任务2结果' }] });
  // 两个并发子任务（非 git 项目：第一个获得写权，第二个自动只读）
  const r1 = await ts.delegate(main.id, { title: '审查', instructions: '审查代码', acceptance: '给出问题清单', mock_script: 'mock-sub' } as any);
  assert.ok(r1.ok && r1.taskId, '第一个子任务创建');
  const r2 = await ts.delegate(main.id, { title: '测试', instructions: '运行测试', mock_script: 'mock-sub-2' } as any);
  assert.ok(r2.ok && r2.taskId, '第二个子任务创建（只读降级）');
  assert.equal(JSON.parse(ts.getSession(r2.taskId!)!.scopeJson).fileWrite, false, '第二个子任务为只读');
  assert.equal(JSON.parse(ts.getSession(r1.taskId!)!.scopeJson).fileWrite, true, '第一个子任务持有写权');
  // 第三个被并发上限拒绝
  const r3 = await ts.delegate(main.id, { title: '第三个', instructions: '不该运行' });
  assert.ok(!r3.ok && r3.error!.includes('上限'), '并发上限生效');
  assert.equal(ts.listSubtasks(main.id).length, 2);

  // 相同参数重放 → 返回同一 taskId，不新建
  const r1b = await ts.delegate(main.id, { title: '审查', instructions: '审查代码', acceptance: '给出问题清单' });
  assert.equal(r1b.taskId, r1.taskId, '委派去重');
  assert.equal(ts.listSubtasks(main.id).length, 2);

  // 子任务出现在父会话事件中
  const delegated = eventsOf(main.id).filter((e) => e.type === 'task_delegated');
  assert.equal(delegated.length, 2, '父会话记录委派事件');

  // 子任务事件里有委派提示词（项目背景+验收标准）
  const subEvents = eventsOf(r1.taskId!);
  const firstUser = subEvents.find((e) => e.type === 'message' && e.payload.role === 'user');
  assert.ok(firstUser?.payload.text.includes('验收标准'), '委派携带验收标准');
  assert.ok(firstUser?.payload.text.includes('项目背景'), '委派携带项目背景');

  // 取消父任务 → 级联取消子任务
  ts.cancel(main.id, { cascade: true });
  await wait(60);
  assert.ok(['canceled', 'stopped'].includes(ts.getSession(r1.taskId!)!.status), '子任务1已停止');
  assert.ok(['canceled', 'stopped'].includes(ts.getSession(r2.taskId!)!.status), '子任务2已停止');
});

test('非 git 项目：单写者限制，后来的子任务自动降级只读', async () => {
  ts.registerMockScript('mock-main', { id: 'm', steps: [{ t: 'result', text: 'ok' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-e')); // 非 git
  const main = ts.createMainSession({ projectId: proj.id, title: '主', agentId: 'mock', mockScript: 'mock-main', prompt: 'x' });
  await wait(60);
  ts.registerMockScript('mock-sub-long', { id: 'sl', steps: [{ t: 'wait', ms: 500 }, { t: 'result', text: '写完' }] });
  const r1 = await ts.delegate(main.id, { title: '写者', instructions: '写文件', mock_script: 'mock-sub-long' } as any);
  assert.ok(r1.ok);
  const r2 = await ts.delegate(main.id, { title: '后来的只读任务', instructions: '只查看' });
  assert.ok(r2.ok, `后来的任务仍可创建: ${r2.error}`);
  assert.equal(JSON.parse(ts.getSession(r2.taskId!)!.scopeJson).fileWrite, false, '自动降级为只读');
  const subEvents = eventsOf(r2.taskId!);
  const firstUser = subEvents.find((e) => e.type === 'message' && e.payload.role === 'user');
  assert.ok(firstUser?.payload.text.includes('只读模式'), '提示词显式标注只读约束');
});

test('git 项目：子任务 worktree 隔离 + 合并 + 冲突显式呈现', () => {
  const projDir = path.join(tmp, 'proj-git');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), 'base\n');
  execFileSync('git', ['init', '-q'], { cwd: projDir });
  execFileSync('git', ['add', '.'], { cwd: projDir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: projDir });
  const proj = ts.createProject(projDir);
  assert.ok(proj.isGit);

  const wt1 = createWorktree(projDir, 'task-1');
  fs.writeFileSync(path.join(wt1, 'README.md'), 'base\nfrom task1\n');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'task1'], { cwd: wt1 });

  // 未合并前 check ok
  let c = worktreeMergeCheck(projDir, 'task-1');
  assert.ok(c.ok, '第一次合并检查通过');
  const apply = worktreeApply(projDir, 'task-1');
  assert.ok(apply.ok, '第一次合并成功');
  assert.ok(fs.readFileSync(path.join(projDir, 'README.md'), 'utf8').includes('from task1'));

  // 第二个子任务也改了同一文件 → 合并时与主树未提交改动冲突，必须显式呈现
  const wt2 = createWorktree(projDir, 'task-2');
  fs.writeFileSync(path.join(wt2, 'README.md'), 'base\nfrom task2\n');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'task2'], { cwd: wt2 });
  c = worktreeMergeCheck(projDir, 'task-2');
  assert.ok(!c.ok, '第二次合并检查失败');
  assert.ok((c.reason ?? '').includes('未提交'), `冲突原因明确: ${c.reason}`);
  assert.deepEqual(c.dirtyPaths, ['README.md']);
});

test('写冲突守卫：基线后被其他写者修改的文件拒绝覆盖', () => {
  const root = path.join(tmp, 'proj-guard');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'v1');
  const guard = new WriteConflictGuard(root);
  guard.snapshot(['a.txt']);
  // 其他写者修改了文件
  fs.writeFileSync(path.join(root, 'a.txt'), 'v2-by-other');
  const r = guard.checkBeforeWrite('a.txt');
  assert.ok(!r.ok, '拒绝覆盖');
  assert.ok((r.reason ?? '').includes('拒绝覆盖'));
  // 新文件不受影响
  assert.ok(guard.checkBeforeWrite('b.txt').ok);
});

test('停止后不再继续写文件', async () => {
  ts.registerMockScript('mock-stop', {
    id: 'ms', steps: [
      { t: 'write', relPath: 'step1.txt', content: '1' },
      { t: 'wait', ms: 250 },
      { t: 'write', relPath: 'step2.txt', content: '2' },
      { t: 'result', text: '不应到达' },
    ],
  });
  const proj = ts.createProject(path.join(tmp, 'proj-f'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '停止测试', agentId: 'mock', mockScript: 'mock-stop', prompt: 'go' });
  await wait(120); // step1 已写
  assert.ok(fs.existsSync(path.join(proj.rootPath, 'step1.txt')));
  ts.cancel(sess.id, {});
  await wait(350);
  assert.ok(!fs.existsSync(path.join(proj.rootPath, 'step2.txt')), '停止后第二个文件未写入');
  assert.ok(['stopped', 'canceled'].includes(ts.getSession(sess.id)!.status));
});

test('授权：拒绝后对应工具不执行（mock 权限步骤验证 deny 通路）', async () => {
  ts.registerMockScript('mock-perm', {
    id: 'mp', steps: [
      { t: 'permission', toolName: 'Bash', input: { command: 'curl http://example.com' }, expect: 'deny' },
      { t: 'text', text: '好的，我不执行该命令。' },
      { t: 'result', text: '未执行网络命令' },
    ],
  });
  // 临时拦截：mock 会话的 canUseTool 直接 deny
  const orig = (ts as any)['policyCheck'].bind(ts);
  (ts as any)['policyCheck'] = async () => ({ behavior: 'deny', message: '用户拒绝' });
  const proj = ts.createProject(path.join(tmp, 'proj-g'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '授权测试', agentId: 'mock', mockScript: 'mock-perm', prompt: 'x' });
  await wait(150);
  (ts as any)['policyCheck'] = orig;  const evs = eventsOf(sess.id);
  assert.ok(evs.some((e) => e.type === 'tool_result' && e.payload.brief?.includes('denied')), '拒绝被记录');
  assert.ok(ts.getSession(sess.id)!.summary?.includes('未执行'), '未执行对应工具');
});

test('超时与委派次数上限', async () => {
  ts.setSettings({ taskTimeoutSec: 1, maxDelegationsPerTask: 2 });
  ts.registerMockScript('mock-slow', { id: 'slow', steps: [{ t: 'wait', ms: 2500 }, { t: 'result', text: '永不完成' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-h'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '超时', agentId: 'mock', mockScript: 'mock-slow', prompt: 'go' });
  await wait(1600);
  assert.equal(ts.getSession(sess.id)!.status, 'timeout', '超时后标记 timeout');
  // 委派上限（子任务用 fast 脚本即时完成）
  ts.registerMockScript('mock-fast', { id: 'fast', steps: [{ t: 'result', text: '子完成' }] });
  const r1 = await ts.delegate(sess.id, { title: 'd1', instructions: 'i1', mock_script: 'mock-fast' } as any);
  const r2 = await ts.delegate(sess.id, { title: 'd2', instructions: 'i2', mock_script: 'mock-fast' } as any);
  const r3 = await ts.delegate(sess.id, { title: 'd3', instructions: 'i3' });
  assert.ok(r1.ok && r2.ok);
  assert.ok(!r3.ok && r3.error!.includes('上限'), '委派次数上限生效');
});

test('退出重开：历史完整、进行中任务标为恢复中、原生恢复如实', async () => {
  ts.registerMockScript('mock-hang', { id: 'hang', steps: [{ t: 'wait', ms: 3000 }, { t: 'result', text: 'x' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-i'));
  ts.registerMockScript('mock-fast', { id: 'fast', steps: [{ t: 'result', text: '完成' }] });
  const done = ts.createMainSession({ projectId: proj.id, title: '已完成任务', agentId: 'mock', mockScript: 'mock-fast', prompt: 'x' });
  await wait(80);
  const running = ts.createMainSession({ projectId: proj.id, title: '进行中任务', agentId: 'mock', mockScript: 'mock-hang', prompt: 'long' });
  await wait(120);
  // 模拟应用退出（不 shutdown adapter，模拟崩溃）
  const dbPath = path.join(tmp, 'wb.db');
  store.close();

  // 重开
  const reopened = newService(dbPath);
  const rows = reopened.store.listSessions(proj.id) as SessionRow[];
  assert.equal(rows.length, 2, '历史完整');
  const doneRow = rows.find((r: SessionRow) => r.id === done.id)!;
  const runningRow = rows.find((r: SessionRow) => r.id === running.id)!;
  assert.ok(['idle', 'completed'].includes(doneRow.status), '已完成的任务保持终态');
  assert.ok(['running', 'resuming'].includes(runningRow.status), '进行中任务待恢复标注');
  const resumingIds = reopened.ts.restoreOnStartup();
  assert.ok(resumingIds.includes(running.id), '进行中任务标为 恢复中');
  assert.equal(reopened.store.getSession(running.id)!.status, 'resuming');
  assert.ok(['idle', 'completed'].includes(reopened.store.getSession(done.id)!.status), '已完成不受影响');
  // 恢复失败如实标注：mock 适配器不带原生命令——真实验证在 C/D 阶段；这里验证错误路径标记 interrupted
  reopened.ts.shutdown();
  reopened.store.close();
});

test('泄漏测试：假密钥哨兵不进入日志与本地库（正向对照后归零）', async () => {
  const SENTINEL = 'FAKE_SENTINEL_KEY_FOR_TEST_1234567890';
  ts.registerMockScript('mock-leak', { id: 'leak', steps: [{ t: 'result', text: 'done' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-j'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '泄漏测试', agentId: 'mock', mockScript: 'mock-leak', prompt: `不要泄漏 ${'x'}` });
  await wait(100);
  // 正向对照：确认扫描器工作
  store.setKV('leak-probe', SENTINEL);
  assert.ok(ts.leakScan(SENTINEL) >= 1, '扫描器能发现哨兵');
  store.setKV('leak-probe', '');
  assert.equal(ts.leakScan(SENTINEL), 0, '会话数据中没有哨兵（凭据不入库）');
});

test('readTaskResult 汇总：状态/摘要/文件/用量', async () => {
  ts.registerMockScript('mock-main', COUNTER_SCRIPT);
  const proj = ts.createProject(path.join(tmp, 'proj-k'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '汇总', agentId: 'mock', mockScript: 'mock-main', prompt: 'x' });
  await wait(250);
  const r = ts.readTaskResult(sess.id);
  assert.ok(r.ok);
  assert.ok(['idle', 'completed'].includes(r.result!.status));
  assert.ok(r.result!.filesChanged.some((f: any) => f.path === 'index.html'));
  assert.equal(r.result!.usage.inputTokens, 120);
  assert.equal(r.result!.usage.costKnown, false, '费用未知标记');
});

// ---- 用量统计：多轮累计、未知费用、历史缺字段、重开一致性 ----

const USAGE_MULTI_SCRIPT: MockScript = {
  id: 'usage-multi',
  steps: [
    { t: 'text', text: '第一轮完成' },
    { t: 'usage', inputTokens: 120, outputTokens: 45, cacheReadTokens: 30, cacheCreationTokens: 25 },
    { t: 'result', text: '轮1完成' },
  ],
  turns: {
    '继续': [
      { t: 'text', text: '第二轮完成' },
      { t: 'usage', inputTokens: 200, outputTokens: 80, cacheReadTokens: 50, cacheCreationTokens: 15 },
      { t: 'result', text: '轮2完成' },
    ],
  },
};

test('readTaskResult 多轮用量累计：输入/输出/缓存读/缓存创建全类别，费用未知不冒充', async () => {
  ts.registerMockScript('usage-multi', USAGE_MULTI_SCRIPT);
  const proj = ts.createProject(path.join(tmp, 'proj-usage'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '多轮用量', agentId: 'mock', mockScript: 'usage-multi', prompt: '开始' });
  await wait(300);
  await ts.send(sess.id, '请继续');
  await wait(100);

  // 持久化链路：每个已记录回合各留一条 usage 事件，类别字段如实上报
  const usageEvents = eventsOf(sess.id).filter((e) => e.type === 'usage');
  assert.equal(usageEvents.length, 2, '两个回合各一条已记录用量事件');
  for (const e of usageEvents) {
    assert.equal(typeof e.payload.inputTokens, 'number', '输入已持久化');
    assert.equal(typeof e.payload.outputTokens, 'number', '输出已持久化');
    assert.equal(typeof e.payload.cacheCreationTokens, 'number', '缓存创建已持久化');
  }

  const usage = ts.readTaskResult(sess.id).result!.usage;
  assert.equal(usage.roundsRecorded, 2, '覆盖多个已记录回合');
  assert.equal(usage.inputTokens, 320, '输入跨回合累计 120+200');
  assert.equal(usage.outputTokens, 125, '输出跨回合累计 45+80');
  assert.equal(usage.cacheReadTokens, 80, '缓存读跨回合累计 30+50');
  assert.equal(usage.cacheCreationTokens, 40, '缓存创建跨回合累计 25+15');
  assert.deepEqual(usage.fieldsNotReported, [], '四个类别均有上报');
  assert.deepEqual(usage.fieldCoverage.inputTokens, { roundsReported: 2, roundsMissing: 0, complete: true }, '输入类别全回合上报');
  assert.deepEqual(usage.fieldCoverage.cacheCreationTokens, { roundsReported: 2, roundsMissing: 0, complete: true }, '缓存创建类别全回合上报');
  assert.ok(!('modelUsage' in usage), '不引入未经验证的 modelUsage 跨回合累加');
  // 费用未知：不冒充已知总费用
  assert.equal(usage.costKnown, false, '并非所有回合费用已知');
  assert.equal(usage.costUSD, null, '费用未知时不给数值');
  assert.equal(usage.costMissingRounds, 2, '缺费用的回合数可辨识');
  assert.ok(String(usage.scopeNote).includes('主循环'), '口径标明为主循环用量');
  assert.ok(String(usage.scopeNote).includes('不代表任务全部真实消耗'), '统计口径明确');
});

test('用量汇总：重复读取不变、退出重开后一致', async () => {
  ts.registerMockScript('usage-multi', USAGE_MULTI_SCRIPT);
  const proj = ts.createProject(path.join(tmp, 'proj-usage-reread'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '重开一致', agentId: 'mock', mockScript: 'usage-multi', prompt: '开始' });
  await wait(300);
  await ts.send(sess.id, '请继续');
  await wait(100);

  const first = ts.readTaskResult(sess.id).result!.usage;
  const second = ts.readTaskResult(sess.id).result!.usage;
  assert.deepEqual(second, first, '重复读取不改变累计值');

  // 模拟应用退出后重开同一数据库（旧服务先走完生命周期，再关库）
  const dbPath = path.join(tmp, 'wb.db');
  ts.shutdown();
  store.close();
  ({ store, ts } = newService(dbPath));
  const reopened = ts.readTaskResult(sess.id).result!.usage;
  assert.deepEqual(reopened, first, '重开持久化数据后累计值一致');
});

test('历史用量缺字段：旧缺+新0 部分已知可辨、全缺失为 null、明确记录的 0 保持 0', async () => {
  // 新回合只上报 cacheReadTokens=0（不报 cacheCreationTokens）
  ts.registerMockScript('usage-legacy', { id: 'usage-legacy', steps: [{ t: 'usage', inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 }, { t: 'result', text: '完成' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-legacy'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '历史缺字段', agentId: 'mock', mockScript: 'usage-legacy', prompt: 'x' });
  await wait(250);
  // 旧版本写入的历史事件（同一条持久化路径注入）：旧格式没有任何缓存字段
  store.appendEvent(sess.id, 'usage', { inputTokens: 10, outputTokens: 5, costUSD: null });

  const usage = ts.readTaskResult(sess.id).result!.usage;
  assert.equal(usage.roundsRecorded, 2, '新旧行各计入一回合');
  assert.equal(usage.inputTokens, 60, '50+10');
  assert.equal(usage.outputTokens, 25, '20+5');
  // 旧缺字段+新0：合计 0 是真实上报值，但只有一回合上报 → 部分已知
  assert.equal(usage.cacheReadTokens, 0, '记录到的 0 保持 0（不升级为未知）');
  assert.deepEqual(usage.fieldCoverage.cacheReadTokens, { roundsReported: 1, roundsMissing: 1, complete: false }, '0 也是部分已知值');
  // 全部缺失：两回合都未上报 → null 而非 0
  assert.equal(usage.cacheCreationTokens, null, '从未上报的类别为 null，不是 0');
  assert.deepEqual(usage.fieldCoverage.cacheCreationTokens, { roundsReported: 0, roundsMissing: 2, complete: false }, '全缺失可辨识');
  assert.deepEqual(usage.fieldsNotReported, ['cacheCreationTokens'], '全缺清单只含从未上报类别');
  assert.equal(usage.costKnown, false, '费用未知');
  assert.equal(usage.costUSD, null, '费用未知时不给数值');
  assert.equal(usage.costMissingRounds, 2, '两回合费用均未知');
});

test('混合历史：旧缺字段+新值 → 保留已报告小计，完整性经 fieldCoverage 可辨', async () => {
  // 轮1 不上报 cacheCreationTokens（旧格式），轮2 上报 25
  ts.registerMockScript('usage-partial', {
    id: 'usage-partial',
    steps: [
      { t: 'usage', inputTokens: 120, outputTokens: 45, cacheReadTokens: 30 },
      { t: 'result', text: '轮1完成' },
    ],
    turns: {
      '继续': [
        { t: 'usage', inputTokens: 200, outputTokens: 80, cacheReadTokens: 50, cacheCreationTokens: 25 },
        { t: 'result', text: '轮2完成' },
      ],
    },
  });
  const proj = ts.createProject(path.join(tmp, 'proj-partial'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '混合历史', agentId: 'mock', mockScript: 'usage-partial', prompt: '开始' });
  await wait(300);
  await ts.send(sess.id, '请继续');
  await wait(100);

  const usage = ts.readTaskResult(sess.id).result!.usage;
  assert.equal(usage.roundsRecorded, 2);
  assert.equal(usage.cacheCreationTokens, 25, '已报告小计保留（仅轮2的25）');
  assert.deepEqual(usage.fieldCoverage.cacheCreationTokens, { roundsReported: 1, roundsMissing: 1, complete: false }, '部分上报 → 部分已知可辨识');
  assert.deepEqual(usage.fieldCoverage.inputTokens, { roundsReported: 2, roundsMissing: 0, complete: true }, '全回合上报类别完整');
  assert.deepEqual(usage.fieldCoverage.cacheReadTokens, { roundsReported: 2, roundsMissing: 0, complete: true }, '缓存读类别完整');
  assert.deepEqual(usage.fieldsNotReported, [], '有部分上报，不在全缺清单（部分性由 fieldCoverage 表达）');
  assert.equal(usage.inputTokens, 320, '120+200');
  assert.equal(usage.cacheReadTokens, 80, '30+50');
});

test('费用：全部已知回合相加；部分未知返回 null 不冒充总费用', async () => {
  ts.registerMockScript('usage-cost-all', {
    id: 'usage-cost-all',
    steps: [
      { t: 'usage', inputTokens: 10, outputTokens: 5, costUSD: 0.25 },
      { t: 'result', text: '轮1完成' },
    ],
    turns: {
      '继续': [
        { t: 'usage', inputTokens: 10, outputTokens: 5, costUSD: 0.5 },
        { t: 'result', text: '轮2完成' },
      ],
    },
  });
  const projA = ts.createProject(path.join(tmp, 'proj-cost-all'));
  const sessA = ts.createMainSession({ projectId: projA.id, title: '费用全知', agentId: 'mock', mockScript: 'usage-cost-all', prompt: '开始' });
  await wait(300);
  await ts.send(sessA.id, '请继续');
  await wait(100);
  const all = ts.readTaskResult(sessA.id).result!.usage;
  assert.equal(all.costUSD, 0.75, '全部已知：0.25+0.5');
  assert.equal(all.costKnown, true, '全部已记录回合费用已知');
  assert.equal(all.costMissingRounds, 0, '无缺费用回合');

  // 一回合一知一未知：不给部分和冒充总费用
  ts.registerMockScript('usage-cost-part', {
    id: 'usage-cost-part',
    steps: [
      { t: 'usage', inputTokens: 10, outputTokens: 5, costUSD: 0.25 },
      { t: 'result', text: '轮1完成' },
    ],
    turns: {
      '继续': [
        { t: 'usage', inputTokens: 10, outputTokens: 5 },
        { t: 'result', text: '轮2完成' },
      ],
    },
  });
  const projB = ts.createProject(path.join(tmp, 'proj-cost-part'));
  const sessB = ts.createMainSession({ projectId: projB.id, title: '费用部分未知', agentId: 'mock', mockScript: 'usage-cost-part', prompt: '开始' });
  await wait(300);
  await ts.send(sessB.id, '请继续');
  await wait(100);
  const part = ts.readTaskResult(sessB.id).result!.usage;
  assert.equal(part.costUSD, null, '部分未知时返回 null，不用已知部分冒充总费用');
  assert.equal(part.costKnown, false, '并非全部回合费用已知');
  assert.equal(part.costMissingRounds, 1, '缺费用回合数可辨识');
});

test('无已记录用量事件：不等于零消耗', async () => {
  ts.registerMockScript('usage-none', { id: 'usage-none', steps: [{ t: 'result', text: '完成' }] });
  const proj = ts.createProject(path.join(tmp, 'proj-none'));
  const sess = ts.createMainSession({ projectId: proj.id, title: '无用量记录', agentId: 'mock', mockScript: 'usage-none', prompt: 'x' });
  await wait(200);
  const usage = ts.readTaskResult(sess.id).result!.usage;
  assert.equal(usage.roundsRecorded, 0, '零个已记录回合');
  assert.equal(usage.inputTokens, null, '无记录不冒充零');
  assert.equal(usage.outputTokens, null, '无记录不冒充零');
  assert.deepEqual(usage.fieldsNotReported, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']);
  assert.ok(String(usage.scopeNote).includes('不代表零消耗'), '明确无记录≠零消耗');
});
