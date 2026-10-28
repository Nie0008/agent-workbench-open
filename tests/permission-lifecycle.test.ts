import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService, PERMISSION_WAIT_MS } from '../src/main/taskService';
import { ControlServer } from '../src/main/controlServer';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-permission-lifecycle-'));
  const store = new Store(path.join(dir, 'test.db'));
  const service = new TaskService(store, new CredentialManager());
  service.registerMockScript('noop', { id: 'noop', steps: [] });
  const project = service.createProject(dir, 'permission test');
  const task = service.createMainSession({ projectId: project.id, title: 'task', agentId: 'mock', mockScript: 'noop' });
  const calls = { starts: 0, interrupts: 0, closes: 0, sends: 0 };
  (service as any).adapterFor = () => ({ start: () => {
    calls.starts++;
    return { send: async () => { calls.sends++; }, interrupt: async () => { calls.interrupts++; },
      close: async () => { calls.closes++; }, nativeSessionId: () => null };
  } });
  const request = (id = task.id, callId = 'call-1') => (service as any).requestPermission(
    store.getSession(id), 'Bash', { command: 'echo check' }, { toolUseId: callId });
  return { dir, store, service, task, calls, request, async close() {
    await service.shutdown(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  } };
}
const firstPending = (f: ReturnType<typeof fixture>) => f.service.listPendingPermissions(f.task.id).permissions![0];

test('授权等待到期停止执行器、失效全部请求；旧按钮不能恢复，发送新消息才能继续', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = fixture();
  try {
    await f.service.send(f.task.id, 'start');
    const one = f.request(), two = f.request(f.task.id, 'call-2');
    const pending = firstPending(f);
    assert.equal(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt), PERMISSION_WAIT_MS);
    t.mock.timers.tick(PERMISSION_WAIT_MS - 1);
    assert.equal(f.store.getSession(f.task.id)!.status, 'waiting_permission');
    t.mock.timers.tick(1);
    assert.equal((await one).behavior, 'deny'); assert.equal((await two).behavior, 'deny');
    await (f.service as any).runtimes.get(f.task.id)?.closing;
    assert.equal(f.store.getSession(f.task.id)!.status, 'stopped');
    assert.equal(f.service.progress().tasks[0].runtimePresent, false);
    assert.equal(f.calls.interrupts, 1); assert.equal(f.calls.closes, 1);
    assert.equal(f.service.listPendingPermissions(f.task.id).permissions!.length, 0);
    assert.equal(f.store.listEvents(f.task.id).filter(e => e.type === 'permission_resolved'
      && e.payload.decision === 'invalidated').length, 2);
    assert.equal(f.service.respondPermission(pending.permissionId, 'allow', f.task.id, 'ui').ok, false);
    assert.equal(f.calls.sends, 1);
    await f.service.send(f.task.id, 'continue');
    assert.equal(f.calls.starts, 2); assert.equal(f.calls.sends, 2);
    assert.equal(f.service.respondPermission(pending.permissionId, 'allow', f.task.id, 'ui').ok, false);
    assert.equal(f.store.getSession(f.task.id)!.status, 'running');
  } finally { await f.close(); }
});

test('休眠或计时器延迟时，九天前的批准仍被同步拒绝并停止任务', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const f = fixture();
  try {
    await f.service.send(f.task.id, 'start');
    const result = f.request(), pending = firstPending(f);
    t.mock.timers.setTime(Date.now() + 9 * 86400000);
    const response = f.service.respondPermission(pending.permissionId, 'allow', f.task.id, 'ui', {
      transport: 'electron-ipc', requestId: 'late-click',
      interaction: { type: 'click', trusted: true },
    });
    assert.equal(response.ok, false); assert.match(response.error!, /过期/);
    assert.equal((await result).behavior, 'deny');
    assert.equal(f.store.getSession(f.task.id)!.status, 'stopped');
    const rejected = f.store.listEvents(f.task.id).find(e => e.payload.kind === 'permission_response_rejected')!;
    assert.equal(rejected.payload.audit.origin.requestId, 'late-click');
    assert.equal(rejected.payload.audit.actorIdentity, 'unverified');
    assert.equal(f.store.listEvents(f.task.id).some(e => e.type === 'permission_resolved' && e.payload.decision === 'allow'), false);
  } finally { await f.close(); }
});

