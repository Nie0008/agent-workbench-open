import type { Store } from './store';
import type { WorkbenchEvent } from '../shared/types';

export interface WatchTarget { taskId: string; sinceSeq: number }
export function important(e: WorkbenchEvent): boolean {
  return ['result', 'error', 'permission_request', 'conflict'].includes(e.type)
    || (e.type === 'session' && ['stopped','completed','failed','canceled','interrupted','timeout'].includes(e.payload?.status));
}
function compact(e: WorkbenchEvent): WorkbenchEvent {
  const payload: Record<string, unknown> = {};
  for (const key of ['status','previous','reason','message','text','toolName','permissionId','kind','path','detail','isError','numTurns']) {
    const v = e.payload?.[key];
    if (typeof v === 'string') payload[key] = v.slice(0, 1200);
    else if (typeof v === 'boolean' || typeof v === 'number') payload[key] = v;
  }
  return { seq:e.seq, sessionId:e.sessionId, type:e.type, createdAt:e.createdAt, payload };
}

/** One shared event source; no polling, per-task child process or unbounded in-memory event history. */
export class TaskWaiter {
  private pending = new Set<() => void>();
  private closed = false;
  constructor(private store: Store) {}
  get pendingCount() { return this.pending.size; }
  close() { this.closed = true; for (const stop of [...this.pending]) stop(); }
  wait(targets: WatchTarget[], timeoutMs = 20000, signal?: AbortSignal): Promise<any> {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8) throw new Error('需要 1–8 个任务');
    if (new Set(targets.map(t => t.taskId)).size !== targets.length) throw new Error('任务不能重复');
    for (const t of targets) {
      if (!Number.isSafeInteger(t.sinceSeq) || t.sinceSeq < 0) throw new Error('sinceSeq 必须为非负整数');
      if (!this.store.getSession(t.taskId)) throw new Error('任务不存在');
      if (t.sinceSeq > this.store.lastSeq(t.taskId)) throw new Error('游标超过当前任务事件位置');
    }
    if (!Number.isFinite(timeoutMs)) throw new Error('timeoutMs 无效');
    if (this.pending.size >= 64) throw new Error('等待连接已达上限');
    const delay = Math.min(20000, Math.max(0, timeoutMs));
    return new Promise(resolve => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let off = () => {};
      const cursors = targets.map(t => ({...t}));
      const collect = () => {
        const events: WorkbenchEvent[] = [];
        for (const t of cursors) {
          if (events.length >= 100) break;
          const upper = this.store.lastSeq(t.taskId);
          const rows = this.store.keyEvents(t.taskId, t.sinceSeq, upper, 100 - events.length);
          events.push(...rows.map(compact));
          // At the page boundary leave later events for the next call.
          t.sinceSeq = events.length >= 100 && rows.length ? rows[rows.length - 1].seq : upper;
        }
        return events;
      };
      const finish = (reason: string, events: WorkbenchEvent[] = []) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        off(); signal?.removeEventListener('abort', aborted); this.pending.delete(stopped);
        resolve({ok:true, reason, events, cursors, serverTime:new Date().toISOString()});
      };
      const stopped = () => finish('shutdown');
      const aborted = () => finish('aborted');
      const scan = () => { const es = collect(); if (es.length) finish('events', es); };
      if (this.closed) { finish('shutdown'); return; }
      if (signal?.aborted) { finish('aborted'); return; }
      this.pending.add(stopped);
      // Subscribe before initial scan. Store append and scan are synchronous on the same event loop.
      off = this.store.subscribeEvents(e => { if (cursors.some(t => t.taskId === e.sessionId) && important(e)) scan(); });
      signal?.addEventListener('abort', aborted, {once:true});
      scan();
      if (!done) timer = setTimeout(() => { const es=collect(); finish(es.length ? 'events' : 'timeout', es); }, delay);
    });
  }
}
