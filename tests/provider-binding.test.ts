// 阶段一验收：会话供应商隔离（假供应商 A/B，临时 cc-switch 结构库，不使用真实 Key）
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import type { MockScript } from '../src/main/adapters/mock';

let tmp: string;
let ccDb: string;
let wbDb: string;
let store: Store;
let ts: TaskService;
let cm: CredentialManager;

const PROV_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROV_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FAST: MockScript = { id: 'fast', steps: [{ t: 'result', text: '完成' }] };

function insertProvider(id: string, name: string, model: string, key: string, isCurrent = 0) {
  const db = new DatabaseSync(ccDb);
  db.prepare(`INSERT INTO providers(id,app_type,name,settings_config,is_current,sort_index) VALUES (?,?,?,?,?,?)`)
    .run(id, 'claude', name, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://fake.example/api', ANTHROPIC_MODEL: model, ANTHROPIC_AUTH_TOKEN: key } }), isCurrent, isCurrent ? 0 : 1);
  db.close();
}
function deleteProvider(id: string) {
  const db = new DatabaseSync(ccDb);
  db.prepare('DELETE FROM providers WHERE id=?').run(id);
  db.close();
}
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-prov-'));
  ccDb = path.join(tmp, 'cc-switch.db');
  wbDb = path.join(tmp, 'wb.db');
  const db = new DatabaseSync(ccDb);
  db.exec(`CREATE TABLE providers(
    id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
    is_current INTEGER DEFAULT 0, sort_index INTEGER DEFAULT 0)`);
  db.close();
  insertProvider(PROV_A, 'Fake A', 'model-a', 'TEST-KEY-A', 1);
  insertProvider(PROV_B, 'Fake B', 'model-b', 'TEST-KEY-B');
  cm = new CredentialManager(ccDb, { ttlMs: 0 });
  store = new Store(wbDb);
  ts = new TaskService(store, cm);
  ts.importModelProfiles(); // Synthetic fixtures represent already configured installations.
  ts.broadcast = () => {};
  ts.registerMockScript('fast', FAST);
});

