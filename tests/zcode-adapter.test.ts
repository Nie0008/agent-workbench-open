import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AdapterEvent } from '../src/shared/types';
import type { AgentSessionOpts } from '../src/main/adapters/types';
import { buildAppServerEnvironment, ZCodeSession } from '../src/main/adapters/zcode';

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
  return async () => ({
    config: { dataDir: '/fixture/data', storageDir: '/fixture/storage', sessionDbPath: '/fixture/storage/session/db.sqlite', personalConfig: '/fixture/personal.json', tempDir: '/fixture/tmp' },
    bridge: { server: {} as any, url: 'http://127.0.0.1:1', token: 'fake-local-token', snapshot: () => ({ ...stats }), close: noop },
    connection: server,
    close: noop,
  });
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
