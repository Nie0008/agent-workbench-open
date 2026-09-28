import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';

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

  constructor(private createWindow: () => BrowserWindow, private reportError: (message: string) => void) {}

  async start() {
    try {
      this.tray = new Tray(menuBarImage());
      this.refreshMenu();
    } catch (error) {
      this.reportError(`菜单栏图标创建失败: ${String(error)}`);
    }
    await this.show();
  }

  getWindow() { return this.win && !this.win.isDestroyed() ? this.win : null; }

  snapshot() {
    const win = this.getWindow();
    return {
      trayReady: !!this.tray && !this.tray.isDestroyed(),
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
          this.hide();
        }
      });
      win.on('minimize', () => { if (!this.quitting) this.hide(); });
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

  hide(): boolean {
    if (this.quitting || !this.tray || this.tray.isDestroyed()) return false;
    this.visibilityEpoch++;
    this.getWindow()?.hide();
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

  private refreshMenu() {
    if (!this.tray || this.tray.isDestroyed()) return;
    const visible = !!this.getWindow()?.isVisible();
    this.tray.setToolTip(`Agent Workbench · ${visible ? '工作台已打开' : '后台运行'}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Agent Workbench', enabled: false },
      { type: 'separator' },
      { label: '打开工作台', click: () => { void this.show().catch((error) => this.reportError(String(error))); } },
      { label: '收起到菜单栏', enabled: visible, click: () => { this.hide(); } },
      { type: 'separator' },
      { label: '退出 Agent Workbench', click: () => app.quit() },
    ]));
  }
}
