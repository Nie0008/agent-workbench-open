// 本地持久化：node:sqlite（Electron 主进程自带，无需原生编译）
// 保存项目、会话、事件（含去重）、工具执行守卫、设置。凭据永不入库。
import { DatabaseSync } from 'node:sqlite';
import type { WorkbenchEvent, SessionRow, SessionStatus, Project, TaskScope, MemoryEntry, MemoryInjectionSnapshot } from '../shared/types';

export interface NewSessionInput {
  id: string;
  projectId: string;
  kind: 'main' | 'sub';
  parentSessionId?: string | null;
  title: string;
  agentId: string;
  model: string;
  cwd: string;
  scope: TaskScope;
  providerId?: string | null;   // 会话绑定供应商；NULL=旧数据/未选择，真实调用前需用户确认绑定
  delegation?: { instructions: string; contextFiles?: string[]; acceptance?: string; snapshot?: unknown } | null;
}

export class Store {
  transaction<T>(fn: () => T): T {
    const db=this.ensure();db.exec('BEGIN IMMEDIATE');
    try {const result=fn();db.exec('COMMIT');return result;} catch(e){db.exec('ROLLBACK');throw e;}
  }
  private eventListeners = new Set<(e: WorkbenchEvent) => void>();
  subscribeEvents(fn: (e: WorkbenchEvent) => void) { this.eventListeners.add(fn); return () => { this.eventListeners.delete(fn); }; }
  get eventListenerCount() { return this.eventListeners.size; }
  keyEvents(id: string, since: number, upper: number, limit: number): WorkbenchEvent[] {
    const rows: any[] = this.ensure().prepare(`SELECT * FROM events WHERE session_id=? AND seq>? AND seq<=? AND
      (type IN ('result','error','permission_request','conflict') OR (type='session' AND json_extract(payload,'$.status') IN
      ('stopped','completed','failed','canceled','interrupted','timeout'))) ORDER BY seq LIMIT ?`).all(id,since,upper,limit) as any[];
    return rows.map(r => ({sessionId:r.session_id,seq:r.seq,type:r.type,payload:JSON.parse(r.payload),createdAt:r.created_at}));
  }
  latestEvent(id: string, activeOnly = false): WorkbenchEvent | null {
    const filter = activeOnly ? " AND type IN ('text_delta','message','tool_request','tool_result','result','error','permission_request')" : '';
    const r:any = this.ensure().prepare('SELECT * FROM events WHERE session_id=?'+filter+' ORDER BY seq DESC LIMIT 1').get(id);
    return r ? {sessionId:r.session_id,seq:r.seq,type:r.type,payload:JSON.parse(r.payload),createdAt:r.created_at} : null;
  }

  private db: DatabaseSync | null = null;
  constructor(private dbPath: string, private opts?: { journalMode?: 'wal' | 'delete' }) {}