afterEach(() => {
  ts.shutdown();
  try { store.close(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('单任务显式供应商不改默认；后续省略供应商仍沿用原默认', async () => {
  store.setKV('defaultProviderId', PROV_A);
  const proj = ts.createProject(path.join(tmp, 'defaults'));
  const explicit = ts.createMainSession({ projectId: proj.id, title: '临时选 B', agentId: 'mock', mockScript: 'fast', providerId: PROV_B });
  assert.equal(explicit.providerId, PROV_B);
  assert.equal(store.getKV('defaultProviderId'), PROV_A);
  const next = ts.createMainSession({ projectId: proj.id, title: '沿用默认', agentId: 'mock', mockScript: 'fast' });
  assert.equal(next.providerId, PROV_A);
  ts.setDefaultTaskCombo('claude-code', PROV_B, 'model-b');
  const configured = ts.createMainSession({ projectId: proj.id, title: '显式保存的 Agent 默认', agentId: 'claude-code' });
  assert.equal(configured.providerId, PROV_B);
  assert.equal(configured.model, 'model-b');
  assert.equal(store.getKV('defaultProviderId'), PROV_A);
});

test('新任务绑定显式供应商；旧任务继续时绑定不变', async () => {
  const proj = ts.createProject(path.join(tmp, 'p1'));
  const sA = ts.createMainSession({ projectId: proj.id, title: '任务A', agentId: 'mock', mockScript: 'fast', providerId: PROV_A });
  assert.equal(sA.providerId, PROV_A);
  await wait(60);
  // 切换默认到 B：再建一个 B 任务
  const sB = ts.createMainSession({ projectId: proj.id, title: '任务B', agentId: 'mock', mockScript: 'fast', providerId: PROV_B });
  assert.equal(sB.providerId, PROV_B);
  // 继续旧任务 A：绑定不变
  await ts.send(sA.id, '继续');
  await wait(60);
  const r = ts.resolveSessionProvider(sA.id);
  assert.ok(r.ok && r.providerId === PROV_A, `继续后仍绑定A: ${JSON.stringify(r)}`);
  assert.equal(ts.getSession(sA.id)!.providerId, PROV_A);
});

test('委派子任务继承父任务供应商与模型；重启恢复后绑定保留', async () => {
  const proj = ts.createProject(path.join(tmp, 'p2'));
  const main = ts.createMainSession({ projectId: proj.id, title: '主A', agentId: 'mock', mockScript: 'fast', providerId: PROV_A, model: 'model-a-custom' });
  await wait(50);
  // 切换默认到 B
  ts.createMainSession({ projectId: proj.id, title: '切换用B', agentId: 'mock', mockScript: 'fast', providerId: PROV_B });
  // 模拟应用退出/重开
  ts.shutdown(); store.close();
  store = new Store(wbDb);
  cm = new CredentialManager(ccDb, { ttlMs: 0 });
  ts = new TaskService(store, cm);
  ts.importModelProfiles(); // Synthetic fixtures represent already configured installations.
  ts.broadcast = () => {};
  ts.registerMockScript('fast', FAST);
  ts.restoreOnStartup();
  const mainRow = ts.getSession(main.id)!;
  assert.equal(mainRow.providerId, PROV_A, '重启后仍绑定A');
  assert.equal(mainRow.model, 'model-a-custom', '模型绑定保留');
  // 重启后继续 + 委派：子任务继承 A
  await ts.send(main.id, '继续');
  await wait(50);
  const sub = await ts.delegate(main.id, { title: '子任务', instructions: 'x', mock_script: 'fast' } as any);
  assert.ok(sub.ok && sub.taskId);
  const subRow = ts.getSession(sub.taskId!)!;
  assert.equal(subRow.providerId, PROV_A, '子任务继承父任务供应商A（而非默认B）');
  assert.equal(subRow.model, 'model-a-custom', '子任务继承模型');
  const r = ts.resolveSessionProvider(sub.taskId!);
  assert.ok(r.ok && r.providerId === PROV_A);
});

test('供应商被删除：继续该任务明确失败，不回退到其他供应商', async () => {
  const proj = ts.createProject(path.join(tmp, 'p3'));
  const sReal = ts.createMainSession({ projectId: proj.id, title: '真实A', agentId: 'claude-code', providerId: PROV_A });
  ts.createMainSession({ projectId: proj.id, title: 'B仍可用', agentId: 'mock', mockScript: 'fast', providerId: PROV_B });
  deleteProvider(PROV_A);
  const r = await ts.send(sReal.id, '你好');
  assert.ok(!r.ok, '发送被阻止');
  assert.ok(r.needsProvider === true, '标记需要重新绑定');
  assert.ok((r.error ?? '').includes('不存在') || (r.error ?? '').includes('重新选择'), `明确报错: ${r.error}`);
  assert.ok(!(r.error ?? '').includes('Fake B'), '报错不含回退供应商');
  // 未产生用户消息与运行时（真实调用被阻止）
  const evs = ts.listEvents(sReal.id);
  assert.ok(!evs.some((e) => e.type === 'message'), '未追加用户消息');
  assert.equal(ts.getSession(sReal.id)!.status, 'idle', '未进入运行状态');
});

test('旧数据 provider 为空：阻止真实调用并提示选择；用户确认绑定后可继续', async () => {
  const proj = ts.createProject(path.join(tmp, 'p4'));
  const sLegacy = ts.createMainSession({ projectId: proj.id, title: '旧任务', agentId: 'claude-code', providerId: PROV_A });
  // 模拟旧库：清空绑定
  const db = new DatabaseSync(wbDb);
  db.prepare('UPDATE sessions SET provider_id=NULL WHERE id=?').run(sLegacy.id);
  db.close();
  const r = await ts.send(sLegacy.id, 'hi');
  assert.ok(!r.ok && r.needsProvider, '旧任务被阻止');
  assert.ok((r.error ?? '').includes('选择'), `提示选择: ${r.error}`);
  // 用户显式绑定 B 后可发送（mock 不启动，仅验证放行链路）——改回绑定 A 失效场景：绑定到 B
  const bind = ts.bindSessionProvider(sLegacy.id, PROV_B);
  assert.ok(bind.ok, `绑定成功: ${bind.error}`);
  assert.equal(ts.getSession(sLegacy.id)!.providerId, PROV_B);
  const r2 = ts.resolveSessionProvider(sLegacy.id);
  assert.ok(r2.ok && r2.providerId === PROV_B);
});

test('凭据轮换对同一供应商生效；不把 Key 快照写入会话', async () => {
  const proj = ts.createProject(path.join(tmp, 'p5'));
  const s = ts.createMainSession({ projectId: proj.id, title: '轮换', agentId: 'claude-code', providerId: PROV_A });
  const env1 = cm.buildSessionEnv(PROV_A)!;
  assert.equal(env1['ANTHROPIC_AUTH_TOKEN'], 'TEST-KEY-A');
  // 轮换 Key（同一 providerId）
  const db = new DatabaseSync(ccDb);
  db.prepare('UPDATE providers SET settings_config=? WHERE id=?')
    .run(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://fake.example/api', ANTHROPIC_MODEL: 'model-a', ANTHROPIC_AUTH_TOKEN: 'TEST-KEY-A2' } }), PROV_A);
  db.close();
  const env2 = cm.buildSessionEnv(PROV_A)!;
  assert.equal(env2['ANTHROPIC_AUTH_TOKEN'], 'TEST-KEY-A2', '新调用使用轮换后的凭据');
  // 会话记录不含 Key（SessionRow 与事件均无）
  const row = JSON.stringify(ts.getSession(s.id));
  assert.ok(!row.includes('TEST-KEY-A'), '会话行不含Key');
  for (const e of ts.listEvents(s.id)) assert.ok(!JSON.stringify(e).includes('TEST-KEY-A'), '事件不含Key');
});
