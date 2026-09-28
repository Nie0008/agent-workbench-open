// Electron 主进程入口：窗口、服务装配、控制通道、启动恢复
import { app, BrowserWindow, powerMonitor, safeStorage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store';
import { CredentialManager } from './credentials';
import { TaskService } from './taskService';
import { ControlServer } from './controlServer';
import { registerIpc } from './ipc';
import { createWorkbenchMcpServer } from './mcp/agentTools';
import { DesktopShell } from './desktopShell';
import { NightlyMemoryService } from './nightlyMemory';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let desktop: DesktopShell | null = null;
let taskService: TaskService;
let control: ControlServer;
let nightly: NightlyMemoryService | null = null;
let quitting = false;
let shutdownComplete = false;

// 隔离验收实例可指定独立数据目录；正式启动仍使用系统默认目录。
if (process.env.WORKBENCH_DATA_DIR) {
  const isolatedDataDir = path.resolve(process.env.WORKBENCH_DATA_DIR);
  fs.mkdirSync(isolatedDataDir, { recursive: true });
  app.setPath('userData', isolatedDataDir);
}
const dataDir = app.getPath('userData'); // ~/Library/Application Support/Agent Workbench

// 主进程文件日志（轻量，便于打包版诊断）
const mainLog = path.join(dataDir, 'main.log');
function log(msg: string) {
  try { fs.appendFileSync(mainLog, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
  console.log(msg);
}

function createWindow() {
  log('[win] 创建中…');
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    show: false,
    // 注：hiddenInset + 沙盒 preload 在 launchd(Finder/open) 启动下会触发主进程停摆（Electron 44/macOS 26），使用标准标题栏
    backgroundColor: '#16171b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  log('[win] loadFile 调用');
  win.webContents.on('did-start-loading', () => log('[win] did-start-loading'));
  win.webContents.on('dom-ready', () => log('[win] dom-ready'));
  win.webContents.on('did-finish-load', () => log('[win] did-finish-load'));
  win.webContents.on('did-fail-load', (_e: any, code: any, desc: any) => log(`[win] FAIL ${code} ${desc}`));
  win.webContents.on('preload-error', (_e: any, p: any, err: any) => log(`[preload-error] ${p}: ${err}`));
  win.webContents.on('render-process-gone', (_e: any, d: any) => log(`[renderer-gone] ${JSON.stringify(d)}`));
  win.once('ready-to-show', () => log('[win] ready-to-show'));
  return win;
}

const gotLock = process.env.WORKBENCH_SKIP_LOCK === '1' ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // launchd/open 启动时 cwd 可能为 "/"：SDK 等依赖会做相对 cwd 的目录扫描，扫穿文件系统
  try {
    if (process.cwd() === '/' || process.cwd() === '') process.chdir(app.getPath('userData'));
  } catch { /* ignore */ }
  if (process.env.WORKBENCH_INSPECT_PORT) {
    app.commandLine.appendSwitch('inspect', process.env.WORKBENCH_INSPECT_PORT);
  }
  if (process.env.WORKBENCH_TRACE_FS === '1') {
    // 诊断：定位 launchd 启动下的递归目录扫描（超限后抛出以获取 JS 栈）
    const fsMod = require('node:fs') as typeof import('node:fs');
    let calls = 0;
    const orig = fsMod.readdirSync.bind(fsMod);
    (fsMod as any).readdirSync = (...args: any[]) => {
      if (++calls > 300) {
        try { fs.appendFileSync(mainLog, `[trace-fs] 深度 ${calls} 栈:\n${new Error().stack}\n`); } catch { /* ignore */ }
        throw new Error('fs-trace-limit');
      }
      return (orig as any)(...args);
    };
  }
  if (process.env.WORKBENCH_NO_GPU === '1') {
    // launchd 启动下 GPU 合成通道可能挂起主进程消息泵；提供开关用于诊断与兜底
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
  app.on('second-instance', () => {
    void desktop?.show().catch((error) => log(`[win] ${String(error)}`));
  });

  app.whenReady().then(async () => {
    try {
      log('[main] whenReady 开始');
      fs.mkdirSync(dataDir, { recursive: true });
      const store = process.env.WORKBENCH_SKIP_STORE === '1' ? null : new Store(path.join(dataDir, 'workbench.db'));
      const credentials = new CredentialManager(undefined, { store: store ?? undefined, vault: safeStorage });
      taskService = new TaskService(store as any, credentials);
      if (store) nightly = new NightlyMemoryService(taskService);
      control = new ControlServer(taskService, nightly);
      await control.start(path.join(dataDir, 'control.json'));
      log(`[main] 控制通道就绪 port=${(control as any).port ?? '?'}`);

    // 主 Agent 工具（进程内 SDK MCP），复用同一 TaskService
    taskService.mcpServerFactory = (parentSessionId: string) => createWorkbenchMcpServer(taskService, parentSessionId);

    // UI 截图导出（用于验收截图；无需系统录屏权限）
    control.captureFn = async () => {
      const win = desktop?.getWindow();
      if (!win) throw new Error('窗口未就绪');
      const img = await win.webContents.capturePage();
      return img.toPNG().toString('base64');
    };
    control.evalFn = async (expr: string) => {
      const win = desktop?.getWindow();
      if (!win) throw new Error('窗口未就绪');
      const r = await win.webContents.executeJavaScript(expr, true);
      return typeof r === 'string' ? r : JSON.stringify(r);
    };

    control.desktopFn = async (action) => {
      if (!desktop) throw new Error('当前实例没有桌面窗口');
      if (action === 'show') await desktop.show();
      if (action === 'hide' && !desktop.hide()) throw new Error('菜单栏当前不可用');
      return desktop.snapshot();
    };
    registerIpc(taskService, () => desktop?.getWindow() ?? null, dataDir,
      () => desktop?.hide() ?? false, nightly);
    // 默认供应商：优先上次使用 → CC Switch 当前供应商
    let providers: any[] = [];
    if (process.env.WORKBENCH_SKIP_CC !== '1') providers = taskService.credentials.listProviderInfos();
    if (store && process.env.WORKBENCH_SKIP_PROVIDER !== '1') {
      if (!store.getKV('defaultProviderId')) {
        const cur = providers.find((p) => p.isCurrent) ?? providers.find((p) => p.model.startsWith('glm-')) ?? providers[0];
        if (cur) store.setKV('defaultProviderId', cur.providerId);
      }
      store.setKV('appVersion', app.getVersion());
    }
    const resuming = store && process.env.WORKBENCH_SKIP_RESTORE !== '1' ? taskService.restoreOnStartup() : [];

    if (process.env.WORKBENCH_SKIP_WINDOW !== '1') {
      desktop = new DesktopShell(createWindow, log);
      await desktop.start();
    }
    nightly?.start();
    powerMonitor.on('resume', () => nightly?.onResume());
    app.on('activate', () => { void desktop?.show().catch((error) => log(`[win] ${String(error)}`)); });

    if (resuming.length) log(`[main] ${resuming.length} 个进行中任务标记为 恢复中`);
    log('[main] 启动完成');
    let beats = 0;
    const hb = setInterval(() => { beats++; log(`[main] heartbeat ${beats}`); if (beats > 60) clearInterval(hb); }, 5000);
    hb.unref?.();
    } catch (e: any) {
      log(`[main] 启动失败: ${String(e?.stack ?? e).slice(0, 800)}`);
      throw e;
    }
  });

  app.on('window-all-closed', () => {
    // Keep the task service alive while the menu-bar entry can reopen the UI.
    if (!desktop?.snapshot().trayReady && process.env.WORKBENCH_SKIP_WINDOW !== '1') app.quit();
  });
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    desktop?.prepareToQuit();
    control?.stop();
    // Give adapters time to stop their process groups; never leave Electron
    // waiting indefinitely for an unresponsive external CLI.
    const timeout = setTimeout(() => {
      log('[main] 等待执行器退出超时，结束应用');
      shutdownComplete = true;
      app.quit();
    }, 8_000);
    Promise.resolve(nightly?.stop()).catch(() => {}).then(() => taskService?.shutdown()).finally(() => {
      clearTimeout(timeout);
      if (shutdownComplete) return;
      taskService?.store?.close();
      shutdownComplete = true;
      app.quit();
    });
  });
  app.on('will-quit', () => { desktop?.dispose(); });
}
