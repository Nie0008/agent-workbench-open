// preload：最小 IPC 桥（contextIsolation + sandbox 下可用）
import { contextBridge, ipcRenderer } from 'electron';

const requests = new Set<Promise<unknown>>();
const invoke = (channel: string, payload?: unknown) => {
  const request = ipcRenderer.invoke(channel, payload);
  if (channel !== 'app.hide') {
    requests.add(request);
    void request.then(()=>requests.delete(request),()=>requests.delete(request));
  }
  return request;
};
const openTaskListeners = new Set<(taskId:string)=>void>();
const queuedTasks: string[] = [];
ipcRenderer.on('wb:open-task', (_event,taskId:string)=>{
  if(openTaskListeners.size)for(const listener of openTaskListeners)listener(taskId);
  else { queuedTasks.push(taskId); if(queuedTasks.length>20)queuedTasks.shift(); }
});

contextBridge.exposeInMainWorld('wb', {
  invoke,
  waitForRequests: async () => {
    do {
      while(requests.size)await Promise.allSettled([...requests]);
      // A resolved UI callback can enqueue another request before its next commit.
      await new Promise(resolve=>setTimeout(resolve,0));
    } while(requests.size);
  },
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
  onOpenTask: (cb: (taskId: string) => void) => {
    openTaskListeners.add(cb);
    for(const taskId of queuedTasks.splice(0))cb(taskId);
    return () => {openTaskListeners.delete(cb);};
  },
});
