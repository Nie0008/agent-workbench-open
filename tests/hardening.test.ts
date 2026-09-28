// 阶段四加固测试：背景快照机制、回环控制通道鉴权、工作区路径边界
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService, compactEvent } from '../src/main/taskService';
import { ControlServer } from '../src/main/controlServer';
import { writeTextFile, isInside, buildBackgroundSnapshot } from '../src/main/files';
import type { MockScript } from '../src/main/adapters/mock';

let tmp: string;
let store: Store;
let ts: TaskService;
const FAST: MockScript = { id: 'fast', steps: [{ t: 'result', text: '完成' }] };

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-hard-'));
  store = new Store(path.join(tmp, 'wb.db'));
  ts = new TaskService(store, new CredentialManager());
  ts.broadcast = () => {};
  ts.registerMockScript('fast', FAST);
});

afterEach(() => {
  ts.shutdown();
  try { store.close(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('背景快照：内容内联、sha 版本、未提交补丁进入子任务提示词', async () => {
  const projDir = path.join(tmp, 'proj-git');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'base.txt'), 'committed\n');
  execFileSync('git', ['init', '-q'], { cwd: projDir });
  execFileSync('git', ['add', '.'], { cwd: projDir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: projDir });
  // 主任务未提交改动（子任务 worktree 看不到，必须靠快照补丁传递）：修改 tracked 文件 + 新增 untracked 文件
  fs.writeFileSync(path.join(projDir, 'base.txt'), 'committed\nuncommitted-change\n');
  fs.writeFileSync(path.join(projDir, 'index.html'), '<h1>计数器 v2 未提交</h1>\n');
  const proj = ts.createProject(projDir);
  const main = ts.createMainSession({ projectId: proj.id, title: '主', agentId: 'mock', mockScript: 'fast', providerId: undefined });
  await wait(50);
  const r = await ts.delegate(main.id, {
    title: '审查', instructions: '审查 index.html',
    context_files: ['index.html', 'base.txt'],
    acceptance: '三项全过',
  } as any);
  assert.ok(r.ok && r.taskId);
  await wait(80);
  const sub = ts.getSession(r.taskId!)!;
  const del = JSON.parse(sub.delegationJson!);
  assert.ok(del.snapshot, '委派记录包含快照元数据');
  assert.equal(del.snapshot.isGit, true);
  assert.ok(del.snapshot.head, '记录 HEAD 版本');
  const idx = del.snapshot.files.find((f: any) => f.path === 'index.html');
  assert.ok(idx?.included && idx.sha256.length === 16, 'index.html 内联且有版本 sha');
  const firstUser = ts.listEvents(sub.id).find((e) => e.type === 'message' && e.payload.role === 'user')!;
  const text: string = firstUser.payload.text;
  assert.ok(text.includes('背景快照'), '提示词含背景快照段');
  assert.ok(text.includes('计数器 v2 未提交'), '文件内容内联进提示词');
  assert.ok(text.includes('diff --git'), '主树未提交补丁内联进提示词');
  assert.ok(text.includes(`HEAD ${del.snapshot.head}`), '标注版本基线');
  assert.ok(text.includes('三项全过'), '验收标准在提示词中');
});

test('背景快照：私密文件被排除、超限文件截断、二进制跳过', () => {
  const projDir = path.join(tmp, 'proj-snap');
  fs.mkdirSync(path.join(projDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(projDir, '.env.local'), 'TOP_SECRET=1');
  fs.writeFileSync(path.join(projDir, 'server.key'), '-----BEGIN');
  fs.writeFileSync(path.join(projDir, 'big.txt'), 'x'.repeat(40 * 1024));
  fs.writeFileSync(path.join(projDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(projDir, 'ok.txt'), 'normal');
  const { meta, sections } = buildBackgroundSnapshot(projDir, ['.env.local', 'server.key', 'big.txt', 'bin.dat', 'ok.txt', '../outside.txt']);
  const byPath = new Map(meta.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('.env.local')!.included, false, '.env 被排除');
  assert.equal(byPath.get('server.key')!.included, false, 'key 被排除');
  assert.ok(byPath.get('big.txt')!.truncated, '大文件标记截断');
  assert.equal(byPath.get('bin.dat')!.included, true, '二进制保留元数据');
  assert.ok(!sections.includes('TOP_SECRET'), '私密内容不出现');
  assert.ok(!sections.includes('-----BEGIN'), '密钥内容不出现');
  assert.ok(sections.includes('截断至前'), '大文件截断标注');
  assert.ok(sections.includes('二进制文件'), '二进制标注跳过内容');
  assert.ok(sections.includes('normal'), '普通文件内联');
  assert.ok(byPath.get('../outside.txt')!.included === false, '越界路径拒绝');
});

test('回环控制通道：错误令牌返回 401，正确令牌可用', async () => {
  const control = new ControlServer(ts);
  const info = await control.start(path.join(tmp, 'control.json'));
  const post = (auth: string) => new Promise<{ code: number; body: string }>((resolve) => {
    const body = JSON.stringify({ method: 'app.info' });
    const req = http.request({
      host: '127.0.0.1', port: info.port, method: 'POST', path: '/v1/rpc', agent: false,
      headers: { 'content-type': 'application/json', authorization: auth, 'content-length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ code: res.statusCode ?? 0, body: d }));
    });
    req.on('error', () => resolve({ code: 0, body: '' }));
    req.end(body);
  });
  const bad = await post('Bearer wrong-token');
  assert.equal(bad.code, 401, '错误令牌 401');
  const good = await post(`Bearer ${info.token}`);
  assert.equal(good.code, 200, '正确令牌 200');
  const noAuth = await post('');
  assert.equal(noAuth.code, 401, '无令牌 401');
  control.stop();
});

test('工作区路径边界：越界读写被拒绝', () => {
  const root = path.join(tmp, 'proj-bound');
  fs.mkdirSync(root, { recursive: true });
  writeTextFile(root, 'ok.txt', 'fine');
  assert.ok(isInside(root, path.join(root, 'a/b.txt')));
  assert.ok(!isInside(root, path.join(tmp, 'outside.txt')));
  assert.throws(() => writeTextFile(root, '../escape.txt', 'nope'), /超出项目范围/, '相对越界写拒绝');
  assert.throws(() => writeTextFile(root, path.join(tmp, 'abs-escape.txt'), 'nope'), /超出项目范围/, '绝对越界写拒绝');
  assert.ok(fs.existsSync(path.join(tmp, 'escape.txt')) === false, '越界文件未被创建');
});

// 真实策略入口＋适配器完成事件：同一 Agent 连续编辑不应被自己的旧 mtime 拦住。
async function guardedEditingSession() {
  const root = path.join(tmp, 'edit-project');
  fs.mkdirSync(root);
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'base');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: root });
  fs.writeFileSync(file, 'prior-turn');
  const project = ts.createProject(root);
  const session = ts.createMainSession({ projectId: project.id, title: 'edit', agentId: 'mock', mockScript: 'fast', prompt: 'x', scope: { fileWrite: true } });
  await wait(80); // 完成一轮，由真实 sweepFileChanges 建立基线
  const policySession = { ...ts.getSession(session.id)!, agentId: 'claude-code', scopeJson: JSON.stringify({ fileWrite: true }) };
  const check = (cwd = root) => (ts as any).policyCheck({ ...policySession, cwd }, 'Edit', { file_path: path.join(cwd, 'a.txt') });
  const start = (id: string) => (ts as any).onAdapterEvent(session.id, { kind: 'tool_use', toolUseId: id, name: 'Edit', input: { file_path: file } });
  const end = (id: string, isError = false) => (ts as any).onAdapterEvent(session.id, { kind: 'tool_result', toolUseId: id, isError, content: isError ? 'failed' : 'edited' });
  const change = (text: string, offset: number) => { fs.writeFileSync(file, text); const t = Date.now() / 1000 + offset; fs.utimesSync(file, t, t); };
  return { root, file, session, check, start, end, change };
}

test('连续成功编辑推进基线，但外部改动与重复完成事件不能被吸收', async () => {
  const f = await guardedEditingSession();
  assert.equal((await f.check()).behavior, 'allow');
  f.start('edit-1'); f.change('agent-write', 1); f.end('edit-1');
  assert.equal((await f.check()).behavior, 'allow', '自己的成功编辑之后还能继续编辑');
  f.change('external-write', 2);
  f.end('edit-1'); // 同一个工具结果重放不能更新基线
  assert.equal((await f.check()).behavior, 'deny', '外部修改仍须拦截');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'external-write');
});

test('失败的编辑不产生文件变更事件，也不更新冲突基线', async () => {
  const f = await guardedEditingSession();
  const before = ts.listEvents(f.session.id).filter(e => e.type === 'file_change').length;
  f.start('failed-edit'); f.change('external-before-failure', 1); f.end('failed-edit', true);
  assert.equal(ts.listEvents(f.session.id).filter(e => e.type === 'file_change').length, before);
  assert.equal((await f.check()).behavior, 'deny');
});

test('同项目不同工作目录不共享文件冲突基线', async () => {
  const f = await guardedEditingSession();
  const other = path.join(tmp, 'other-worktree'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'a.txt'), 'isolated-file');
  const t = Date.now() / 1000 + 5; fs.utimesSync(path.join(other, 'a.txt'), t, t);
  assert.equal((await f.check(other)).behavior, 'allow', '主目录基线不能用于隔离目录');
  f.change('external-root-change', 6);
  assert.equal((await f.check()).behavior, 'deny', '原目录保护仍然有效');
});


test('长工具输入的事件可序列化，截断只产生预览且不修改原始记录', () => {
  const input = { content: '中文\"\n'.repeat(500), nested: { keep: true } };
  const event: any = { seq: 1, sessionId: 's', type: 'tool_request', createdAt: '2026-09-15T00:00:00Z', payload: { toolUseId: 't', name: 'Write', input } };
  const compact = compactEvent(event);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(compact)));
  assert.equal(compact.payload.input.truncated, true);
  assert.equal(compact.payload.input.preview.length, 1200);
  assert.equal(compact.payload.input.originalChars, JSON.stringify(input).length);
  assert.equal(compact.payload.toolUseId, 't');
  assert.equal(event.payload.input, input);
  assert.equal(event.payload.input.content.length, 2000);
  const short: any = { ...event, payload: { input: { file_path: 'a.txt' } } };
  assert.deepEqual(compactEvent(short).payload.input, { file_path: 'a.txt' });
});
