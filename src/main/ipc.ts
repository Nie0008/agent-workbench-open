// IPC：renderer 与主进程之间的最小契约（contextIsolation 下经 preload 暴露）
import { app, ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import * as crypto from 'node:crypto';
import type { TaskService } from './taskService';
import type { PermissionResponseOrigin } from './taskService';
import type { WorkbenchEvent } from '../shared/types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tree, readTextFile, writeTextFile, lineDiff, gitDiffPath, isGitRepo } from './files';

export function registerIpc(taskService: TaskService, getWindow: () => BrowserWindow | null, dataDir: string,
  hideWindow?: () => boolean | Promise<boolean>) {
  const ts = taskService;
  const ipcLog = (msg: string) => {
    try { fs.appendFileSync(path.join(dataDir, 'main.log'), `${new Date().toISOString()} [ipc] ${msg}\n`); } catch { /* ignore */ }
  };
  taskService.broadcast = (e: WorkbenchEvent) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('wb:event', e); } catch { /* 事件已落盘，窗口销毁不影响任务 */ }
    }
  };

  const h = (channel: string, handler: (p: any, event: IpcMainInvokeEvent) => any) => {
    ipcMain.handle(channel, async (event, payload) => {
      const t0 = Date.now();
      const slow = setTimeout(() => ipcLog(`慢处理: ${channel} 已 ${Date.now() - t0}ms`), 2000);
      try {
        const r = { ok: true, data: await handler(payload ?? {}, event) };
        return r;
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      } finally {
        clearTimeout(slow);
        ipcLog(`${channel} 完成 ${Date.now() - t0}ms`);
      }
    });
  };

  h('app.info', (p) => {
    const options = ts.agentOptions(p?.refreshModels === true);
    return {
      version: app.getVersion(),
      dataDir,
      providers: options.providers,
      profiles: options.profiles,
      sources: options.sources,
      defaultProviderId: options.defaultProviderId ?? options.providers.find((p) =>
        p.providerId !== 'grok-super-oauth' && !p.providerId.startsWith('grok-config:'))?.providerId ?? '',
      defaultTaskCombo: options.defaultTaskCombo,
      combinations: options.combinations,
      adapters: ts.adapters().filter((adapter) => adapter.id !== 'mock').map((adapter) =>
        ({ id: adapter.id, displayName: adapter.displayName, verified: true })),
      settings: ts.getSettings(),
    };
  });

  ts.store.enableTaskNotices();
  h('app.uiState', () => {
    const state=JSON.parse(ts.store.getKV('windowState.v1') ?? '{}');
    if(!state || typeof state!=='object' || Array.isArray(state))throw new Error('窗口内容格式无效');
    return state;
  });
  h('notices.list', () => ts.store.taskNotices());
  h('notices.import', (p) => { ts.store.importTaskNotices(p.notices); return ts.store.taskNotices(); });
  h('notices.ack', (p) => { ts.store.ackTaskNotices(p.taskId); return ts.store.taskNotices(); });
  h('app.hide', async () => {
    if (!await hideWindow?.()) throw new Error('未能收起窗口，请处理提示后重试');
    return {};
  });
  h('app.windowState', () => ({ visible: getWindow()?.isVisible() ?? false }));

  h('tasks.progress', (p) => ts.progress(p.projectId));
  h('project.memory.get', (p) => ts.projectMemory(p.projectId));
  h('project.memory.set', (p) => ts.updateMemory(p.projectId,p.facts,p.expectedVersion,p.source));
  h('project.memory.entries.list', (p) => ts.listMemoryEntries(p.projectId,p.filters ?? {}));
  h('project.memory.entries.search', (p) => ts.searchMemory(p.projectId,String(p.query ?? ''),p.options ?? {}));
  h('project.memory.entries.get', (p) => ts.getMemoryEntry(p.projectId,p.id));
  h('project.memory.entries.history', (p) => ts.getMemoryHistory(p.projectId,p.id));
  h('project.memory.entries.create', (p) => ts.createMemoryEntry(p));
  h('project.memory.entries.update', (p) => ts.updateMemoryEntry(p.projectId,p.id,p.patch ?? {},p.expectedVersion));
  h('project.memory.entries.status', (p) => ts.setMemoryStatus(p.projectId,p.id,p.status,p.expectedVersion));
  h('project.memory.entries.replace', (p) => ts.replaceMemoryEntry(p.projectId,p.id,p.expectedVersion,p.entry ?? {}));
  h('project.memory.handoff.create', (p) => ts.createHandoffDraft(p.taskId));
  h('memory.nightly.status', () => null);
  h('task.background', (p) => JSON.parse(ts.store.getKV(`background:${p.taskId}`)??'null'));
  h('task.memory.used', (p) => ts.taskMemoryUsed(p.taskId));
  h('projects.list', () => ts.listProjects());
  h('projects.create', (p) => ts.createProject(p.rootPath, p.name));
  h('project.facts.get', (p) => ts.projectFacts(p.projectId));
  h('project.facts.set', (p) => { ts.updateProjectFacts(p.projectId, String(p.facts ?? '')); return {}; });

  h('sessions.list', (p) => ts.listSessions(p.projectId));
  h('sessions.subtasks', (p) => ts.listSubtasks(p.parentSessionId));
  h('session.get', (p) => ts.getSession(p.sessionId));
  h('sessions.resolveProvider', (p) => ts.resolveSessionProvider(p.sessionId));
  h('sessions.bindProvider', (p) => ts.bindSessionProvider(p.sessionId, p.providerId, p.model));
  h('agents.setDefault', (p) => ts.setDefaultTaskCombo(p.agentId, p.providerId, p.model));
  h('models.save', (p) => ts.saveModelProfile(p));
  h('models.delete', (p) => ts.deleteModelProfile(String(p.id ?? '')));
  h('models.import', () => ts.importModelProfiles());
  h('credentials.save', (p) => ts.saveCredentialSource(p));
  h('credentials.importCcSwitch', (p) => ts.importCcSwitchCredential(String(p.providerId ?? '')));
  h('credentials.delete', (p) => ts.deleteCredentialSource(String(p.providerId ?? '')));

  h('sessions.create', (p) => ts.createMainSession({
    projectId: p.projectId, title: p.title, prompt: p.prompt,
    scope: p.scope ?? { fileWrite: p.fileWrite === true }, scopeSource: 'ui',
    agentId: p.agentId, model: p.model, providerId: p.providerId, mockScript: p.mockScript,
  }));

  h('task.send', (p) => ts.send(p.sessionId, String(p.text ?? ''), p.clientMsgId));
  h('task.cancel', (p) => ts.cancel(p.sessionId, { cascade: true }));
  h('events.list', (p) => ts.listEvents(p.sessionId, p.sinceSeq ?? 0));

  h('permissions.respond', (p, event) => {
    const win = getWindow();
    const expectedFrame = !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
    const requestId = crypto.randomUUID();
    ipcLog(`[permission-response] ${JSON.stringify({ requestId, senderId: event.sender.id,
      rendererProcessId: event.sender.getOSProcessId(), expectedFrame,
      taskId: typeof p.taskId === 'string' ? p.taskId.slice(0, 200) : null,
      permissionId: typeof p.permissionId === 'string' ? p.permissionId.slice(0, 200) : null,
      decision: p.decision === 'allow' || p.decision === 'deny' ? p.decision : 'invalid' })}`);
    if (!win || !expectedFrame)
      throw new Error('授权响应不是来自工作台主窗口');
    const origin: PermissionResponseOrigin = {
      transport: 'electron-ipc', entryPoint: 'permissions.respond', requestId,
      window: { id: event.sender.id, processId: event.sender.getOSProcessId(),
        frameUrl: event.senderFrame!.url, focused: win.isFocused(), visible: win.isVisible() },
      interaction: { type: p.interaction?.type === 'click' ? 'click' : 'unknown', trusted: p.interaction?.trusted === true },
    };
    return ts.respondPermission(p.permissionId, p.decision, typeof p.taskId === 'string' ? p.taskId : undefined, 'ui', origin);
  });

  h('settings.get', () => ts.getSettings());
  h('settings.set', (p) => ts.setSettings(p));

  h('files.tree', (p) => {
    const session = ts.getSession(p.sessionId);
    const root = session?.cwd ?? p.rootPath;
    return tree(root, p.depth ?? 4);
  });
  h('files.read', (p) => {
    const session = ts.getSession(p.sessionId);
    const root = session?.cwd ?? p.rootPath;
    return readTextFile(root, p.path);
  });
  h('files.write', (p) => {
    const session = ts.getSession(p.sessionId);
    const root = session?.cwd ?? p.rootPath;
    writeTextFile(root, p.path, String(p.content ?? ''));
    return {};
  });
  h('files.diff', (p) => {
    const session = ts.getSession(p.sessionId);
    const root = session?.cwd ?? p.rootPath;
    if (isGitRepo(root)) {
      const patch = gitDiffPath(root, p.path, p.baseRef);
      if (patch != null) return { mode: 'git', patch, untracked: false };
    }
    // 非 git 或无 HEAD diff：读取当前内容，前端与空基线/编辑缓冲对比
    let content = '';
    try { content = readTextFile(root, p.path).content; } catch { content = ''; }
    return { mode: 'plain', content, untracked: true };
  });

  h('merge.check', (p) => ts.previewMerge(p.taskId));
  h('merge.apply', (p) => ts.mergeSubtask(p.taskId));
  h('worktree.cleanup', (p) => ts.cleanupWorktree(p.taskId));

  h('diag.leakScan', (p) => ({ count: ts.leakScan(String(p.needle ?? '')) }));
}
