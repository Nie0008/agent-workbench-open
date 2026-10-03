// Optional macOS GUI check. Uses an isolated database and never calls a model.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/test-desktop.mjs [packaged executable] [result.json]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-desktop-'));
const projectDir = path.join(dataDir, 'project');
fs.mkdirSync(projectDir);
fs.writeFileSync(path.join(projectDir, 'draft.txt'), 'saved file content\n');
fs.writeFileSync(path.join(projectDir, 'second.txt'), 'saved second content\n');
// A persisted mock task can execute its built-in fake adapter without credentials or a model.
const fixtureTaskId = 'desktop-fixture';
const fixtureTitle = 'Desktop fixture';
const db = new DatabaseSync(path.join(dataDir, 'workbench.db'));
db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root_path TEXT,is_git INTEGER,created_at TEXT);
 CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,parent_session_id TEXT,title TEXT,
 agent_id TEXT,model TEXT,status TEXT,native_session_id TEXT,cwd TEXT,scope_json TEXT,delegation_json TEXT,
 summary TEXT,created_at TEXT,updated_at TEXT);`);
const createdAt = new Date().toISOString();
db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('fixture','Desktop fixture',projectDir,0,createdAt);
db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fixtureTaskId,'fixture','main',null,
 fixtureTitle,'mock','fixture','idle',null,projectDir,'{"fileWrite":true}',null,null,createdAt,createdAt);
db.close();
const executablePath = process.argv[2] || path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const args = process.argv[2] ? [] : [root];
const appRoot = process.argv[2] ? path.resolve(path.dirname(executablePath), '..', 'Resources', 'app') : root;
const env = { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_DEBUG: '1', WORKBENCH_SKIP_RESTORE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_SKIP_LOCK;
delete env.WORKBENCH_SKIP_WINDOW;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = id => { try { process.kill(id, 0); return true; } catch { return false; } };
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
let electron, duplicate;
try {
  electron = await _electron.launch({ executablePath, args, env, timeout: 30000 });
  let page;
  const currentPage = async () => {
    await until(() => !!electron.windows().find(candidate => !candidate.isClosed()), 'new renderer page');
    const next = electron.windows().find(candidate => !candidate.isClosed());
    // Playwright forces pages to look focused; restore native visibility on every new renderer.
    const cdp = await electron.context().newCDPSession(next);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await next.getByRole('button', { name: '收起到菜单栏', exact: true }).waitFor();
    return next;
  };
  page = await currentPage();
  const { port, token, pid } = JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8'));
  const rawRpc = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(5000),
    });
    return response.json();
  };
  const rpc = async (method, params = {}) => {
    const result = await rawRpc(method, params);
    assert.notEqual(result.ok, false, result.error);
    return result;
  };
  const state = async () => (await rpc('app.window')).desktop;
  const listThroughMcp = async () => {
    const child = spawn(process.execPath, [path.join(appRoot, 'dist/main/mcp/entry.js'), '--control', path.join(dataDir, 'control.json')], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, signal: AbortSignal.timeout(5000) });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop-test', version: '1' } } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workbench_list_tasks', arguments: { projectId: 'fixture' } } }) + '\n');
      for await (const line of lines) {
        const reply = JSON.parse(line);
        if (reply.id !== 2) continue;
        assert.equal(reply.error, undefined);
        const value = JSON.parse(reply.result.content.find(item => item.type === 'text').text);
        assert.equal(value.ok, true);
        return value.tasks;
      }
      throw new Error('Background MCP response timed out');
    } finally { lines.close(); child.stdin.end(); child.kill(); }
  };
  const identity = () => electron.evaluate(({ BrowserWindow, app }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { mainPid: process.pid, windowId: win?.id ?? null, rendererPid: win?.webContents.getOSProcessId() ?? null,
      processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, memory: metric.memory })) };
  });
  const show = async () => {
    await rpc('app.window', { action: 'show' });
    await until(async () => (await state()).windowVisible && (await state()).dockVisible, 'new visible window and Dock');
    page = await currentPage();
    assert.equal((await identity()).mainPid, pid, 'main process survives renderer replacement');
  };
  const hidden = async (old, label) => {
    await until(async () => !(await state()).windowPresent && !(await state()).dockVisible, label);
    await until(() => !alive(old.rendererPid), 'old renderer exits');
    assert.equal(old.mainPid, pid);
    assert.equal((await identity()).mainPid, pid);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  };
  const reconstruct = async label => {
    const old = await identity();
    await rpc('app.window', { action: 'hide' });
    await hidden(old, label);
    await show();
    assert.notEqual((await identity()).windowId, old.windowId);
  };
  assert.equal(typeof (await rpc('memory.nightly.status')).status?.processedTurns, 'number');
  const pollingCount = () => (fs.readFileSync(path.join(dataDir, 'main.log'), 'utf8').match(/\[ipc\] tasks\.progress 完成/g) || []).length;
  assert.equal((await state()).trayReady, true);
  await until(async () => (await state()).windowVisible, 'initial window');
  await until(async () => pollingCount() > 0, 'initial board refresh');
  await page.getByRole('textbox', { name: '搜索项目或任务' }).fill('retained board search');
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await page.waitForFunction(title => document.querySelector('.chat-head .ht')?.textContent === title, fixtureTitle);
  await page.locator('.composer textarea').fill('unsent conversation draft');
  // Delay A through the real handler, navigate to B, then let the old A read finish.
  await electron.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('files.read');
    if (typeof original !== 'function') throw new Error('Missing files.read handler');
    globalThis.__desktopFileRead = original;
    ipcMain.removeHandler('files.read');
    ipcMain.handle('files.read', async (event, payload) => {
      if (payload.path === 'draft.txt') {
        await new Promise(resolve => { globalThis.__desktopReleaseReadA = resolve; });
        const result = await original(event, payload);
        globalThis.__desktopReadACompleted = true;
        return result;
      }
      return original(event, payload);
    });
  });
  try {
    await page.locator('.node').filter({ hasText: 'draft.txt' }).click();
    await until(() => electron.evaluate(() => typeof globalThis.__desktopReleaseReadA === 'function'), 'file A read is held');
    assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).isEnabled(), false, 'cannot edit a file whose read has not completed');
    await page.locator('.viewer-head').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.node').filter({ hasText: 'second.txt' }).click();
    await page.getByText('saved second content', { exact: true }).waitFor();
    assert.equal(await page.locator('.viewer-head .path').textContent(), 'second.txt');
    await electron.evaluate(() => globalThis.__desktopReleaseReadA());
    await until(() => electron.evaluate(() => globalThis.__desktopReadACompleted === true), 'old A handler finishes');
    await page.evaluate(() => window.wb.waitForRequests());
    assert.equal(await page.locator('.viewer-head .path').textContent(), 'second.txt');
    assert.equal(await page.locator('.readview').textContent(), 'saved second content\n', 'old A response never replaces current B content');
    await page.locator('.viewer-head').getByRole('button', { name: '关闭', exact: true }).click();
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      globalThis.__desktopReleaseReadA?.();
      ipcMain.removeHandler('files.read'); ipcMain.handle('files.read', globalThis.__desktopFileRead);
      delete globalThis.__desktopFileRead; delete globalThis.__desktopReleaseReadA; delete globalThis.__desktopReadACompleted;
    });
  }
  await page.locator('.node').filter({ hasText: 'draft.txt' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('textarea.editor').fill('unsaved file edit');
  await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click();
  await page.getByPlaceholder('例如：制作一个计数页面').fill('unfinished task title');
  await page.getByPlaceholder('描述目标、要求与验收标准…').fill('unfinished task requirement');
  await page.locator('#fw').check();
  await page.locator('.modal').filter({ has: page.getByRole('heading', { name: '新建任务', exact: true }) }).locator('select').first().selectOption('readonly');
  const openMemory = await identity();
  // The task form covers the toolbar; use the public control action for this snapshot.
  await rpc('app.window', { action: 'hide' });
  await hidden(openMemory, 'toolbar releases window and hides Dock');
  const hiddenMemory = await identity();
  assert.equal(page.isClosed(), true, 'old Playwright page closes with renderer');
  await delay(300);
  const before = pollingCount();
  await delay(5500);
  assert.equal(pollingCount(), before, 'no board poll while renderer is absent');
  assert.equal((await rpc('tasks.list')).tasks.some(task => task.id === fixtureTaskId), true, 'background tasks.list remains available');
  assert.equal((await listThroughMcp()).some(task => task.id === fixtureTaskId), true, 'stdio MCP works with no renderer');
  const rejectedCreate = await rawRpc('task.create', { projectId: 'missing-fixture', title: 'must not start a model' });
  assert.equal(rejectedCreate.ok, false);
  assert.match(rejectedCreate.error, /项目不存在/, 'task.create validates its request without a renderer');
  // The built-in mock adapter exercises persistence and main-process notices with no renderer or provider.
  const sent = await rpc('task.send', { taskId: fixtureTaskId, message: 'background mock turn', clientMsgId: 'desktop-background-turn' });
  assert.equal(sent.ok, true);
  await until(async () => (await rpc('task.result', { taskId: fixtureTaskId })).result.status === 'idle', 'background mock turn completes');
  await show();
  const reopenedMemory = await identity();
  assert.notEqual(reopenedMemory.windowId, openMemory.windowId);
  assert.notEqual(reopenedMemory.rendererPid, openMemory.rendererPid);
  assert.equal(await page.getByPlaceholder('例如：制作一个计数页面').inputValue(), 'unfinished task title');
  assert.equal(await page.getByPlaceholder('描述目标、要求与验收标准…').inputValue(), 'unfinished task requirement');
  assert.equal(await page.locator('#fw').isChecked(), true);
  assert.equal(await page.locator('.modal').filter({ has: page.getByRole('heading', { name: '新建任务', exact: true }) }).locator('select').first().inputValue(), 'readonly');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'unsent conversation draft');
  assert.equal(await page.locator('textarea.editor').inputValue(), 'unsaved file edit');
  assert.equal(fs.readFileSync(path.join(projectDir, 'draft.txt'), 'utf8'), 'saved file content\n', 'unsaved file draft is restored without writing the file');
  const notices = await page.evaluate(async () => window.wb.invoke('notices.list'));
  assert.equal(notices.ok, true);
  assert.equal(notices.data.some(notice => notice.taskId === fixtureTaskId), true, 'backend notices survive absent renderer');
  const acknowledged = await page.evaluate(async taskId => window.wb.invoke('notices.ack', { taskId }), fixtureTaskId);
  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.data.some(notice => notice.taskId === fixtureTaskId), false);
  await page.getByRole('button', { name: /^任务看板/ }).click();
  assert.equal(await page.getByRole('textbox', { name: '搜索项目或任务' }).inputValue(), 'retained board search');
  await until(() => pollingCount() > before, 'board refreshes on reconstruction');
  const closeIdentity = await identity();
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await hidden(closeIdentity, 'red close releases renderer');
  // Control entry is the same cold-window opening path as an OS notification click.
  await rpc('app.openTask', { taskId: fixtureTaskId });
  page = await currentPage();
  await page.waitForFunction(title => document.querySelector('.chat-head .ht')?.textContent === title
    && !document.querySelector('.task-board'), fixtureTitle);
  assert.equal((await identity()).mainPid, pid);
  const minimizeIdentity = await identity();
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await hidden(minimizeIdentity, 'yellow minimize releases renderer');
  // A second native launch must reopen the first instance, then exit.
  duplicate = spawn(executablePath, args, { env, stdio: 'ignore' });
  await until(() => duplicate.exitCode !== null, 'duplicate instance exits');
  assert.equal(duplicate.exitCode, 0);
  await until(async () => (await state()).windowVisible && !(await state()).windowMinimized, 'duplicate launch reopens');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8')).pid, pid);
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  page = await currentPage();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'unsent conversation draft');
  // Test-only snapshot failure; exercise the real hide path without adding an application endpoint.
  await page.evaluate(() => {
    window.__desktopSavedSnapshot = window.__workbenchWindowSnapshot;
    window.__workbenchWindowSnapshot = () => { throw new Error('fixture snapshot failure'); };
  });
  await electron.evaluate(({ dialog }) => {
    globalThis.__desktopMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__desktopSaveError = options.message;
      return { response: 0, checkboxChecked: false };
    };
  });
  const beforeFailure = await identity();
  try {
    const failedHide = await rawRpc('app.window', { action: 'hide' });
    assert.equal(failedHide.ok, false);
    assert.equal((await state()).windowPresent, true, 'save failure preserves the window');
    assert.equal((await state()).windowVisible, true);
    const afterFailure = await identity();
    assert.equal(afterFailure.windowId, beforeFailure.windowId);
    assert.equal(afterFailure.rendererPid, beforeFailure.rendererPid);
    assert.equal(await page.locator('.composer textarea').inputValue(), 'unsent conversation draft');
    assert.equal(await electron.evaluate(() => globalThis.__desktopSaveError), '未能保存窗口内容，已保留窗口');
  } finally {
    await page.evaluate(() => {
      window.__workbenchWindowSnapshot = window.__desktopSavedSnapshot;
      delete window.__desktopSavedSnapshot;
    });
    await electron.evaluate(({ dialog }) => {
      dialog.showMessageBox = globalThis.__desktopMessageBox;
      delete globalThis.__desktopMessageBox; delete globalThis.__desktopSaveError;
    });
  }
  for (let i = 0; i < 3; i++) {
    const previous = await identity();
    if (i === 0) await page.getByRole('button', { name: '收起到菜单栏', exact: true }).click();
    else await rpc('app.window', { action: 'hide' });
    await hidden(previous, `hide/show cycle ${i + 1}`);
    await show();
    assert.notEqual((await identity()).windowId, previous.windowId);
    assert.equal(await page.locator('.composer textarea').inputValue(), 'unsent conversation draft');
  }
  const finalNotices = await page.evaluate(async () => window.wb.invoke('notices.list'));
  assert.equal(finalNotices.data.some(notice => notice.taskId === fixtureTaskId), false, 'acknowledged notices do not return after renderer reconstruction');
  await page.getByRole('button', { name: '模型配置', exact: true }).click();
  await page.getByRole('button', { name: '＋ 添加模型', exact: true }).click();
  await page.getByPlaceholder('例如 GLM 5.3 Flash').fill('unsaved model profile');
  await page.getByPlaceholder('例如 glm-5.3-flash').fill('desktop-model-fixture');
  await reconstruct('model profile draft releases and reconstructs');
  assert.equal(await page.getByPlaceholder('例如 GLM 5.3 Flash').inputValue(), 'unsaved model profile');
  assert.equal(await page.getByPlaceholder('例如 glm-5.3-flash').inputValue(), 'desktop-model-fixture');
  // Local credential metadata survives renderer destruction, but an unsaved key
  // must never be included in the checkpoint written to the isolated database.
  const unsavedKey = 'fake-unsaved-desktop-key-fixture';
  await page.getByRole('button', { name: '＋ 添加 API 凭据', exact: true }).click();
  await page.getByPlaceholder('例如我的 Anthropic 兼容 API').fill('unsaved local source');
  await page.getByPlaceholder('https://example.com/v1').fill('https://example.com/fixture');
  await page.getByPlaceholder('例如 my-model').fill('desktop-local-model');
  await page.locator('.model-manager-form').filter({ hasText: '添加本地凭据来源' }).locator('select').selectOption('auth_token');
  await page.locator('input[type="password"]').fill(unsavedKey);
  const sourceSnapshot = await page.evaluate(() => window.__workbenchWindowSnapshot());
  assert.equal(JSON.stringify(sourceSnapshot).includes(unsavedKey), false, 'a typed API key is absent from the renderer checkpoint');
  await reconstruct('local source metadata survives without persisting its API key');
  const auditDb = new DatabaseSync(path.join(dataDir, 'workbench.db'), { readOnly: true });
  try {
    const savedWindow = auditDb.prepare('SELECT value FROM kv WHERE key=?').get('windowState.v1');
    assert.equal(savedWindow.value.includes(unsavedKey), false, 'the persisted window checkpoint contains no unsaved API key');
  } finally { auditDb.close(); }
  assert.equal(await page.getByPlaceholder('例如我的 Anthropic 兼容 API').inputValue(), 'unsaved local source');
  assert.equal(await page.getByPlaceholder('https://example.com/v1').inputValue(), 'https://example.com/fixture');
  assert.equal(await page.getByPlaceholder('例如 my-model').inputValue(), 'desktop-local-model');
  const restoredSource = page.locator('.model-manager-form').filter({ hasText: '添加本地凭据来源' });
  assert.equal(await restoredSource.locator('select').inputValue(), 'auth_token');
  assert.equal(await page.locator('input[type="password"]').inputValue(), '', 'a recreated renderer requires the unsaved API key again');
  await restoredSource.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('input[type="password"]').count(), 0, 'cancel returns to the model manager');
  assert.equal((await page.evaluate(() => window.__workbenchWindowSnapshot()))['models.sourceDraft'], null);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByPlaceholder('/Users/you/path/to/project').fill(path.join(projectDir, 'not-created'));
  await reconstruct('new project draft releases and reconstructs');
  assert.equal(await page.getByPlaceholder('/Users/you/path/to/project').inputValue(), path.join(projectDir, 'not-created'));
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await rpc('projects.list')).projects.length, 1, 'restoring a project draft never creates a project');
  await page.getByRole('button', { name: '项目背景', exact: true }).click();
  await until(() => page.getByRole('button', { name: '保存已确认背景', exact: true }).isEnabled(), 'initial project facts load');
  await page.getByPlaceholder('项目已确认事实与决定').fill('unsaved confirmed background');
  await page.getByRole('textbox', { name: '搜索项目经验' }).fill('retained facts search');
  await page.locator('.model-manager input[maxlength="200"]').fill('unfinished facts entry');
  await page.locator('.model-manager textarea[maxlength="20000"]').fill('unfinished facts body');
  await page.getByPlaceholder('例如：用户确认、文档路径、任务结果').fill('desktop fixture source');
  await reconstruct('project facts drafts release and reconstruct');
  assert.equal(await page.getByPlaceholder('项目已确认事实与决定').inputValue(), 'unsaved confirmed background');
  assert.equal(await page.getByRole('textbox', { name: '搜索项目经验' }).inputValue(), 'retained facts search');
  assert.equal(await page.locator('.model-manager input[maxlength="200"]').inputValue(), 'unfinished facts entry');
  assert.equal(await page.locator('.model-manager textarea[maxlength="20000"]').inputValue(), 'unfinished facts body');
  assert.equal(await page.getByPlaceholder('例如：用户确认、文档路径、任务结果').inputValue(), 'desktop fixture source');
  await page.locator('.model-manager').getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal((await rpc('project.memory.get', { projectId: 'fixture' })).memory.facts, '', 'restoring facts never saves them');
  // Hold an existing file-save handler open so hide must wait before releasing the renderer.
  await electron.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('files.write');
    if (typeof original !== 'function') throw new Error('Missing files.write handler');
    globalThis.__desktopFileWrite = original;
    ipcMain.removeHandler('files.write');
    ipcMain.handle('files.write', async (event, payload) => {
      await new Promise(resolve => { globalThis.__desktopReleaseWrite = resolve; });
      return original(event, payload);
    });
  });
  const beforeWrite = await identity();
  let hiding;
  try {
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await until(() => electron.evaluate(() => typeof globalThis.__desktopReleaseWrite === 'function'), 'file save is in flight');
    hiding = rpc('app.window', { action: 'hide' });
    await delay(200);
    assert.equal((await state()).windowPresent, true, 'pending file write prevents early renderer destruction');
    await electron.evaluate(() => globalThis.__desktopReleaseWrite());
    await hiding;
    await hidden(beforeWrite, 'renderer releases after in-flight file save completes');
    assert.equal(fs.readFileSync(path.join(projectDir, 'draft.txt'), 'utf8'), 'unsaved file edit');
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      globalThis.__desktopReleaseWrite?.();
      ipcMain.removeHandler('files.write'); ipcMain.handle('files.write', globalThis.__desktopFileWrite);
      delete globalThis.__desktopFileWrite; delete globalThis.__desktopReleaseWrite;
    });
    await hiding?.catch(() => {});
  }
  await show();
  // The second invoke begins in the first invoke's .then; checkpointing must wait across that callback boundary.
  await electron.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('files.write');
    if (typeof original !== 'function') throw new Error('Missing files.write handler');
    globalThis.__desktopChainWrite = original;
    globalThis.__desktopWriteGates = [];
    ipcMain.removeHandler('files.write');
    ipcMain.handle('files.write', async (event, payload) => {
      await new Promise(resolve => { globalThis.__desktopWriteGates.push(resolve); });
      return original(event, payload);
    });
  });
  const beforeChain = await identity();
  let chainHiding;
  try {
    await page.evaluate(taskId => {
      window.__desktopChainDone = window.wb.invoke('files.write', { sessionId: taskId, path: 'chain.txt', content: 'first chained save' })
        .then(first => {
          if (!first.ok) throw new Error(first.error);
          return window.wb.invoke('files.write', { sessionId: taskId, path: 'chain.txt', content: 'second chained save' });
        });
    }, fixtureTaskId);
    await until(() => electron.evaluate(() => globalThis.__desktopWriteGates.length === 1), 'first chained request is in flight');
    chainHiding = rpc('app.window', { action: 'hide' });
    void chainHiding.catch(() => {});
    await delay(100);
    await electron.evaluate(() => globalThis.__desktopWriteGates[0]());
    await until(() => electron.evaluate(() => globalThis.__desktopWriteGates.length === 2), 'second request starts in completion callback');
    await delay(100);
    assert.equal((await state()).windowPresent, true, 'chained second request prevents early destruction');
    assert.equal((await identity()).rendererPid, beforeChain.rendererPid);
    await electron.evaluate(() => globalThis.__desktopWriteGates[1]());
    await chainHiding;
    await hidden(beforeChain, 'renderer releases after chained requests complete');
    assert.equal(fs.readFileSync(path.join(projectDir, 'chain.txt'), 'utf8'), 'second chained save');
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      for (const release of globalThis.__desktopWriteGates) release();
      ipcMain.removeHandler('files.write'); ipcMain.handle('files.write', globalThis.__desktopChainWrite);
      delete globalThis.__desktopChainWrite; delete globalThis.__desktopWriteGates;
    });
    await chainHiding?.catch(() => {});
  }
  await show();
  const processes = await electron.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid));
  await electron.close(); electron = null;
  await until(() => processes.every(id => !alive(id)), 'main and Electron helpers exit');
  const result = { checks: { rendererReleased: true, mainPreserved: true, retainedDraft: true, retainedBoardSearch: true,
    retainedFileEdit: true, retainedTaskForm: true, backgroundMockRpc: true, backgroundMcp: true,
    retainedModelProfileDraft: true, retainedProjectDraft: true, retainedFactsDrafts: true,
    createValidationWithoutRenderer: true, backendNotices: true, noticeAcknowledgementPersists: true,
    saveFailurePreservesWindow: true, pendingFileSaveCompletesBeforeRelease: true,
    fileReadRaceMatchedPathAndContent: true, chainedRequestsCompleteBeforeRelease: true,
    coldNotificationDeepLink: true, repeatedHideShow: true, singleInstance: true, cleanQuit: true },
    memory: { open: openMemory, hidden: hiddenMemory, reopened: reopenedMemory } };
  if (process.argv[3]) {
    fs.mkdirSync(path.dirname(path.resolve(process.argv[3])), { recursive: true });
    fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
} finally {
  if (duplicate && duplicate.exitCode === null) duplicate.kill();
  if (electron) await electron.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
