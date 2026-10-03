import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron';

// A monochrome dashboard icon; scaleFactor keeps it at 16 points on Retina displays.
function menuBarImage() {
  const pixels = Buffer.alloc(32 * 32 * 4);
  const rect = (x: number, y: number, width: number, height: number) => {
    for (let row = y; row < y + height; row++)
      for (let col = x; col < x + width; col++) pixels[(row * 32 + col) * 4 + 3] = 255;
  };
  rect(5, 3, 22, 2); rect(5, 27, 22, 2);
  rect(3, 5, 2, 22); rect(27, 5, 2, 22);
  rect(4, 4, 2, 2); rect(26, 4, 2, 2); rect(4, 26, 2, 2); rect(26, 26, 2, 2);
  rect(8, 9, 5, 14); rect(17, 9, 7, 5); rect(17, 18, 7, 5);
  const image = nativeImage.createFromBitmap(pixels, { width: 32, height: 32, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

export class DesktopShell {
  private win: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
  private visibilityEpoch = 0;
  private lastDockShow = 0;
  private dockHideTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCount = 0;

  constructor(private createWindow: () => BrowserWindow, private reportError: (message: string) => void,
    private saveWindowState: (win: BrowserWindow) => Promise<void>) {}

  async start(hidden = false) {
    try {
      this.tray = new Tray(menuBarImage());
      this.refreshMenu();
    } catch (error) {
      this.reportError(`菜单栏图标创建失败: ${String(error)}`);
    }
    if (!hidden || !this.tray) await this.show();
    else app.dock?.hide();
  }

  getWindow() { return this.win && !this.win.isDestroyed() ? this.win : null; }

  snapshot() {
    const win = this.getWindow();
    return {
      trayReady: !!this.tray && !this.tray.isDestroyed(),
      windowPresent: !!win,
      windowVisible: !!win?.isVisible(),
      windowMinimized: !!win?.isMinimized(),
      dockVisible: app.dock?.isVisible() ?? null,
      quitting: this.quitting,
    };
  }

  async show() {
    if (this.quitting) return;
    const epoch = ++this.visibilityEpoch;
    this.clearDockHideTimer();
    if (app.dock && !app.dock.isVisible()) {
      this.lastDockShow = Date.now();
      await app.dock.show();
    }
    if (this.quitting || epoch !== this.visibilityEpoch) return;
    if (!this.getWindow()) {
      const win = this.createWindow();
      this.win = win;
      win.on('close', (event) => {
        if (!this.quitting && this.tray && !this.tray.isDestroyed()) {
          event.preventDefault();
          void this.hide();
        }
      });
      win.on('minimize', () => { if (!this.quitting) void this.hide(); });
      const visibilityChanged = () => {
        this.refreshMenu();
        if (!win.webContents.isDestroyed()) win.webContents.send('wb:visibility', win.isVisible());
      };
      win.on('show', visibilityChanged);
      win.on('hide', visibilityChanged);
      win.on('closed', () => { if (this.win === win) this.win = null; });
    }
    const win = this.getWindow()!;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.refreshMenu();
  }

  async hide(): Promise<boolean> {
    if (this.quitting || !this.tray || this.tray.isDestroyed()) return false;
    const epoch = ++this.visibilityEpoch;
    const win = this.getWindow();
    if (win) {
      try { await this.saveWindowState(win); }
      catch (error) {
        this.reportError(`收起失败: ${String(error)}`);
        if (!win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          void dialog.showMessageBox(win, {type:'error',message:'未能保存窗口内容，已保留窗口',
            detail:`请稍后重试。${String(error instanceof Error ? error.message : error)}`});
        }
        return false;
      }
      if (this.quitting || epoch !== this.visibilityEpoch || this.getWindow() !== win) return false;
      win.destroy();
    }
    app.dock?.hide();
    this.clearDockHideTimer();
    if (app.dock) {
      // Electron 41/macOS ignores DockHide for one second after DockShow.
      // Reconcile once after that guard; opening the window cancels this timer.
      this.dockHideTimer = setTimeout(() => {
        this.dockHideTimer = null;
        if (!this.quitting && !this.getWindow()?.isVisible()) app.dock?.hide();
      }, Math.max(0, 1100 - (Date.now() - this.lastDockShow)));
    }
    this.refreshMenu();
    return true;
  }

  private clearDockHideTimer() {
    if (this.dockHideTimer) clearTimeout(this.dockHideTimer);
    this.dockHideTimer = null;
  }

  prepareToQuit() { this.quitting = true; this.clearDockHideTimer(); }

  dispose() {
    this.prepareToQuit();
    this.tray?.destroy();
    this.tray = null;
  }

  // 服务端事实驱动的待授权计数：菜单栏直接提供"处理授权"入口（点击打开工作台）
  setPendingCount(count: number) {
    const next = Math.max(0, count);
    if (next === this.pendingCount && this.tray && !this.tray.isDestroyed()) return;
    this.pendingCount = next;
    this.refreshMenu();
  }

  // 系统通知点击入口：打开工作台并定位到对应任务。
  // 时序：show() 是异步的（窗口可能尚未创建/加载），必须等待完成后再发事件；
  // 加载中用 did-finish-load 兜底，已加载则直接发送，避免冷启动丢事件。
  openTask(taskId: string) {
    void this.show().then(() => {
      const win = this.getWindow();
      if (!win || win.webContents.isDestroyed()) return;
      const send = () => { if (!win.webContents.isDestroyed()) win.webContents.send('wb:open-task', taskId); };
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
      else send();
    }).catch((error) => this.reportError(String(error)));
  }

  private refreshMenu() {
    if (!this.tray || this.tray.isDestroyed()) return;
    const visible = !!this.getWindow()?.isVisible();
    const pending = this.pendingCount;
    this.tray.setToolTip(`Agent Workbench · ${pending > 0 ? `${pending} 项待授权` : visible ? '工作台已打开' : '后台运行'}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Agent Workbench', enabled: false },
      { type: 'separator' },
      ...(pending > 0 ? [{ label: `⛔ ${pending} 项待授权 — 打开处理`, click: () => { void this.show().catch((error) => this.reportError(String(error))); } }] : []),
      { label: '打开工作台', click: () => { void this.show().catch((error) => this.reportError(String(error))); } },
      { label: '收起到菜单栏', enabled: visible, click: () => { void this.hide(); } },
      { type: 'separator' },
      { label: '退出 Agent Workbench', click: () => app.quit() },
    ]));
  }
}
