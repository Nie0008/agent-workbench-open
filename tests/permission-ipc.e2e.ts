// 独立 Electron 检查：临时数据库与隐藏窗口，不运行正式主进程或真实 Agent。
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerIpc } from '../src/main/ipc';
import { TaskService } from '../src/main/taskService';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { unwrapSendResult } from '../src/renderer/send';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-permission-ipc-'));
console.log(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd(), dataDir: dir, purpose: 'isolated permission IPC check' }));
app.setPath('userData', dir);
app.on('window-all-closed', () => {});
let service: TaskService | undefined, store: Store | undefined;
const windows: BrowserWindow[] = [];
let exitCode = 0;
void (async () => {
try {
  await app.whenReady();
  store = new Store(path.join(dir, 'test.db'));
  service = new TaskService(store, new CredentialManager());
  service.registerMockScript('noop', { id: 'noop', steps: [] });
  const project = service.createProject(dir, 'IPC fixture');
  const task = service.createMainSession({ projectId: project.id, title: 'IPC', agentId: 'mock', mockScript: 'noop' });
  const html = path.join(dir, 'test.html'); fs.writeFileSync(html, '<!doctype html><title>Permission test</title>');
  for (let i = 0; i < 2; i++) {
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.resolve('dist/preload/preload.cjs'), sandbox: true, contextIsolation: true,
    } });
    windows.push(win); await win.loadFile(html);
  }
  registerIpc(service, () => windows[0], dir);
  const result = (service as any).requestPermission(task, 'Bash', { command: 'echo fixture' });
  const pending = service.listPendingPermissions(task.id).permissions![0];
  const invoke = (win: BrowserWindow, data: unknown) => win.webContents.executeJavaScript(
    `window.wb.invoke('permissions.respond', ${JSON.stringify(data)})`);
  const args = { taskId: task.id, permissionId: pending.permissionId, decision: 'allow',
    interaction: { type: 'click', trusted: false } };
  const foreign = await invoke(windows[1], args);
  assert.equal(foreign.ok, false); assert.match(foreign.error, /主窗口/);
  assert.equal(unwrapSendResult(foreign).ok, false);
  const fresh = await invoke(windows[0], args);
  assert.equal(fresh.data.ok, true); assert.equal((await result).behavior, 'allow');
  assert.equal(unwrapSendResult(fresh).ok, true);
  const audit = store.listEvents(task.id).find(e => e.type === 'permission_resolved')!.payload.audit;
  assert.equal(audit.origin.window.id, windows[0].webContents.id);
  assert.equal(audit.origin.window.processId, windows[0].webContents.getOSProcessId());
  assert.equal(audit.origin.window.visible, false);
  assert.equal(audit.origin.interaction.trusted, false);
  assert.equal(audit.actorIdentity, 'unverified');
  assert.ok(fs.readFileSync(path.join(dir, 'main.log'), 'utf8').includes(audit.origin.requestId));

  const old = (service as any).requestPermission(task, 'Bash', { command: 'echo old' });
  const oldPending = service.listPendingPermissions(task.id).permissions![0];
  (service as any).pendingPermissions.get(oldPending.permissionId).expiresAt = new Date(Date.now() - 1).toISOString();
  const stale = await invoke(windows[0], { ...args, permissionId: oldPending.permissionId });
  assert.equal(stale.data.ok, false); assert.match(stale.data.error, /过期/);
  assert.equal(unwrapSendResult(stale).ok, false, 'IPC 传输成功不能显示为批准成功');
  assert.equal((await old).behavior, 'deny');
  assert.equal(store.getSession(task.id)!.status, 'stopped');
  assert.equal(service.listPendingPermissions(task.id).permissions!.length, 0);
  const replay = await invoke(windows[0], { ...args, permissionId: oldPending.permissionId });
  assert.equal(replay.data.ok, false);
  console.log('PASS: Electron IPC 主窗口校验、批准来源与日志关联、旧请求失效、重复点击拒绝');
} catch (error) {
  exitCode = 1; console.error(error);
} finally {
  await service?.shutdown(); store?.close();
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(exitCode);
}
})();
