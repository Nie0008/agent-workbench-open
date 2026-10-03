import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AdapterEvent } from '../src/shared/types';
import type { AgentSessionOpts } from '../src/main/adapters/types';
import { buildAppServerEnvironment, ZCodeSession, nativeAskRuleset, seedNativeAskRules, seedNativeAskRulesWithRetry } from '../src/main/adapters/zcode';

class FakeZCodeAppServer {
  constructor(private modelId = 'glm-5.3-flash', private reasoningLevel: string | null = 'max') {}
  requests: Array<{ method: string; params: any }> = [];
  notifications: Array<{ method: string; params: any }> = [];
  requestHandler: ((method: string, params: any) => Promise<any>) | null = null;
  notifyHandler: ((method: string, params: any) => void) | null = null;
  stopSend: (() => void) | null = null;
  onFakeCall: (() => void) | null = null;

  setRequestHandler(handler: (method: string, params: any) => Promise<any>) { this.requestHandler = handler; }
  setNotifyHandler(handler: (method: string, params: any) => void) { this.notifyHandler = handler; }
  async close() {}

  async request(method: string, params: any = {}): Promise<any> {
    this.requests.push({ method, params });
    if (method === 'session/create') {
      if (!params.model || typeof params.model !== 'object' || params.model.providerId !== 'cc-glm' || params.model.modelId !== this.modelId
        || (this.reasoningLevel && (params.model.options?.reasoningLevel !== this.reasoningLevel || params.thoughtLevel !== this.reasoningLevel))) {
        throw new Error('Invalid params — model: expected ModelSelection with reasoningLevel');
      }
      await this.requestHandler?.('session/requestRuntimePreferences', { sessionId: 'sess_new' });
      return { session: { sessionId: 'sess_new' } };
    }
    if (method === 'session/resume') return { session: { sessionId: params.sessionId } };
    if (method === 'session/read') return { settings: { model: { current: {
      providerId: 'cc-glm', modelId: this.modelId, ...(this.reasoningLevel ? { options: { reasoningLevel: this.reasoningLevel } } : {}),
    } } } };
    if (method === 'session/send') {
      assert.deepEqual(params.modelSelection, {
        providerId: 'cc-glm', modelId: this.modelId,
        ...(this.reasoningLevel ? { options: { reasoningLevel: this.reasoningLevel } } : {}),
      });
      this.onFakeCall?.();
      this.stopSend = () => {};
      if (params.content !== 'cancel') setTimeout(() => { void this.emitTurn(params.content); }, 0);
      // Mirrors the installed app-server: session/send only acknowledges that
      // the asynchronous prompt was accepted; terminal status comes as event.
      return { accepted: true };
    }
    if (method === 'session/stop') { this.stopSend?.(); return {}; }
    return {};
  }

  private async emitTurn(content: string) {
    if (content !== 'first' && content !== 'second') return;
    this.notifyHandler?.('session/event', { type: 'part.delta', payload: { field: 'text', delta: `answer-${content}` } });
    this.notifyHandler?.('session/event', { type: 'permission.requested', payload: { toolCallId: 'tool-1', toolName: 'Write', input: { file_path: 'x' } } });
    const decision = await this.requestHandler?.('interaction/requestPermission', {
      toolCallId: 'tool-1', toolName: 'Write', input: { file_path: 'x' }, reason: 'write file',
    });
    this.notifications.push({ method: 'permission-decision', params: decision });
    this.notifyHandler?.('session/event', { type: 'tool.updated', payload: {
      kind: 'result', toolCallId: 'tool-1', toolName: 'Write', result: { success: true, content: 'saved' },
    } });
    this.notifyHandler?.('session/event', { type: 'turn.completed', payload: {
      response: `answer-${content}`, resultType: 'success', usage: { inputTokens: 10, outputTokens: 4 },
    } });
  }
}

