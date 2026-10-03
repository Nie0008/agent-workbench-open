// Electron 主进程入口：窗口、服务装配、控制通道、启动恢复
import { app, BrowserWindow, Notification, powerMonitor, safeStorage } from 'electron';
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
import { workbenchDataDir } from './paths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let desktop: DesktopShell | null = null;
let taskService: TaskService;
let control: ControlServer;
let nightly: NightlyMemoryService | null = null;
let quitting = false;
let shutdownComplete = false;

// 隔离验收实例可指定独立数据目录；正式启动仍使用系统默认目录。
const dataDir = workbenchDataDir();
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);

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
      if (action === 'hide' && !await desktop.hide()) throw new Error('未能收起窗口，请处理提示后重试');
      return desktop.snapshot();
    };
    // 通知点击同款深度链接入口（control 验证/外部通知代理共用；不改变权限状态）
    control.openTaskFn = (taskId: string) => { try { desktop?.openTask(taskId); } catch { /* 未开窗口时忽略 */ } };
    registerIpc(taskService, () => desktop?.getWindow() ?? null, dataDir,
      () => desktop?.hide() ?? false, nightly);

    // 待授权的用户通知与处理入口：
    //  - 每条"新逻辑待授权"发一次系统通知（协议重试在 TaskService 内去重，不会重复提醒）；
    //  - 点击通知 / 菜单栏"待授权"项 → 打开工作台并定位任务，在界面内批准/拒绝；
    //  - 托盘计数由事件流（服务端事实）驱动，界面重启后计数自动恢复。
    const agentNames: Record<string, string> = { 'claude-code': 'Claude Code', grok: 'Grok Build', dsh: 'DSH', zcode: 'ZCode' };
    taskService.permissionNotifier = (info) => {
      const refresh = () => desktop?.setPendingCount(taskService.pendingPermissionCount);
      refresh();
      log(`[notify] 待授权提醒 task=${info.taskId} tool=${info.toolName} reason=${info.reason}`);
      try {
        if (!Notification.isSupported()) return;
        const n = new Notification({
          title: 'Agent Workbench · 需要你的授权',
          body: `「${info.title}」（${agentNames[info.agentId] ?? info.agentId}）请求 ${info.toolName}\n${info.reason}`,
          silent: false,
        });
        n.on('click', () => { try { desktop?.openTask(info.taskId); } catch { /* ignore */ } });
        n.show();
      } catch { /* 通知失败不阻塞授权流程 */ }
    };
    store?.subscribeEvents((e) => {
      if (e.type === 'permission_request' || e.type === 'permission_resolved') {
        desktop?.setPendingCount(taskService.pendingPermissionCount);
      }
    });
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
      desktop = new DesktopShell(createWindow, log, async (win) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const state = await Promise.race([
            win.webContents.executeJavaScript('window.__workbenchWindowSnapshot()', true),
            new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('仍有保存或发送操作未完成')),5000); }),
          ]);
          if (!state || typeof state!=='object' || Array.isArray(state)) throw new Error('窗口状态尚未就绪');
          const encoded=JSON.stringify(state);
          // ponytail: cap retained UI drafts; larger files keep their window open rather than lose edits.
          if (Buffer.byteLength(encoded)>16*1024*1024) throw new Error('未保存内容过大，请先保存文件');
          store!.setKV('windowState.v1',encoded);
        } finally { if (timer) clearTimeout(timer); }
      });
      await desktop.start(process.env.WORKBENCH_START_HIDDEN === '1');
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