  // 懒初始化：launchd 启动场景下避免在窗口创建前长时间持有 sqlite 连接
  private ensure(): DatabaseSync {
    if (this.db) return this.db;
    const db = new DatabaseSync(this.dbPath);
    db.exec(`PRAGMA journal_mode = ${this.opts?.journalMode ?? 'delete'};`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
        is_git INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        parent_session_id TEXT, title TEXT NOT NULL, agent_id TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, native_session_id TEXT, cwd TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}', delegation_json TEXT, summary TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(session_id, seq));
      CREATE TABLE IF NOT EXISTS executed_tools(
        session_id TEXT NOT NULL, tool_key TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL,
        UNIQUE(session_id, tool_key));
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_entries(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        source TEXT NOT NULL, task_id TEXT, evidence_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
        version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
        replaced_by_id TEXT, request_id TEXT, UNIQUE(project_id, request_id));
      CREATE INDEX IF NOT EXISTS idx_memory_project_status ON memory_entries(project_id,status,updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_task ON memory_entries(task_id);
      CREATE TABLE IF NOT EXISTS memory_entry_history(
        entry_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, archived_at TEXT NOT NULL,
        PRIMARY KEY(entry_id,version));
      CREATE TABLE IF NOT EXISTS task_memory_injections(
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, query_text TEXT NOT NULL,
        created_at TEXT NOT NULL, char_budget INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_requests(
        project_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, entry_id TEXT NOT NULL,
        PRIMARY KEY(project_id,request_id));
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    `);
    // 迁移：v0.1.0 旧库无 provider_id。旧会话保持 NULL（不可靠记录不擅自绑定当前供应商），
    // 用户在界面确认绑定后才能真实调用。
    try { db.exec(`ALTER TABLE sessions ADD COLUMN provider_id TEXT`); } catch { /* 已存在 */ }
    this.db = db;
    return db;
  }

  close() { try { this.db?.close(); } catch { /* ignore */ } this.db = null; }

  // ---- projects ----
  createProject(p: Project): void {
    this.ensure().prepare('INSERT INTO projects(id,name,root_path,is_git,created_at) VALUES (?,?,?,?,?)')
      .run(p.id, p.name, p.rootPath, p.isGit ? 1 : 0, p.createdAt);
  }
  listProjects(): Project[] {
    return this.ensure().prepare('SELECT * FROM projects ORDER BY created_at').all().map((r: any) => ({
      id: r.id, name: r.name, rootPath: r.root_path, isGit: !!r.is_git, createdAt: r.created_at,
    }));
  }
  getProject(id: string): Project | null {
    const r: any = this.ensure().prepare('SELECT * FROM projects WHERE id=?').get(id);
    return r ? { id: r.id, name: r.name, rootPath: r.root_path, isGit: !!r.is_git, createdAt: r.created_at } : null;
  }

  // ---- 项目内经验条目 ----
  private rowToMemory(r: any): MemoryEntry {
    return { id:r.id, projectId:r.project_id, kind:r.kind, title:r.title, body:r.body, source:r.source,
      taskId:r.task_id ?? null, evidenceRefs:JSON.parse(r.evidence_json || '[]'), status:r.status,
      version:Number(r.version), createdAt:r.created_at, updatedAt:r.updated_at,
      expiresAt:r.expires_at ?? null, replacedById:r.replaced_by_id ?? null };
  }
  createMemoryEntry(entry: MemoryEntry, requestId?: string): void {
    this.ensure().prepare(`INSERT INTO memory_entries(id,project_id,kind,title,body,source,task_id,evidence_json,status,version,
      created_at,updated_at,expires_at,replaced_by_id,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(entry.id,entry.projectId,entry.kind,entry.title,entry.body,entry.source,entry.taskId,
        JSON.stringify(entry.evidenceRefs),entry.status,entry.version,entry.createdAt,entry.updatedAt,
        entry.expiresAt,entry.replacedById,requestId ?? null);
  }
  getMemoryEntry(id: string): MemoryEntry | null {
    const r:any=this.ensure().prepare('SELECT * FROM memory_entries WHERE id=?').get(id);
    return r ? this.rowToMemory(r) : null;
  }
  listMemoryEntries(projectId: string): MemoryEntry[] {
    return (this.ensure().prepare('SELECT * FROM memory_entries WHERE project_id=? ORDER BY updated_at DESC,id').all(projectId) as any[]).map(r=>this.rowToMemory(r));
  }
  updateMemoryEntry(entry: MemoryEntry): void {
    this.ensure().prepare(`UPDATE memory_entries SET title=?,body=?,source=?,task_id=?,evidence_json=?,status=?,version=?,
      updated_at=?,expires_at=?,replaced_by_id=? WHERE id=? AND project_id=?`)
      .run(entry.title,entry.body,entry.source,entry.taskId,JSON.stringify(entry.evidenceRefs),entry.status,entry.version,
        entry.updatedAt,entry.expiresAt,entry.replacedById,entry.id,entry.projectId);
  }
  saveMemoryHistory(entry: MemoryEntry): void {
    this.ensure().prepare('INSERT OR IGNORE INTO memory_entry_history(entry_id,version,snapshot_json,archived_at) VALUES (?,?,?,?)')
      .run(entry.id,entry.version,JSON.stringify(entry),new Date().toISOString());
  }
  listMemoryHistory(entryId: string): MemoryEntry[] {
    return (this.ensure().prepare('SELECT snapshot_json FROM memory_entry_history WHERE entry_id=? ORDER BY version').all(entryId) as any[])
      .map(r=>JSON.parse(r.snapshot_json));
  }
  getMemoryRequest(projectId: string, requestId: string): {fingerprint:string;entryId:string}|null {
    const r:any=this.ensure().prepare('SELECT fingerprint,entry_id FROM memory_requests WHERE project_id=? AND request_id=?').get(projectId,requestId);
    return r ? {fingerprint:r.fingerprint,entryId:r.entry_id} : null;
  }
  createMemoryRequest(projectId: string, requestId: string, fingerprint: string, entryId: string): void {
    this.ensure().prepare('INSERT INTO memory_requests(project_id,request_id,fingerprint,entry_id) VALUES (?,?,?,?)')
      .run(projectId,requestId,fingerprint,entryId);
  }
  getTaskMemoryInjection(taskId: string): MemoryInjectionSnapshot|null {
    const r:any=this.ensure().prepare('SELECT snapshot_json FROM task_memory_injections WHERE task_id=?').get(taskId);
    return r ? JSON.parse(r.snapshot_json) : null;
  }
  saveTaskMemoryInjection(snapshot: MemoryInjectionSnapshot): MemoryInjectionSnapshot {
    this.ensure().prepare(`INSERT OR IGNORE INTO task_memory_injections(task_id,project_id,query_text,created_at,char_budget,snapshot_json)
      VALUES (?,?,?,?,?,?)`).run(snapshot.taskId,snapshot.projectId,snapshot.query,snapshot.createdAt,snapshot.charBudget,JSON.stringify(snapshot));
    return this.getTaskMemoryInjection(snapshot.taskId)!;
  }

  // ---- sessions ----
  createSession(s: NewSessionInput): void {
    const now = new Date().toISOString();
    this.ensure().prepare(`INSERT INTO sessions(id,project_id,kind,parent_session_id,title,agent_id,model,status,cwd,scope_json,delegation_json,provider_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.id, s.projectId, s.kind, s.parentSessionId ?? null, s.title, s.agentId, s.model,
        'idle', s.cwd, JSON.stringify(s.scope), s.delegation ? JSON.stringify(s.delegation) : null,
        s.providerId ?? null, now, now);
  }
  bindProvider(id: string, providerId: string): void {
    this.ensure().prepare('UPDATE sessions SET provider_id=?, updated_at=? WHERE id=?')
      .run(providerId, new Date().toISOString(), id);
  }
  getSession(id: string): SessionRow | null {
    const r: any = this.ensure().prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return r ? this.rowToSession(r) : null;
  }
  recentSessions(projectId?: string): SessionRow[] {
    const db=this.ensure();
    const rows=projectId
      ? db.prepare('SELECT * FROM sessions WHERE project_id=? ORDER BY created_at DESC LIMIT 200').all(projectId)
      : db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 200').all();
    return (rows as any[]).map(r=>this.rowToSession(r)).reverse();
  }
  listSessions(projectId: string): SessionRow[] {
    return this.ensure().prepare('SELECT * FROM sessions WHERE project_id=? ORDER BY created_at').all(projectId)
      .map((r: any) => this.rowToSession(r));
  }
  listSubtasks(parentSessionId: string): SessionRow[] {
    return this.ensure().prepare("SELECT * FROM sessions WHERE parent_session_id=? ORDER BY created_at").all(parentSessionId)
      .map((r: any) => this.rowToSession(r));
  }
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'status' | 'nativeSessionId' | 'summary' | 'title' | 'cwd' | 'model'>>): void {
    const sets: string[] = []; const vals: any[] = [];
    if (patch.status !== undefined) { sets.push('status=?'); vals.push(patch.status); }
    if (patch.nativeSessionId !== undefined) { sets.push('native_session_id=?'); vals.push(patch.nativeSessionId); }
    if (patch.summary !== undefined) { sets.push('summary=?'); vals.push(patch.summary); }
    if (patch.title !== undefined) { sets.push('title=?'); vals.push(patch.title); }
    if (patch.cwd !== undefined) { sets.push('cwd=?'); vals.push(patch.cwd); }
    if (patch.model !== undefined) { sets.push('model=?'); vals.push(patch.model); }
    if (!sets.length) return;
    sets.push('updated_at=?'); vals.push(new Date().toISOString()); vals.push(id);
    this.ensure().prepare(`UPDATE sessions SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }

  // 启动恢复：仍在 running/waiting_permission 的会话如实标记为 resuming（native 恢复失败再标 interrupted）
  markRunningAsResuming(): string[] {
    const rows = this.ensure().prepare("SELECT id FROM sessions WHERE status IN ('running','waiting_permission')").all() as unknown as any[];
    for (const r of rows) this.updateSession(r.id, { status: 'resuming' });
    return rows.map((r) => r.id);
  }

  private rowToSession(r: any): SessionRow {
    return {
      id: r.id, projectId: r.project_id, kind: r.kind, parentSessionId: r.parent_session_id,
      title: r.title, agentId: r.agent_id, model: r.model, status: r.status as SessionStatus,
      nativeSessionId: r.native_session_id, cwd: r.cwd, scopeJson: r.scope_json,
      delegationJson: r.delegation_json, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at,
      providerId: r.provider_id ?? null,
    };
  }

  // ---- events（append-only，UNIQUE(session,seq) 保证重放不重复）----
  appendEvent(sessionId: string, type: string, payload: any): WorkbenchEvent {
    const row = this.ensure().prepare(
      'INSERT INTO events(session_id,seq,type,payload,created_at) ' +
      'VALUES (?, COALESCE((SELECT MAX(seq)+1 FROM events WHERE session_id=?),1), ?, ?, ?) ' +
      'RETURNING id, seq, created_at')
      .get(sessionId, sessionId, type, JSON.stringify(payload ?? {}), new Date().toISOString()) as any;
    const event = { id: Number(row.id), seq: Number(row.seq), sessionId, type: type as any, payload, createdAt: row.created_at };
    for (const fn of [...this.eventListeners]) { try { fn(event); } catch { /* subscriber must not break persistence */ } }
    return event;
  }
  listEvents(sessionId: string, sinceSeq = 0, limit = 2000): WorkbenchEvent[] {
    const rows = this.ensure().prepare(
      'SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(sessionId, sinceSeq, limit) as unknown as any[];
    return rows.map((r) => ({ id: r.id, seq: r.seq, sessionId: r.session_id, type: r.type, payload: JSON.parse(r.payload), createdAt: r.created_at }));
  }
  lastSeq(sessionId: string): number {
    const r: any = this.ensure().prepare('SELECT MAX(seq) AS m FROM events WHERE session_id=?').get(sessionId);
    return r?.m ? Number(r.m) : 0;
  }

  latestEventId(): number {
    const row: any = this.ensure().prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get();
    return Number(row.id);
  }

  // Only completed main-task turns enter the nightly queue. The cursor is advanced
  // after each result has been distilled, so an interrupted run can resume safely.
  nightlyResultEvents(afterId: number, limit = 20): Array<{ id:number; seq:number; taskId:string; projectId:string; title:string; resultText:string }> {
    const rows = this.ensure().prepare(`SELECT e.id,e.seq,e.session_id,e.payload,s.project_id,s.title
      FROM events e JOIN sessions s ON s.id=e.session_id
      WHERE e.id>? AND e.type='result' AND s.kind='main'
        AND s.status NOT IN ('failed','canceled','stopped','timeout')
        AND json_extract(e.payload,'$.isError')=0
      ORDER BY e.id LIMIT ?`).all(afterId,limit) as any[];
    return rows.map((row) => ({ id:Number(row.id),seq:Number(row.seq),taskId:row.session_id,
      projectId:row.project_id,title:row.title,resultText:String(JSON.parse(row.payload).text ?? '') }));
  }

  lastUserMessageBefore(sessionId: string, seq: number): string {
    const row: any = this.ensure().prepare(`SELECT payload FROM events WHERE session_id=? AND seq<?
      AND type='message' AND json_extract(payload,'$.role')='user' ORDER BY seq DESC LIMIT 1`).get(sessionId,seq);
    return row ? String(JSON.parse(row.payload).text ?? '') : '';
  }

  // ---- 工具执行守卫：同 key 只执行一次（重放/重复事件安全）----
  firstRun(sessionId: string, toolKey: string): { first: boolean; previous: any | null } {
    const existing: any = this.ensure().prepare('SELECT result_json FROM executed_tools WHERE session_id=? AND tool_key=?')
      .get(sessionId, toolKey);
    if (existing) return { first: false, previous: existing.result_json ? JSON.parse(existing.result_json) : null };
    this.ensure().prepare('INSERT INTO executed_tools(session_id,tool_key,result_json,created_at) VALUES (?,?,NULL,?)')
      .run(sessionId, toolKey, new Date().toISOString());
    return { first: true, previous: null };
  }
  completeTool(sessionId: string, toolKey: string, result: any): void {
    this.ensure().prepare('UPDATE executed_tools SET result_json=? WHERE session_id=? AND tool_key=?')
      .run(JSON.stringify(result ?? null), sessionId, toolKey);
  }

  // ---- kv / settings ----
  getKV(key: string): string | null {
    const r: any = this.ensure().prepare('SELECT value FROM kv WHERE key=?').get(key);
    return r ? r.value : null;
  }
  setKV(key: string, value: string): void {
    this.ensure().prepare('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
  deleteKV(key: string): void {
    this.ensure().prepare('DELETE FROM kv WHERE key=?').run(key);
  }

  // 泄漏测试辅助：在本地库内检索哨兵字符串（仅用于假密钥哨兵，不用于真实凭据）
  countOccurrences(needle: string): number {
    let n = 0;
    for (const t of ['projects', 'sessions', 'events', 'executed_tools', 'kv', 'memory_entries', 'memory_entry_history', 'memory_requests', 'task_memory_injections']) {
      const cols: any[] = this.ensure().prepare(`PRAGMA table_info(${t})`).all();
      for (const c of cols) {
        const rows: any[] = this.ensure().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE CAST(${c.name} AS TEXT) LIKE ?`)
          .all(`%${needle}%`);
        n += Number(rows[0]?.n ?? 0);
      }
    }
    return n;
  }
}