const fixtureOpts = (patch: Partial<AgentSessionOpts> = {}, events: AdapterEvent[] = [], endings: string[] = []): AgentSessionOpts => ({
  taskId: 'task-1', providerId: 'provider-fixed', cwd: '/tmp/project', model: 'glm-5.3-flash',
  reasoningLevel: 'max',
  env: { ANTHROPIC_MODEL: 'glm-5.3-flash', ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'never-print-this-secret' },
  canUseTool: async () => ({ behavior: 'allow' }),
  onEvent: (e) => events.push(e), onEnd: (r) => endings.push(r), ...patch,
});

function fakeRuntime(server: FakeZCodeAppServer, verified = true) {
  const noop = async () => {};
  const stats = { requests: 0, modelMatches: 0, rejectedModels: 0, failedRequests: 0, received: 0, unexpectedPath: null as string | null };
  server.onFakeCall = () => { stats.requests++; if (verified) stats.modelMatches++; };
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-zcode-fake-'));
    const dbPath = path.join(dir, 'db.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE local_setting(scope TEXT, scope_id TEXT, namespace TEXT, key TEXT, value TEXT,
        schema_version INTEGER, time_created INTEGER, time_updated INTEGER,
        PRIMARY KEY(scope, scope_id, namespace, key));
      INSERT INTO session(id, project_id) VALUES ('sess_new', 'proj-fake'), ('sess_existing', 'proj-fake');`);
    db.close();
    return {
      config: { dataDir: dir, storageDir: dir, sessionDbPath: dbPath, personalConfig: '/fixture/personal.json', tempDir: dir },
      bridge: { server: {} as any, url: 'http://127.0.0.1:1', token: 'fake-local-token', snapshot: () => ({ ...stats }), close: noop },
      connection: server,
      close: async () => { fs.rmSync(dir, { recursive: true, force: true }); },
    };
  };
}

function waitFor(predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = () => predicate() ? resolve() : Date.now() - start > 2000 ? reject(new Error('timed out waiting for fake app-server')) : setTimeout(poll, 2);
    poll();
  });
}

test('app-server sends streamed text, interactive permission requests and usage; sends followups in same session', async () => {
  const events: AdapterEvent[] = [];
  const endings: string[] = [];
  const server = new FakeZCodeAppServer();
  const opts = fixtureOpts({}, events, endings);
  const session = new ZCodeSession(opts, fakeRuntime(server));
  await session.send('first');
  await assert.rejects(() => session.send('overlap'), /仍在运行/);
  await waitFor(() => endings.length === 1);
  assert.equal(session.nativeSessionId(), 'sess_new');
  assert.deepEqual(server.requests.find((r) => r.method === 'session/create')?.params.model, {
    providerId: 'cc-glm', modelId: 'glm-5.3-flash', options: { reasoningLevel: 'max' },
  });
  assert.equal(server.requests.find((r) => r.method === 'session/create')?.params.thoughtLevel, 'max');
  await session.send('second');
  await waitFor(() => endings.length === 2);
  assert.equal(server.requests.filter((r) => r.method === 'session/create').length, 1);
  assert.equal(server.requests.filter((r) => r.method === 'session/send').length, 2);
  assert.ok(events.some((e) => e.kind === 'text_delta' && e.text === 'answer-first'));
  assert.ok(events.some((e) => e.kind === 'tool_use' && e.name === 'Write'));
  assert.ok(events.some((e) => e.kind === 'tool_result' && e.content === 'saved'));
  assert.ok(events.some((e) => e.kind === 'usage' && e.usage.input_tokens === 10));
  assert.deepEqual(server.notifications.filter((n) => n.method === 'permission-decision').map((n) => n.params.decision), ['allow', 'allow']);
  assert.deepEqual(endings, ['done', 'done']);
  await session.close();
});

test('app-server resumes existing native session without creating another', async () => {
  const server = new FakeZCodeAppServer();
  const endings: string[] = [];
  const session = new ZCodeSession(fixtureOpts({ resumeNativeSessionId: 'sess_existing' }, [], endings), fakeRuntime(server));
  await session.send('second');
  await waitFor(() => server.requests.some((r) => r.method === 'session/send'));
  await waitFor(() => endings.length === 1);
  assert.equal(session.nativeSessionId(), 'sess_existing');
  assert.ok(server.requests.some((r) => r.method === 'session/resume' && r.params.sessionId === 'sess_existing'));
  assert.ok(server.requests.some((r) => r.method === 'session/setModel' && r.params.model.modelId === 'glm-5.3-flash'));
  assert.ok(server.requests.some((r) => r.method === 'session/setThoughtLevel' && r.params.thoughtLevel === 'max'));
  assert.equal(server.requests.some((r) => r.method === 'session/create'), false);
  await session.close();
});

test('app-server sends a second catalog model without a fixed GLM selection', async () => {
  const server = new FakeZCodeAppServer('second-model', null);
  const endings: string[] = [];
  const opts = fixtureOpts({ model: 'second-model', reasoningLevel: undefined,
    env: { ANTHROPIC_MODEL: 'second-model', ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'FAKE' } }, [], endings);
  const session = new ZCodeSession(opts, fakeRuntime(server));
  try {
    await session.send('first');
    await waitFor(() => endings.length === 1);
    const created = server.requests.find((item) => item.method === 'session/create')?.params;
    assert.deepEqual(created.model, { providerId: 'cc-glm', modelId: 'second-model' });
    assert.equal(created.thoughtLevel, undefined);
    assert.deepEqual(endings, ['done']);
  } finally { await session.close(); }
});

test('does not report a successful GLM result unless the local bridge verified this turn', async () => {
  const events: AdapterEvent[] = [];
  const endings: Array<{ reason: string; error?: string }> = [];
  const server = new FakeZCodeAppServer();
  const opts = fixtureOpts({ onEvent: (e) => events.push(e), onEnd: (reason, error) => endings.push({ reason, error }) });
  const session = new ZCodeSession(opts, fakeRuntime(server, false));
  await session.send('first');
  await waitFor(() => endings.length === 1);
  assert.equal(endings[0].reason, 'error');
  assert.match(endings[0].error ?? '', /没有得到所选模型/);
  assert.equal(events.some((e) => e.kind === 'result' && !e.isError), false);
  await session.close();
});

test('unavailable Workbench permission handler denies, and interruptions stop the native turn', async () => {
  const events: AdapterEvent[] = [];
  const endings: string[] = [];
  const server = new FakeZCodeAppServer();
  const opts = fixtureOpts({ canUseTool: undefined }, events, endings);
  const session = new ZCodeSession(opts, fakeRuntime(server));
  const pending = session.send('cancel');
  while (!server.stopSend) await new Promise((resolve) => setTimeout(resolve, 1));
  await session.interrupt();
  await pending;
  assert.ok(server.requests.some((r) => r.method === 'session/stop'));
  assert.equal(endings.at(-1), 'interrupted');
  await session.close();
});

test('failed setup redacts credential-bearing errors', async () => {
  const events: AdapterEvent[] = [];
  const endings: Array<{ reason: string; error?: string }> = [];
  const opts = fixtureOpts({ onEvent: (e) => events.push(e), onEnd: (reason, error) => endings.push({ reason, error }) });
  const brokenRuntime = async () => { throw new Error(`setup failed: ${opts.env.ANTHROPIC_AUTH_TOKEN}`); };
  const session = new ZCodeSession(opts, brokenRuntime);
  await session.send('fail');
  await waitFor(() => endings.length === 1);
  assert.equal(endings[0].reason, 'error');
  assert.ok(!endings[0].error?.includes(opts.env.ANTHROPIC_AUTH_TOKEN));
  assert.ok(endings[0].error?.includes('[REDACTED]'));
});

test('packaged Electron launches the CLI as Node and strips credentials from app-server env', () => {
  const env = buildAppServerEnvironment({
    HOME: '/private/home', PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'secret-token', WORKBENCH_GLM_KEY: 'other-secret',
  }, {
    dataDir: '/workbench/data', storageDir: '/workbench/storage', sessionDbPath: '/workbench/storage/db.sqlite',
    personalConfig: '/private/personal.json', tempDir: '/private/tmp',
  }, '/ZCode/Resources/config/provider/zcode-builtin.json', true);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.ZCODE_SESSION_DB_PATH, '/workbench/storage/db.sqlite');
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, '/private/personal.json');
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env));
  assert.ok(!('WORKBENCH_GLM_KEY' in env));
});

// 复现并锁定"同一 ZCode tool_request 后出现 11 条同内容 permission_request"的成因：
// app-server 在授权未决时会重发 interaction/requestPermission（同 toolCallId，协议重试）。
// 适配器必须把 toolCallId 透传给统一策略（去重合并为一条逻辑待授权与一个决定），
// 且 tool_use 事件只发一次；批准后所有重试拿到同一 allow，底层工具只执行一次。
test('re-delivered interaction/requestPermission (same toolCallId) reaches canUseTool 11 times with one tool_use event', async () => {
  const events: AdapterEvent[] = [];
  const endings: string[] = [];
  const seenToolUseIds: Array<string | undefined> = [];
  let resolveDecision!: (v: any) => void;
  const decisionPromise = new Promise<any>((r) => { resolveDecision = r; });
  let calls = 0;
  const server = new FakeZCodeAppServer();
  const opts = fixtureOpts({
    canUseTool: async (toolName: string, input: any, ctx?: { toolUseId?: string }) => {
      calls++;
      seenToolUseIds.push(ctx?.toolUseId);
      return await decisionPromise;   // 挂起：模拟用户尚未决定，app-server 持续重发
    },
  }, events, endings);
  const session = new ZCodeSession(opts, fakeRuntime(server));
  void session.send('first');
  await waitFor(() => calls >= 1);
  // 同一 toolCallId 再重发 10 次（合计 11 次，同 input）；不逐个 await——它们都挂在未决决定上
  for (let i = 0; i < 10; i++) {
    void server.requestHandler?.('interaction/requestPermission', {
      toolCallId: 'tool-1', toolName: 'Write', input: { file_path: 'x' }, reason: 'write file',
    });
  }
  await waitFor(() => calls >= 11);
  assert.ok(seenToolUseIds.every((id) => id === 'tool-1'), '统一策略收到原生 toolCallId');
  assert.equal(events.filter((e) => e.kind === 'tool_use' && e.name === 'Write').length, 1,
    '同一原生调用的 tool_use 事件只发一次');
  // 批准一次：原始请求（emitTurn 内）继续，回合正常完成，工具只产生一个 result
  resolveDecision({ behavior: 'allow' });
  await waitFor(() => endings.length === 1);
  assert.equal(events.filter((e) => e.kind === 'tool_result' && e.name === 'Write').length, 1,
    '工具只执行一次（单个 tool.updated result）');
  assert.deepEqual(endings, ['done']);
  await session.close();
});

// ZCode 原生读权限钩子：ask 规则种子写入 app-server 隔离库的 local_setting 表
test('seedNativeAskRules upserts project ask ruleset for the session workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-zcode-seed-'));
  try {
    const dbPath = path.join(dir, 'db.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE local_setting(scope TEXT, scope_id TEXT, namespace TEXT, key TEXT, value TEXT,
        schema_version INTEGER, time_created INTEGER, time_updated INTEGER,
        PRIMARY KEY(scope, scope_id, namespace, key));`);
    db.prepare(`INSERT INTO session(id, project_id) VALUES ('sess-1', 'proj-9')`).run();
    db.close();
    assert.equal(seedNativeAskRules(dbPath, 'sess-1'), true);
    assert.equal(seedNativeAskRules(dbPath, 'sess-1'), true, '重复注入幂等');
    const check = new DatabaseSync(dbPath);
    const row: any = check.prepare(`SELECT value FROM local_setting WHERE scope='project' AND namespace='permission' AND key='ruleset'`).get();
    check.close();
    assert.deepEqual(JSON.parse(row.value), JSON.parse(nativeAskRuleset()));
    assert.ok(JSON.parse(row.value).ask.some((r: any) => r.toolName === 'Read'));
    assert.ok(JSON.parse(row.value).ask.some((r: any) => r.toolName === 'WebFetch'));
    assert.ok(JSON.parse(row.value).ask.some((r: any) => r.toolName === 'WebSearch'));
    // 未知会话：不写入、返回 false
    assert.equal(seedNativeAskRules(dbPath, 'sess-missing'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seedNativeAskRules uses the sole project mode before app-server persists a session row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-zcode-pre-send-'));
  try {
    const dbPath = path.join(dir, 'db.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE local_setting(scope TEXT, scope_id TEXT, namespace TEXT, key TEXT, value TEXT,
        schema_version INTEGER, time_created INTEGER, time_updated INTEGER,
        PRIMARY KEY(scope, scope_id, namespace, key));
      INSERT INTO local_setting VALUES ('project','project-before-send','permission','mode','{"mode":"build"}',1,1,1);`);
    db.close();
    assert.equal(seedNativeAskRules(dbPath, 'unpersisted-session'), true);
    const check = new DatabaseSync(dbPath);
    const row: any = check.prepare(`SELECT scope_id,value FROM local_setting WHERE key='ruleset'`).get();
    assert.equal(row.scope_id, 'project-before-send');
    assert.deepEqual(JSON.parse(row.value), JSON.parse(nativeAskRuleset()));
    check.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 权限响应必须携带 ask 规则 permissionUpdates（读类工具原生钩子的兜底注入通道）
test('permission responses carry ask-rule permissionUpdates for read tools', async () => {
  const events: AdapterEvent[] = [];
  const endings: string[] = [];
  const server = new FakeZCodeAppServer();
  const opts = fixtureOpts({}, events, endings);
  const session = new ZCodeSession(opts, fakeRuntime(server));
  void session.send('first');
  await waitFor(() => endings.length === 1);   // 回合完成后连接仍可用，直接查宿主响应
  const resp = await server.requestHandler?.('interaction/requestPermission', {
    toolCallId: 't-rw', toolName: 'Write', input: { file_path: 'x' }, reason: 'w',
  });
  assert.equal(resp.decision, 'allow');
  assert.ok(Array.isArray(resp.permissionUpdates) && resp.permissionUpdates.length === 1);
  assert.equal(resp.permissionUpdates[0].type, 'addRules');
  assert.equal(resp.permissionUpdates[0].behavior, 'ask');
  assert.ok(resp.permissionUpdates[0].rules.some((r: any) => r.toolName === 'Read'));
  await session.close();
});

// session 行晚于 create 响应持久化的竞态：重试种子在行出现后成功并回调
test('seedNativeAskRulesWithRetry succeeds once the session row appears', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-zcode-retry-'));
  try {
    const dbPath = path.join(dir, 'db.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE local_setting(scope TEXT, scope_id TEXT, namespace TEXT, key TEXT, value TEXT,
        schema_version INTEGER, time_created INTEGER, time_updated INTEGER,
        PRIMARY KEY(scope, scope_id, namespace, key));`);
    db.close();
    let seeded = false;
    const seed = seedNativeAskRulesWithRetry(dbPath, 'sess-late', 20, 1500);
    await new Promise((r) => setTimeout(r, 120));   // 模拟 app-server 稍后写入 session 行
    const db2 = new DatabaseSync(dbPath);
    db2.prepare(`INSERT INTO session(id, project_id) VALUES ('sess-late', 'proj-late')`).run();
    db2.close();
    seeded = await seed;
    assert.equal(seeded, true, 'session 行出现后种子成功');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
