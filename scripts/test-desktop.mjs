// Optional macOS GUI check. Uses an isolated database and never calls a model.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/test-desktop.mjs [packaged executable]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-desktop-'));
const executablePath = process.argv[2] || path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const args = process.argv[2] ? [] : [root];
const env = { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_DEBUG: '1', WORKBENCH_SKIP_RESTORE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_SKIP_LOCK;
delete env.WORKBENCH_SKIP_WINDOW;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
let electron, duplicate;
try {
  electron = await _electron.launch({ executablePath, args, env, timeout: 30000 });
  const page = await electron.firstWindow();
  // Playwright forces pages to look focused; restore real native visibility for this check.
  const cdp = await electron.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await page.getByRole('button', { name: '收起到菜单栏', exact: true }).waitFor();
  const { port, token, pid } = JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8'));
  const rpc = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.notEqual(result.ok, false, result.error);
    return result;
  };
  const state = async () => (await rpc('app.window')).desktop;
  assert.equal(typeof (await rpc('memory.nightly.status')).status?.processedTurns, 'number');
  const pollingCount = () => (fs.readFileSync(path.join(dataDir, 'main.log'), 'utf8').match(/\[ipc\] tasks\.progress 完成/g) || []).length;
  const windowId = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  assert.equal((await state()).trayReady, true);
  await until(async () => (await state()).windowVisible, 'initial window');
  await until(async () => pollingCount() > 0, 'initial board refresh');
  const search = page.getByRole('textbox', { name: '搜索项目或任务' });
  await search.fill('retain this input');
  await page.getByRole('button', { name: '收起到菜单栏', exact: true }).click();
  await until(async () => !(await state()).windowVisible && !(await state()).dockVisible, 'toolbar hides window and Dock');
  await delay(300); // Allow a request already in flight to finish.
  const before = pollingCount();
  await delay(5500);
  assert.equal(pollingCount(), before, 'board must not poll while hidden');
  assert.equal((await rpc('tasks.list')).tasks.length, 0, 'backend remains available');
  // Real main-to-renderer event while hidden; no provider or synthetic task is started.
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('wb:event', {
    sessionId: 'desktop-smoke', seq: 1, type: 'error', payload: { message: 'test notice' }, createdAt: new Date().toISOString(),
  }));
  await rpc('app.window', { action: 'show' });
  await until(async () => (await state()).windowVisible && (await state()).dockVisible, 'restore window and Dock');
  await until(() => pollingCount() > before, 'refresh immediately on restore');
  assert.equal(await search.inputValue(), 'retain this input');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('workbench.task-notices.v1') || '[]').some(n => n.taskId === 'desktop-smoke')), true);
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await until(async () => !(await state()).windowVisible, 'red close hides');
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id), windowId);
  await rpc('app.window', { action: 'show' });
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await until(async () => !(await state()).windowVisible && !(await state()).dockVisible, 'yellow minimize hides');
  // A second native launch must reopen the first instance, then exit.
  duplicate = spawn(executablePath, args, { env, stdio: 'ignore' });
  await until(() => duplicate.exitCode !== null, 'duplicate instance exits');
  assert.equal(duplicate.exitCode, 0);
  await until(async () => (await state()).windowVisible && !(await state()).windowMinimized, 'duplicate launch reopens');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8')).pid, pid);
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(await search.inputValue(), 'retain this input');
  const processes = await electron.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid));
  await electron.close(); electron = null;
  const alive = id => { try { process.kill(id, 0); return true; } catch { return false; } };
  await until(() => processes.every(id => !alive(id)), 'main and Electron helpers exit');
  console.log('PASS: tray, toolbar/close/minimize, Dock, background RPC, hidden polling/notices, retained input, single instance, clean quit');
} finally {
  if (duplicate && duplicate.exitCode === null) duplicate.kill();
  if (electron) await electron.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