test('及时批准不会被旧失效计时器停止；批准记录绑定输入、任务和窗口', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = fixture();
  try {
    const result = f.request(), pending = firstPending(f);
    const origin = { transport: 'electron-ipc' as const, requestId: 'click-1',
      window: { id: 7, processId: 42, frameUrl: 'file:///test/index.html', focused: true, visible: true },
      interaction: { type: 'click', trusted: false } };
    assert.equal(f.service.respondPermission(pending.permissionId, 'allow', f.task.id, 'ui', origin).ok, true);
    assert.equal((await result).behavior, 'allow');
    t.mock.timers.tick(PERMISSION_WAIT_MS + 1);
    assert.equal(f.store.getSession(f.task.id)!.status, 'running');
    const event = f.store.listEvents(f.task.id).find(e => e.type === 'permission_resolved')!;
    assert.deepEqual(event.payload.audit.origin, origin);
    assert.equal(event.payload.audit.taskId, f.task.id);
    assert.equal(event.payload.audit.toolUseId, 'call-1');
    assert.ok(event.payload.audit.inputHash); assert.ok(event.payload.audit.responseId);
    assert.equal(event.payload.audit.backendProcessId, process.pid);
    assert.equal(event.payload.audit.actorIdentity, 'unverified');
    const denied = f.request(f.task.id, 'call-deny'), next = firstPending(f);
    assert.equal(f.service.respondPermission(next.permissionId, 'deny', f.task.id, 'control', {
      transport: 'control-http', requestId: 'controller-deny', caller: { name: 'controller' },
    }).ok, true);
    assert.equal((await denied).message, '该操作已被拒绝', '控制端拒绝不能归因于用户本人');
  } finally { await f.close(); }
});

test('外部响应必须绑定任务；HTTP 来源记录请求、地址和客户端白名单，拒绝与重放同样留痕', async () => {
  const f = fixture(), control = new ControlServer(f.service);
  try {
    const info = await control.start(path.join(f.dir, 'control.json'));
    const result = f.request(), pending = firstPending(f);
    const caller = { name: 'test-client', version: '1', sessionId: 'chat-123', pid: 123, parentPid: 122,
      token: 'must-not-record', environment: 'must-not-record', nameTooLong: 'x'.repeat(300) };
    const respond = async (params: any) => (await fetch(`http://127.0.0.1:${info.port}/v1/rpc`, {
      method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'permissions.respond', params, caller }),
    })).json() as Promise<any>;
    assert.equal((await respond({ permissionId: pending.permissionId, decision: 'allow' })).ok, false);
    const other = f.service.createMainSession({ projectId: f.task.projectId, title: 'other', agentId: 'mock', mockScript: 'noop' });
    assert.equal((await respond({ taskId: other.id, permissionId: pending.permissionId, decision: 'allow' })).ok, false);
    assert.equal((await respond({ taskId: f.task.id, permissionId: pending.permissionId, decision: 'allow' })).ok, true);
    assert.equal((await result).behavior, 'allow');
    assert.equal((await respond({ taskId: f.task.id, permissionId: pending.permissionId, decision: 'allow' })).ok, false);
    const events = f.store.listEvents(f.task.id);
    const approval = events.find(e => e.type === 'permission_resolved')!;
    assert.equal(approval.payload.audit.origin.transport, 'control-http');
    assert.ok(approval.payload.audit.origin.remoteAddress); assert.ok(approval.payload.audit.origin.requestId);
    assert.deepEqual(approval.payload.audit.origin.caller,
      { name: 'test-client', version: '1', sessionId: 'chat-123', pid: 123, parentPid: 122 });
    assert.equal(events.filter(e => e.payload.kind === 'permission_response_rejected').length, 3);
    assert.equal(JSON.stringify(events).includes('must-not-record'), false);
  } finally { control.stop(); await f.close(); }
});
