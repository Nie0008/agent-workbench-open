// preload：最小 IPC 桥（contextIsolation + sandbox 下可用）
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('wb', {
  invoke,
  onWindowVisibility: (cb: (visible: boolean) => void) => {
    const listener = (_ev: unknown, visible: boolean) => cb(visible);
    ipcRenderer.on('wb:visibility', listener);
    return () => ipcRenderer.removeListener('wb:visibility', listener);
  },
  onEvent: (cb: (e: any) => void) => {
    const listener = (_ev: unknown, e: any) => cb(e);
    ipcRenderer.on('wb:event', listener);
    return () => ipcRenderer.removeListener('wb:event', listener);
  },
});
