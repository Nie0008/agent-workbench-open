import {projectName} from './project-name';
import { ProgressPanel } from './progress';
import { useTaskNotices } from './task-notices';
// Agent Workbench 主界面：三栏布局（项目/任务 | 主对话 | 文件/差异/子任务）
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkbenchEvent, Project, SessionRow, FileNode, ProviderInfo, ModelProfile, ModelAgentId, Settings, DiffLine, MemoryEntry, MemoryInjectionSnapshot, MemoryKind } from '../shared/types';
import { Markdownish, StatusDot, STATUS_LABEL, ToolCard, DiffLines, parsePatch } from './ui';
import { selectedSessionId, unwrapSendResult } from './send';

const wb = (window as any).wb;
const api = (ch: string, p?: any) => wb.invoke(ch, p);

interface AppInfo {
  version: string; dataDir: string; providers: ProviderInfo[]; defaultProviderId: string;
  profiles: ModelProfile[]; sources: ProviderInfo[];
  combinations: { agentId: string; profileId: string; providerId: string; model: string }[];
  defaultTaskCombo: { agentId: string; profileId: string; providerId: string; model: string } | null;
  adapters: { id: string; displayName: string; verified: boolean }[]; settings: Settings;
}

type ConvItem =
  | { k: string; t: 'msg'; role: 'user' | 'assistant'; text: string }
  | { k: string; t: 'tool'; ev: WorkbenchEvent; result?: WorkbenchEvent }
  | { k: string; t: 'perm'; ev: WorkbenchEvent; resolved?: WorkbenchEvent }
  | { k: string; t: 'files'; evs: WorkbenchEvent[] }
  | { k: string; t: 'notice'; text: string; kind?: 'info' | 'delegated' | 'substatus' }
  | { k: string; t: 'usage'; text: string }
  | { k: string; t: 'result'; text: string; isError: boolean; numTurns: number }
  | { k: string; t: 'error'; text: string }
  | { k: string; t: 'conflict'; text: string }
  | { k: string; t: 'status'; text: string };

function buildConv(events: WorkbenchEvent[]): ConvItem[] {
  const items: ConvItem[] = [];
  const toolIdx = new Map<string, number>();
  const permIdx = new Map<string, number>();
  let fileBuf: WorkbenchEvent[] = [];
  const flushFiles = () => {
    if (fileBuf.length) { items.push({ k: `files-${fileBuf[0].seq}`, t: 'files', evs: [...fileBuf] }); fileBuf = []; }
  };
  for (const ev of events) {
    const p = ev.payload ?? {};
    switch (ev.type) {
      case 'message':
        flushFiles();
        items.push({ k: `m${ev.seq}`, t: 'msg', role: p.role, text: p.text });
        break;
      case 'tool_request': {
        flushFiles();
        items.push({ k: `t${ev.seq}`, t: 'tool', ev });
        toolIdx.set(p.toolUseId, items.length - 1);
        break;
      }
      case 'tool_result': {
        const i = toolIdx.get(p.toolUseId);
        if (i != null && items[i].t === 'tool') (items[i] as any).result = ev;
        else { flushFiles(); items.push({ k: `t${ev.seq}`, t: 'tool', ev: { ...ev, payload: { name: p.name ?? 'tool', input: {} } }, result: ev }); }
        break;
      }
      case 'permission_request':
        flushFiles();
        items.push({ k: `p${ev.seq}`, t: 'perm', ev });
        permIdx.set(p.permissionId, items.length - 1);
        break;
      case 'permission_resolved': {
        const i = permIdx.get(p.permissionId);
        if (i != null && items[i].t === 'perm') (items[i] as any).resolved = ev;
        break;
      }
      case 'file_change': fileBuf.push(ev); break;
      case 'task_delegated':
        flushFiles();
        items.push({ k: `d${ev.seq}`, t: 'notice', kind: 'delegated', text: `委派子任务「${p.title}」 ${p.subTaskId?.slice(0, 8) ?? ''}` });
        break;
      case 'subtask_status':
        flushFiles();
        items.push({ k: `s${ev.seq}`, t: 'notice', kind: 'substatus', text: `子任务状态: ${STATUS_LABEL[p.status] ?? p.status}${p.summary ? ` — ${p.summary}` : ''}` });
        break;
      case 'usage':
        flushFiles();
        items.push({ k: `u${ev.seq}`, t: 'usage', text: `用量: 输入 ${p.inputTokens ?? 0} tok · 输出 ${p.outputTokens ?? 0} tok${p.cacheReadTokens ? ` · 缓存读 ${p.cacheReadTokens}` : ''} · 费用${p.costUSD != null ? ` $${p.costUSD}` : '未知（无可靠计价）'}` });
        break;
      case 'result':
        flushFiles();
        items.push({ k: `r${ev.seq}`, t: 'result', text: p.text, isError: !!p.isError, numTurns: p.numTurns ?? 0 });
        break;
      case 'error':
        flushFiles();
        items.push({ k: `e${ev.seq}`, t: 'error', text: p.message });
        break;
      case 'conflict':
        flushFiles();
        items.push({ k: `c${ev.seq}`, t: 'conflict', text: `冲突（${p.kind === 'merge' ? '合并' : '写入'}）: ${p.detail ?? ''}${p.path ? ` 文件: ${p.path}` : ''}` });
        break;
      case 'notice':
        flushFiles();
        items.push({ k: `n${ev.seq}`, t: 'notice', text: p.text });
        break;
      case 'session': {
        const st = p.status as string;
        if (p.previous && ['stopped', 'canceled', 'timeout', 'interrupted', 'failed', 'completed'].includes(st)) {
          flushFiles();
          items.push({ k: `st${ev.seq}`, t: 'status', text: `${STATUS_LABEL[st] ?? st}${p.reason ? `：${p.reason}` : ''}` });
        }
        break;
      }
      default: break;
    }
  }
  flushFiles();
  return items;
}

export default function App() {
  const {notices,ack}=useTaskNotices();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [eventsBy, setEventsBy] = useState<Record<string, WorkbenchEvent[]>>({});
  const [streamBy, setStreamBy] = useState<Record<string, string>>({});
  const [currentMainId, setCurrentMainId] = useState<string>('');
  const [subViewId, setSubViewId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'files' | 'diff' | 'subtasks'>('files');
  const [rightOpen, setRightOpen] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const [narrow, setNarrow] = useState(window.innerWidth < 1080);
  const [rightW, setRightW] = useState(380);
  const [fileSel, setFileSel] = useState<string | null>(null);
  const [fileMode, setFileMode] = useState<'read' | 'edit'>('read');
  const [fileContent, setFileContent] = useState('');
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [factsOpen, setFactsOpen] = useState(false);
  const [progressOpen,setProgressOpen]=useState(true);
  const [bindTarget, setBindTarget] = useState<{ sessionId: string; text: string } | null>(null);
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState('');
  const [subInput, setSubInput] = useState('');
  const [subSendError, setSubSendError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const seqsRef = useRef<Record<string, number>>({});
  const haveRef = useRef<Set<string>>(new Set());
  const treeRef = useRef<FileNode | null>(null);
  const [treeVer, setTreeVer] = useState(0);

  const loadProjects = useCallback(async () => {
    const r = await api('projects.list');
    if (r.ok) {
      setProjects(r.data);
      setProjectId((cur) => cur || r.data[0]?.id || '');
    }
  }, []);

  const loadSessions = useCallback(async (pid: string) => {
    if (!pid) { setSessions([]); return; }
    const r = await api('sessions.list', { projectId: pid });
    if (r.ok) {
      setSessions(r.data);
      setCurrentMainId((cur) => {
        if (cur && r.data.some((s: SessionRow) => s.id === cur)) return cur;
        return r.data.filter((s: SessionRow) => s.kind === 'main').slice(-1)[0]?.id ?? '';
      });
    }
  }, []);

  const ensureEvents = useCallback(async (sessionId: string) => {
    const since = seqsRef.current[sessionId] ?? 0;
    if (since > 0 && haveRef.current.has(sessionId)) return;
    const r = await api('events.list', { sessionId, sinceSeq: 0 });
    if (r.ok) {
      const evs: WorkbenchEvent[] = r.data;
      setEventsBy((m) => ({ ...m, [sessionId]: evs }));
      seqsRef.current[sessionId] = evs.length ? evs[evs.length - 1].seq : 0;
      haveRef.current.add(sessionId);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api('app.info');
      if (r.ok) setInfo(r.data);
      await loadProjects();
    })();
    const unsub = wb.onEvent((e: WorkbenchEvent) => {
      const last = seqsRef.current[e.sessionId] ?? 0;
      if (e.seq <= last) return;   // 客户端去重
      if (haveRef.current.has(e.sessionId) && e.seq > last + 1) {
        // 序号缺口（初始化竞态）：重拉全量
        haveRef.current.delete(e.sessionId);
        seqsRef.current[e.sessionId] = 0;
        void ensureEvents(e.sessionId);
        return;
      }
      seqsRef.current[e.sessionId] = e.seq;
      setEventsBy((m) => ({ ...m, [e.sessionId]: [...(m[e.sessionId] ?? []), e] }));
      if (e.type === 'text_delta') setStreamBy((m) => ({ ...m, [e.sessionId]: (m[e.sessionId] ?? '') + e.payload.text }));
      if (e.type === 'message' && e.payload.role === 'assistant') setStreamBy((m) => ({ ...m, [e.sessionId]: '' }));
      if (e.type === 'session' || e.type === 'result') {
        api('sessions.list', { projectId }).then((r2: any) => { if (r2.ok) setSessions(r2.data); });
      }
      if (e.type === 'task_delegated') {
        api('sessions.list', { projectId }).then((r2: any) => { if (r2.ok) setSessions(r2.data); });
      }
    });
    const onResize = () => { setNarrow(window.innerWidth < 1080); if (window.innerWidth >= 1080) { setLeftOpen(true); setRightOpen(true); } };
    window.addEventListener('resize', onResize);
    return () => { unsub(); window.removeEventListener('resize', onResize); };
  }, [loadProjects, projectId]);

  useEffect(() => { if (projectId) loadSessions(projectId); }, [projectId, loadSessions]);
  useEffect(() => {
    if (currentMainId) ensureEvents(currentMainId);
    if (subViewId) ensureEvents(subViewId);
  }, [currentMainId, subViewId, ensureEvents]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [eventsBy, streamBy, subViewId, currentMainId]);

  const currentMain = sessions.find((s) => s.id === currentMainId) ?? null;
  const subtasks = useMemo(() => sessions.filter((s) => s.kind === 'sub' && s.parentSessionId === currentMainId), [sessions, currentMainId]);
  const convSessionId = subViewId ?? currentMainId;
  const convSession = sessions.find((s) => s.id === convSessionId) ?? null;
  const convEvents = eventsBy[convSessionId] ?? [];
  const conv = useMemo(() => buildConv(convEvents), [convEvents]);
  const streamText = streamBy[convSessionId] ?? '';

  const sendInput = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    const targetId = selectedSessionId(subViewId, currentMainId);
    if (!text || !targetId) return;
    setSendError('');
    const r = await api('task.send', { sessionId: targetId, text, clientMsgId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    // IPC wraps handler results in {ok, data}; unwrap the task result so business
    // failures (including a missing provider) are not mistaken for success.
    const result = unwrapSendResult(r);
    if (!result.ok) {
      if (result.needsProvider) setBindTarget({ sessionId: targetId, text });
      setSendError(result.error ?? '发送失败');
      return; // 保留草稿，用户可修正后重试
    }
    if (overrideText === undefined) setInput('');
    setSessions((s) => s.map((x) => x.id === targetId ? { ...x, status: 'running' } : x));
  };
  const sendSubInput = async () => {
    const text = subInput.trim();
    if (!text || !subViewId) return;
    setSubSendError('');
    const r = await api('task.send', { sessionId: subViewId, text, clientMsgId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    const result = unwrapSendResult(r);
    if (!result.ok) {
      setSubSendError(result.error ?? '发送失败');
      return;
    }
    setSubInput('');
  };
  const stopSession = async (id: string) => { await api('task.cancel', { sessionId: id }); };

  const loadTree = useCallback(async () => {
    if (!convSessionId) { treeRef.current = null; setTreeVer((v) => v + 1); return; }
    const r = await api('files.tree', { sessionId: convSessionId, depth: 4 });
    if (r.ok) { treeRef.current = r.data; setTreeVer((v) => v + 1); }
  }, [convSessionId]);
  useEffect(() => { loadTree(); }, [loadTree, convSession?.cwd]);

  const openFile = async (path: string) => {
    setFileSel(path); setFileMode('read'); setRightOpen(true); setRightTab('files');
    const r = await api('files.read', { sessionId: convSessionId, path });
    setFileContent(r.ok ? r.data.content : `读取失败: ${r.error}`);
  };
  const saveFile = async () => {
    if (!fileSel) return;
    const r = await api('files.write', { sessionId: convSessionId, path: fileSel, content: fileContent });
    if (!r.ok) alert(`保存失败: ${r.error}`);
    loadTree();
  };
  const openDiff = async (path: string) => {
    setDiffPath(path); setRightOpen(true); setRightTab('diff');
  };

  const fileTreeNodes = useMemo(() => treeRef.current, [treeVer]);
  const changedFiles = useMemo(() => {
    const map = new Map<string, string>();
    for (const ev of convEvents) {
      if (ev.type === 'file_change') map.set(ev.payload.path, ev.payload.change);
    }
    return [...map.entries()];
  }, [convEvents]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX; const startW = rightW;
    const move = (ev: MouseEvent) => setRightW(Math.min(640, Math.max(240, startW + (startX - ev.clientX))));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const running = (s: SessionRow | null) => s && ['running', 'waiting_permission', 'resuming'].includes(s.status);

  return (
    <>
      <div className="titlebar">
        <div className="logo" />
        <div className="name">Agent Workbench</div>
        <span className="pill" title={`数据目录 ${info?.dataDir ?? ''}`}>v{info?.version ?? '…'}</span>
        <div className="spacer" />
        {narrow && <button className={`ghost-btn ${leftOpen ? 'on' : ''}`} onClick={() => { setLeftOpen(!leftOpen); setRightOpen(false); }}>任务</button>}
        {!progressOpen && convSession && narrow && <button className={`ghost-btn ${rightOpen ? 'on' : ''}`} onClick={() => { setRightOpen(!rightOpen); setLeftOpen(false); }}>文件</button>}
        {!progressOpen && convSession && !narrow && <button className={`ghost-btn ${rightOpen ? 'on' : ''}`} onClick={() => setRightOpen(!rightOpen)}>{rightOpen ? '收起面板' : '展开面板'}</button>}
        <button className="ghost-btn" onClick={() => setProgressOpen(true)}>任务看板{notices.length ? ` · ${notices.length} 条新动态` : ''}</button>
        <button className="ghost-btn" onClick={() => setModelsOpen(true)}>模型配置</button>
        <button className="ghost-btn" onClick={() => { void api('app.hide').then((r: any) => { if (!r.ok) window.alert(r.error); }); }}>收起到菜单栏</button>
        <button className="ghost-btn" onClick={() => setFactsOpen(true)}>项目背景</button>
      </div>

      <div className={`layout ${narrow ? 'narrow' : ''} ${rightOpen ? '' : 'right-closed'}`}>
        {/* 左栏 */}
        <div className={`left ${narrow && leftOpen ? 'narrow-overlay' : ''}`} style={narrow && !leftOpen ? { display: 'none' } : undefined}>
          <div className="proj-row">
            <select className="proj-select" value={projectId} onChange={(e) => { setProjectId(e.target.value); setCurrentMainId(''); setSubViewId(null); }}>
              {projects.length === 0 && <option value="">（无项目）</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{projectName(p)}{p.isGit ? ' ⟳git' : ''}</option>)}
            </select>
          </div>
          <button className="newtask-btn" onClick={() => { if (!projectId) { alert('请先新建项目'); setNewProjOpen(true); } else setNewTaskOpen(true); }}>＋ 新建任务</button>
          <div className="tasklist">
            {sessions.filter((s) => s.kind === 'main').length === 0 && <div className="hint">还没有任务。点击「新建任务」开始。</div>}
            {sessions.filter((s) => s.kind === 'main').map((s) => (
              <React.Fragment key={s.id}>
                <div className={`task-item ${s.id === currentMainId ? 'active' : ''}`} onClick={() => { setCurrentMainId(s.id); setSubViewId(null); ensureEvents(s.id); }}>
                  <div className="t-row">
                    <StatusDot status={s.status} />
                    <span className="t-title">{s.title}</span>
                  </div>
                  <div className="t-meta">{STATUS_LABEL[s.status]} · {s.model}</div>
                </div>
                {sessions.filter((x) => x.kind === 'sub' && x.parentSessionId === s.id).map((sub) => (
                  <div key={sub.id} className={`task-item sub ${sub.id === subViewId ? 'active' : ''}`}
                    onClick={() => { setCurrentMainId(s.id); setSubViewId(sub.id); setRightTab('subtasks'); setRightOpen(true); ensureEvents(sub.id); }}>
                    <div className="t-row">
                      <StatusDot status={sub.status} />
                      <span className="t-title">↳ {sub.title}</span>
                    </div>
                    <div className="t-meta">{STATUS_LABEL[sub.status]}</div>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
            <button className="btn small" style={{ flex: 1 }} onClick={() => setNewProjOpen(true)}>新建项目</button>
            <button className="btn small" onClick={async () => { await loadProjects(); if (projectId) await loadSessions(projectId); }}>刷新</button>
          </div>
        </div>

        {/* 中栏 */}
        <div className="center">
          {convSession ? (
            <>
              <div className="chat-head">
                <StatusDot status={convSession.status} />
                <div className="ht">{subViewId ? `子任务 · ${convSession.title}` : convSession.title}</div>
                {convSession.agentId === 'mock' && <span className="pill mock">模拟适配器</span>}
                <span className="pill">{convSession.model}</span>
                {subViewId && <button className="btn small" onClick={() => setSubViewId(null)}>返回主对话</button>}
                {running(convSession) && <button className="btn small danger" onClick={() => stopSession(convSession.id)}>停止</button>}
              </div>
              <TaskMemoryUsed taskId={convSession.id} refreshKey={(eventsBy[convSession.id] ?? []).filter((e) => e.type === 'message' && e.payload?.role === 'user').length} />
              <div className="chat-scroll">
                <div className="chat-inner">
                  {conv.length === 0 && <div className="empty-state"><h2>开始对话</h2><div>输入需求，主 Agent 将执行任务并可在需要时委派子任务。</div></div>}
                  {conv.map((it) => <ConvItemView key={it.k} item={it} onOpenFile={openDiff} openFileRead={openFile} />)}
                  {running(convSession) && streamText && (
                    <div className="msg assistant">
                      <div className="who">assistant（流式）</div>
                      <div className="bubble streaming"><Markdownish text={streamText} /></div>
                    </div>
                  )}
                  {convSession.status === 'resuming' && (
                    <div className="notice">该任务在应用重启时仍在执行，已标记为「恢复中」。发送消息将尝试原生恢复会话；若恢复失败会如实显示为「已中断」。</div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              </div>
              <div className="composer">
                <div className="composer-inner">
                  <div className="row">
                    <textarea
                      value={input} placeholder={subViewId ? '向当前子任务发送消息，⌘+回车发送…' : '输入消息，⌘+回车发送…'}
                      onChange={(e) => { setInput(e.target.value); if (sendError) setSendError(''); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendInput(); } }}
                    />
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div className="hintline">
                      {sendError ? <span style={{ color: 'var(--danger)' }}>{sendError}</span>
                        : ['stopped', 'interrupted', 'resuming', 'timeout', 'canceled'].includes(convSession.status)
                        ? '任务已停止/中断——发送消息将以原生会话继续（恢复失败将如实标注）' : '⌘+回车 发送'}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {running(convSession) && <button className="btn danger" onClick={() => stopSession(convSession.id)}>停止</button>}
                      <button className="btn primary" disabled={!input.trim()} onClick={() => void sendInput()}>发送</button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="chat-scroll"><div className="chat-inner">
              <div className="empty-state">
                <h2>Agent Workbench</h2>
                <div>左侧选择项目并新建任务；Claude Code、Grok、DSH、ZCode 可在工作台中登记和跟踪。</div>
              </div>
            </div></div>
          )}
        </div>

        {/* 右栏（含拖拽调宽把手） */}
        {rightOpen && (
          <div className="rightwrap" style={narrow ? undefined : { width: rightW + 5 }}>
            {!narrow && <div className="resize-handle" onMouseDown={startResize} />}
            <div className={`right ${narrow ? 'narrow-overlay' : ''}`} style={{ flex: 1, minWidth: 0 }}>
            <div className="right-tabs">
              <button className={rightTab === 'files' ? 'active' : ''} onClick={() => setRightTab('files')}>文件</button>
              <button className={rightTab === 'diff' ? 'active' : ''} onClick={() => setRightTab('diff')}>差异</button>
              <button className={rightTab === 'subtasks' ? 'active' : ''} onClick={() => { setRightTab('subtasks'); if (!subViewId && subtasks.length) setSubViewId(subtasks[0].id); }}>
                子任务{subtasks.length ? ` (${subtasks.length})` : ''}
              </button>
            </div>
            <div className="right-body">
              {rightTab === 'files' && (
                fileSel ? (
                  <div className="viewer">
                    <div className="viewer-head">
                      <span className="path">{fileSel}</span>
                      <button className="btn small" onClick={() => openDiff(fileSel)}>差异</button>
                      {fileMode === 'read' ? <button className="btn small" onClick={() => setFileMode('edit')}>编辑</button> : <button className="btn small primary" onClick={saveFile}>保存</button>}
                      <button className="btn small" onClick={() => setFileSel(null)}>关闭</button>
                    </div>
                    {fileMode === 'edit'
                      ? <textarea className="editor" value={fileContent} onChange={(e) => setFileContent(e.target.value)} spellCheck={false} />
                      : <pre className="readview">{fileContent}</pre>}
                  </div>
                ) : (
                  <FileTreeView root={fileTreeNodes} onOpen={openFile} />
                )
              )}
              {rightTab === 'diff' && <DiffPanel convSessionId={convSessionId} changedFiles={changedFiles} diffPath={diffPath} setDiffPath={setDiffPath} cwdHint={convSession?.cwd} />}
              {rightTab === 'subtasks' && (
                <SubTasksPanel
                  subtasks={subtasks} subViewId={subViewId} setSubViewId={setSubViewId}
                  eventsBy={eventsBy} subInput={subInput} setSubInput={setSubInput} subSendError={subSendError} setSubSendError={setSubSendError} sendSubInput={sendSubInput}
                  stopSession={stopSession} openDiff={openDiff} openFileRead={openFile} projectId={projectId}
                  onMerged={() => { loadTree(); }}
                />
              )}
            </div>
            </div>
          </div>
        )}
      </div>

      {!progressOpen && notices.length>0 && <div className="task-notice-banner" role="status"><span>{notices[0].label} · {notices.length} 条新动态</span><button className="btn" onClick={()=>setProgressOpen(true)}>打开看板查看</button></div>}
      {progressOpen && <ProgressPanel notices={notices} ack={ack} onClose={()=>setProgressOpen(false)} onOpen={t=>{setProjectId(t.projectId);setCurrentMainId(t.parentTaskId??t.taskId);setSubViewId(t.parentTaskId?t.taskId:null);ensureEvents(t.taskId);setProgressOpen(false);}} />}
      {newTaskOpen && <NewTaskModal info={info} projectId={projectId} onClose={() => setNewTaskOpen(false)} onCreated={(id) => { setNewTaskOpen(false); loadSessions(projectId); setCurrentMainId(id); setSubViewId(null); }} />}
      {modelsOpen && <ModelManagerModal info={info} onClose={async () => { setModelsOpen(false); const r = await api('app.info'); if (r.ok) setInfo(r.data); }} />}
      {newProjOpen && <NewProjectModal onClose={() => setNewProjOpen(false)} onCreated={async (id) => { setNewProjOpen(false); await loadProjects(); setProjectId(id); }} />}
      {factsOpen && projectId && <FactsModal projectId={projectId} taskId={subViewId ?? currentMainId} onClose={() => setFactsOpen(false)} />}
      {bindTarget && <BindProviderModal info={info} sessionId={bindTarget.sessionId} onClose={() => setBindTarget(null)} onBound={async () => {
        const t = bindTarget; setBindTarget(null);
        await loadSessions(projectId);
        if (t) void sendInput(t.text);
      }} />}
    </>
  );
}

function ConvItemView({ item, onOpenFile, openFileRead }: { item: ConvItem; onOpenFile: (p: string) => void; openFileRead: (p: string) => void }) {
  switch (item.t) {
    case 'msg':
      return (
        <div className={`msg ${item.role}`}>
          <div className="who">{item.role === 'user' ? 'user' : 'assistant'}</div>
          <div className="bubble"><Markdownish text={item.text} /></div>
        </div>
      );
    case 'tool':
      return <ToolCard ev={item.ev} result={item.result} onOpenFile={onOpenFile} />;
    case 'perm': {
      const pending = !item.resolved;
      const decision = item.resolved?.payload.decision;
      return (
        <div className={`card ${pending ? 'perm-card' : ''}`}>
          <div className="card-head" style={{ cursor: 'default' }}>
            <span>🔐 授权请求</span>
            <span className="tool-name">{item.ev.payload.toolName}</span>
            <span className="tool-state">{pending ? '等待你的决定' : decision === 'allow' ? '已允许' : '已拒绝'}</span>
          </div>
          <div className="card-body"><div className="tool-input">{JSON.stringify(item.ev.payload.input, null, 2)}</div></div>
          {pending && <PermActions permissionId={item.ev.payload.permissionId} />}
        </div>
      );
    }
    case 'files':
      return (
        <div className="chip-row">
          {item.evs.map((ev) => (
            <span key={ev.seq} className="file-chip" onClick={() => onOpenFile(ev.payload.path)} title="查看差异">
              <span className={ev.payload.change === 'add' ? 'fc-add' : ev.payload.change === 'delete' ? 'fc-del' : 'fc-mod'}>
                {ev.payload.change === 'add' ? 'A' : ev.payload.change === 'delete' ? 'D' : 'M'}
              </span>
              {ev.payload.path}
            </span>
          ))}
        </div>
      );
    case 'notice':
      if (item.kind === 'delegated') return <div className="notice" style={{ borderColor: 'rgba(171,125,248,.5)' }}>🪃 {item.text}</div>;
      return <div className="notice">{item.text}</div>;
    case 'usage': return <div className="usage-line">{item.text}</div>;
    case 'result':
      return (
        <div className={`card result-card ${item.isError ? 'fail' : ''}`}>
          <div className="card-head" style={{ cursor: 'default' }}>
            <span>{item.isError ? '⚠️ 回合结束（出错）' : '✅ 回合完成'}</span>
            <span className="tool-state">{item.numTurns} turns</span>
          </div>
          <div className="card-body" style={{ whiteSpace: 'pre-wrap' }}>{item.text}</div>
        </div>
      );
    case 'error':
      return (
        <div className="card err-card">
          <div className="card-head" style={{ cursor: 'default' }}><span>❌ 错误</span></div>
          <div className="card-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.text}</div>
        </div>
      );
    case 'conflict':
      return (
        <div className="card conflict-card">
          <div className="card-head" style={{ cursor: 'default' }}><span>⚔️ 冲突（未自动覆盖）</span></div>
          <div className="card-body" style={{ whiteSpace: 'pre-wrap' }}>{item.text}</div>
        </div>
      );
    case 'status':
      return <div className="notice" style={{ opacity: 0.75 }}>· {item.text}</div>;
    default: return null;
  }
}

function PermActions({ permissionId }: { permissionId: string }) {
  const [done, setDone] = useState<string | null>(null);
  const act = async (decision: 'allow' | 'deny') => {
    setDone(decision);
    await api('permissions.respond', { permissionId, decision });
  };
  return (
    <div className="perm-actions">
      <button className="btn primary" disabled={!!done} onClick={() => act('allow')}>允许</button>
      <button className="btn danger" disabled={!!done} onClick={() => act('deny')}>拒绝</button>
      <span style={{ fontSize: 11, color: 'var(--text-faint)', alignSelf: 'center' }}>拒绝后对应工具不会执行</span>
    </div>
  );
}

function FileTreeView({ root, onOpen }: { root: FileNode | null; onOpen: (p: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  if (!root) return <div className="hint" style={{ padding: 12 }}>无文件树（选择任务后显示其工作区）</div>;
  const render = (node: FileNode, depth: number): React.ReactNode[] => {
    return (node.children ?? []).map((c) => (
      <React.Fragment key={c.path}>
        <div className="node" style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => {
            if (c.type === 'file') onOpen(c.path);
            else setCollapsed((s) => { const n = new Set(s); n.has(c.path) ? n.delete(c.path) : n.add(c.path); return n; });
          }}>
          <span className="ic">{c.type === 'dir' ? (collapsed.has(c.path) ? '▸' : '▾') : '·'}</span>
          <span>{c.name}</span>
        </div>
        {c.type === 'dir' && !collapsed.has(c.path) && render(c, depth + 1)}
      </React.Fragment>
    ));
  };
  return (
    <div className="ftree">
      <div className="node" style={{ fontWeight: 600 }}>📦 {root.name || '项目'}</div>
      {render(root, 1)}
    </div>
  );
}

function DiffPanel({ convSessionId, changedFiles, diffPath, setDiffPath, cwdHint }: {
  convSessionId: string; changedFiles: [string, string][]; diffPath: string | null; setDiffPath: (p: string | null) => void; cwdHint?: string;
}) {
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!diffPath) { setDiff(null); return; }
    (async () => {
      const r = await api('files.diff', { sessionId: convSessionId, path: diffPath });
      if (!r.ok) { setErr(r.error); return; }
      setErr('');
      if (r.data.mode === 'git' && r.data.patch) setDiff(parsePatch(r.data.patch));
      else if (r.data.mode === 'git') setDiff([]);
      else setDiff(r.data.content.split('\n').map((l: string) => ({ type: 'add', text: l })));
    })();
  }, [diffPath, convSessionId]);
  return (
    <div className="diffwrap">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {changedFiles.length === 0 && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>当前会话还没有文件变更记录</span>}
        {changedFiles.map(([p, ch]) => (
          <span key={p} className={`file-chip ${diffPath === p ? 'sel' : ''}`} style={diffPath === p ? { borderColor: 'var(--accent)' } : undefined} onClick={() => setDiffPath(p)}>
            <span className={ch === 'add' ? 'fc-add' : ch === 'delete' ? 'fc-del' : 'fc-mod'}>{ch === 'add' ? 'A' : ch === 'delete' ? 'D' : 'M'}</span>{p}
          </span>
        ))}
      </div>
      {err && <div className="card err-card"><div className="card-body">{err}</div></div>}
      {diffPath && <div className="diff-file"><div className="dh">{diffPath} <span style={{ color: 'var(--text-faint)' }}>({cwdHint})</span></div>
        {diff && <DiffLines diff={diff} />}
        {diff && diff.length === 0 && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>与 HEAD 无差异</div>}
      </div>}
    </div>
  );
}

function SubTasksPanel({ subtasks, subViewId, setSubViewId, eventsBy, subInput, setSubInput, subSendError, setSubSendError, sendSubInput, stopSession, openDiff, openFileRead, projectId, onMerged }: any) {
  const [mergeMsg, setMergeMsg] = useState<Record<string, string>>({});
  const sub = subtasks.find((s: SessionRow) => s.id === subViewId) ?? subtasks[0] ?? null;
  const events = sub ? (eventsBy[sub.id] ?? []) : [];
  const conv = useMemo(() => buildConv(events), [events]);
  const doMerge = async (taskId: string) => {
    const r = await api('merge.apply', { taskId });
    let msg: string;
    if (!r.ok) msg = `合并失败: ${r.error}`;
    else if (r.data.ok) msg = `已合并: ${(r.data.changedPaths ?? []).join(', ') || '无改动'}`;
    else msg = `合并被拒绝: ${r.data.reason}`;
    setMergeMsg((m) => ({ ...m, [taskId]: msg }));
    onMerged();
  };
  if (!sub) return <div className="hint" style={{ padding: 12 }}>尚无子任务。主 Agent 在需要时会自主委派（如审查、测试）。</div>;
  return (
    <div className="subpanel">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {subtasks.map((s: SessionRow) => (
          <span key={s.id} className={`file-chip ${s.id === sub.id ? 'sel' : ''}`} style={s.id === sub.id ? { borderColor: 'var(--accent)' } : undefined} onClick={() => setSubViewId(s.id)}>
            <StatusDot status={s.status} /> {s.title}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <StatusDot status={sub.status} />
        <b style={{ fontSize: 13 }}>{sub.title}</b>
        <span className="pill">{STATUS_LABEL[sub.status]}</span>
        <div style={{ flex: 1 }} />
        <button className="btn small" onClick={() => openDiff('')}>差异</button>
        {['running', 'waiting_permission'].includes(sub.status) && <button className="btn small danger" onClick={() => stopSession(sub.id)}>停止</button>}
        {sub.status === 'completed' && <button className="btn small primary" onClick={() => doMerge(sub.id)}>合并到主树</button>}
      </div>
      {sub.delegationJson && (() => {
        const del = JSON.parse(sub.delegationJson);
        const snap = del.snapshot;
        const included = snap?.files?.filter((f: any) => f.included).length ?? 0;
        return (
          <div className="notice" style={{ marginBottom: 8, fontSize: 11.5 }}>
            <b>委派要求：</b>{del.instructions?.slice(0, 160)}
            {del.acceptance ? <><br /><b>验收：</b>{del.acceptance.slice(0, 120)}</> : null}
            {snap ? (
              <>
                <br /><b>背景快照：</b>{snap.isGit ? `git HEAD ${snap.head ?? '?'}` : '非git'} · 内联 {included}/{snap.files?.length ?? 0} 文件（{snap.totalBytes ?? 0}B）· 补丁 {snap.patchBytes ?? 0}B
                {snap.files?.some((f: any) => f.included === false) ? ` · 排除：${snap.files.filter((f: any) => !f.included).map((f: any) => f.path).join(', ')}` : ''}
              </>
            ) : null}
          </div>
        );
      })()}
      {mergeMsg[sub.id] && <div className="notice" style={{ marginBottom: 8 }}>{mergeMsg[sub.id]}</div>}
      <div className="conv">
        {conv.map((it) => <ConvItemView key={it.k} item={it} onOpenFile={openDiff} openFileRead={openFileRead} />)}
        {(eventsBy[sub.id]?.length ?? 0) === 0 && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>（加载中…）</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <div style={{ flex: 1 }}>
          <textarea style={{ width: '100%', minHeight: 34, boxSizing: 'border-box', background: 'var(--bg-elev)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, outline: 'none', resize: 'none' }}
          placeholder="向此子任务追加消息（补充要求/纠偏）…" value={subInput} onChange={(e) => { setSubInput(e.target.value); if (subSendError) setSubSendError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendSubInput(); } }} />
          {subSendError && <div className="hintline" style={{ color: 'var(--danger)', marginTop: 4 }}>{subSendError}</div>}
        </div>
        <button className="btn primary" onClick={sendSubInput} disabled={!subInput.trim()}>追加</button>
      </div>
    </div>
  );
}

type ModelDraft = Omit<ModelProfile, 'id' | 'sourceFingerprint'> & { id?: string };
const MODEL_AGENT_IDS: ModelAgentId[] = ['claude-code', 'grok', 'dsh', 'zcode'];

function ModelManagerModal({ info, onClose }: { info: AppInfo | null; onClose: () => void }) {
  const [catalog, setCatalog] = useState(info);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [sourceDraft, setSourceDraft] = useState<{
    providerId?: string; name: string; baseUrl: string; model: string; apiKey: string; authMode: 'api_key' | 'auth_token'
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    const result = await api('app.info');
    if (result.ok) setCatalog(result.data);
    else setNotice(result.error ?? '读取模型配置失败');
  };
  useEffect(() => { void refresh(); }, []);
  const newDraft = () => {
    const source = catalog?.sources.find((item) => item.providerId !== 'grok-super-oauth') ?? catalog?.sources[0];
    const native = source?.providerId === 'grok-super-oauth' || source?.providerId.startsWith('grok-config:');
    setDraft({ name: '', providerId: source?.providerId ?? '',
      model: source?.providerId.startsWith('grok-config:') ? source.model : '',
      agents: native ? ['grok'] : ['claude-code', 'dsh', 'zcode'], reasoningLevel: '' });
    setNotice('');
  };
  const selectSource = (providerId: string) => {
    const source = catalog?.sources.find((item) => item.providerId === providerId);
    const native = providerId === 'grok-super-oauth' || providerId.startsWith('grok-config:');
    setDraft((old) => old ? { ...old, providerId,
      model: providerId.startsWith('grok-config:') ? source?.model ?? '' : '',
      agents: native ? ['grok'] : ['claude-code', 'dsh', 'zcode'] } : old);
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    const result = await api('models.save', draft);
    setBusy(false);
    if (!result.ok) { setNotice(result.error ?? '保存失败'); return; }
    setNotice(`已保存 ${result.data.model}；新任务可直接选择。`);
    setDraft(null);
    await refresh();
  };
  const remove = async (profile: ModelProfile) => {
    if (busy || !window.confirm(`删除模型配置「${profile.name} / ${profile.model}」？已有任务再次运行时将需要重新绑定。`)) return;
    setBusy(true);
    const result = await api('models.delete', { id: profile.id });
    setBusy(false);
    setNotice(result.ok ? `已删除 ${profile.model}` : result.error ?? '删除失败');
    if (result.ok) await refresh();
  };
  const importSources = async () => {
    if (busy) return;
    setBusy(true);
    const result = await api('models.import');
    setBusy(false);
    setNotice(result.ok ? `已导入 ${result.data.added} 个新模型配置。` : result.error ?? '导入失败');
    if (result.ok) await refresh();
  };
  const saveSource = async () => {
    if (!sourceDraft || busy) return;
    setBusy(true);
    const result = await api('credentials.save', sourceDraft);
    setBusy(false);
    setSourceDraft((old) => old ? { ...old, apiKey: '' } : null);
    if (!result.ok) { setNotice(result.error ?? '保存凭据失败'); return; }
    setSourceDraft(null);
    setNotice('本地凭据来源已保存，模型已加入目录。');
    await refresh();
  };
  const deleteSource = async (providerId: string) => {
    if (busy || !window.confirm('删除本地凭据来源？绑定此来源的任务将无法继续运行。')) return;
    setBusy(true);
    const result = await api('credentials.delete', { providerId });
    setBusy(false);
    setNotice(result.ok ? '本地凭据来源已删除。' : result.error ?? '删除失败');
    if (result.ok) await refresh();
  };
  const source = catalog?.sources.find((item) => item.providerId === draft?.providerId);
  const canUseGrok = draft?.providerId === 'grok-super-oauth' || draft?.providerId.startsWith('grok-config:')
    || source?.baseUrl.replace(/\/$/, '') === 'https://open.bigmodel.cn/api/anthropic';
  return <div className="modal-mask" onClick={onClose}>
    <div className="modal model-manager" onClick={(e) => e.stopPropagation()}>
      <h3>模型配置</h3>
      <div className="combo-note">可直接添加 API key，或复用 CC Switch、Grok 的现有登录。本地 key 经 macOS 系统安全存储加密；界面不回显。</div>
      <div className="model-manager-actions">
        <button className="btn" onClick={() => { setSourceDraft({ name:'', baseUrl:'', model:'', apiKey:'', authMode:'api_key' }); setNotice(''); }}>＋ 添加 API 凭据</button>
      </div>
      {(catalog?.sources ?? []).filter((item) => item.providerId.startsWith('workbench-local:')).map((item) =>
        <div className="model-manager-row" key={item.providerId}>
          <div><strong>{item.name}</strong><span className="model-manager-detail">{item.model} · {item.baseUrl}</span></div>
          <div><button className="btn small" onClick={() => setSourceDraft({ ...item, apiKey:'', authMode:item.authMode ?? 'api_key' })}>编辑</button>{' '}
            <button className="btn small danger" disabled={busy} onClick={() => void deleteSource(item.providerId)}>删除</button></div>
        </div>)}
      {sourceDraft && <div className="model-manager-form">
        <h3>{sourceDraft.providerId ? '编辑本地凭据来源' : '添加本地凭据来源'}</h3>
        <label>名称</label>
        <input type="text" value={sourceDraft.name} onChange={(e) => setSourceDraft({ ...sourceDraft, name:e.target.value })} placeholder="例如我的 Anthropic 兼容 API" />
        <label>API 地址（HTTPS，Anthropic Messages 兼容）</label>
        <input type="url" value={sourceDraft.baseUrl} disabled={!!sourceDraft.providerId} onChange={(e) => setSourceDraft({ ...sourceDraft, baseUrl:e.target.value })} placeholder="https://example.com/v1" />
        <label>默认模型 ID</label>
        <input type="text" value={sourceDraft.model} onChange={(e) => setSourceDraft({ ...sourceDraft, model:e.target.value })} placeholder="例如 my-model" />
        <label>凭据类型</label>
        <select value={sourceDraft.authMode} onChange={(e) => setSourceDraft({ ...sourceDraft, authMode:e.target.value as 'api_key' | 'auth_token' })}>
          <option value="api_key">API key（ANTHROPIC_API_KEY）</option>
          <option value="auth_token">代理令牌（ANTHROPIC_AUTH_TOKEN）</option>
        </select>
        <label>API key{sourceDraft.providerId ? '（留空则保留原 key）' : ''}</label>
        <input type="password" autoComplete="new-password" value={sourceDraft.apiKey} onChange={(e) => setSourceDraft({ ...sourceDraft, apiKey:e.target.value })} />
        <div className="foot"><button className="btn" onClick={() => setSourceDraft(null)}>取消</button>
          <button className="btn primary" disabled={busy} onClick={() => void saveSource()}>保存凭据</button></div>
      </div>}
      <div className="model-manager-actions">
        <button className="btn" onClick={newDraft}>＋ 添加模型</button>
        <button className="btn" disabled={busy} onClick={() => void importSources()}>导入当前来源</button>
      </div>
      <div className="model-manager-list">
        {(catalog?.profiles ?? []).map((profile) => {
          const available = (catalog?.providers ?? []).some((item) => item.profileId === profile.id);
          return <div className="model-manager-row" key={profile.id}>
            <div><strong>{profile.name}</strong><span className="model-manager-detail">{profile.model} · {profile.agents.join(' / ')} · {available ? '可选择' : '来源不可用'}</span></div>
            <div><button className="btn small" onClick={() => { setDraft({ ...profile }); setNotice(''); }}>编辑</button>{' '}
              <button className="btn small danger" disabled={busy} onClick={() => void remove(profile)}>删除</button></div>
          </div>;
        })}
      </div>
      {draft && <div className="model-manager-form">
        <h3>{draft.id ? '编辑模型' : '添加模型'}</h3>
        <label>名称</label>
        <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如 GLM 5.3 Flash" />
        <label>凭据来源</label>
        <select value={draft.providerId} onChange={(e) => selectSource(e.target.value)}>
          {(catalog?.sources ?? []).map((item) => <option key={item.providerId} value={item.providerId}>{item.name}（{item.providerId === 'grok-super-oauth' || item.providerId.startsWith('grok-config:') ? 'Grok' : item.providerId.startsWith('workbench-local:') ? 'Workbench' : 'CC Switch'}）</option>)}
        </select>
        <label>模型 ID</label>
        <input type="text" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="例如 glm-5.3-flash" />
        <label>可用 Agent</label>
        <div className="model-agent-choices">{MODEL_AGENT_IDS.map((id) => {
          const disabled = id === 'grok' ? !canUseGrok : draft.providerId === 'grok-super-oauth' || draft.providerId.startsWith('grok-config:');
          return <label key={id}><input type="checkbox" checked={draft.agents.includes(id)} disabled={disabled}
            onChange={(e) => setDraft({ ...draft, agents: e.target.checked ? [...draft.agents, id] : draft.agents.filter((agent) => agent !== id) })} />{id}</label>;
        })}</div>
        {draft.agents.includes('zcode') && <><label>ZCode 思考级别（选填）</label>
          <input type="text" value={draft.reasoningLevel ?? ''} onChange={(e) => setDraft({ ...draft, reasoningLevel: e.target.value })} placeholder="例如 max" /></>}
        <div className="foot"><button className="btn" onClick={() => setDraft(null)}>取消编辑</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>保存模型</button></div>
      </div>}
      {notice && <div className="combo-note" role="status">{notice}</div>}
      <div className="foot"><button className="btn" onClick={onClose}>完成</button></div>
    </div>
  </div>;
}

function NewTaskModal({ info, projectId, onClose, onCreated }: { info: AppInfo | null; projectId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [fileWrite, setFileWrite] = useState(false);
  const [optionsInfo, setOptionsInfo] = useState(info);
  const [providerId, setProviderId] = useState(info?.defaultTaskCombo?.providerId ?? info?.defaultProviderId ?? '');
  const [agentId, setAgentId] = useState(info?.defaultTaskCombo?.agentId ?? 'claude-code');
  const [model, setModel] = useState(info?.defaultTaskCombo?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [defaultNotice, setDefaultNotice] = useState('');
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const refreshModels = useCallback(async (adoptDefault = false) => {
    setRefreshing(true);
    try {
      const result = await api('app.info', { refreshModels: true });
      if (result.ok) {
        setOptionsInfo(result.data);
        if (adoptDefault && result.data.defaultTaskCombo) {
          setAgentId(result.data.defaultTaskCombo.agentId);
          setProviderId(result.data.defaultTaskCombo.providerId);
          setModel(result.data.defaultTaskCombo.model);
        }
        setRefreshError('');
      }
      else setRefreshError(result.error ?? '模型列表刷新失败');
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '模型列表刷新失败');
    } finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void refreshModels(true); }, [refreshModels]);
  const choices = (optionsInfo?.combinations ?? []).flatMap((combo) => {
    const adapter = optionsInfo?.adapters.find((item) => item.id === combo.agentId);
    const provider = optionsInfo?.providers.find((item) => item.profileId === combo.profileId);
    return adapter && provider ? [{ adapter, provider }] : [];
  });
  const selected = choices.find(({ adapter, provider }) => adapter.id === agentId
    && provider.providerId === providerId && provider.model === model) ?? choices[0];
  const saveDefault = async () => {
    if (!selected) return;
    const result = await api('agents.setDefault', {
      agentId: selected.adapter.id, providerId: selected.provider.providerId, model: selected.provider.model,
    });
    setDefaultNotice(result.ok ? `已保存：以后指定 ${selected.adapter.displayName} 时默认使用 ${selected.provider.model}。`
      : result.error ?? '保存默认模型失败');
  };
  const submit = async () => {
    if (!title.trim() || !prompt.trim() || !selected || busy) return;
    setBusy(true);
    const r = await api('sessions.create', {
      projectId, title: title.trim(), prompt: prompt.trim(), fileWrite,
      agentId: selected.adapter.id, model: selected.provider.model, providerId: selected.provider.providerId,
    });
    setBusy(false);
    if (r.ok) onCreated(r.data.id);
    else alert(`创建失败: ${r.error}`);
  };
  return (<>
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建任务</h3>
        <label>标题</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：制作一个计数页面" />
        <label>需求描述（首条消息）</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述目标、要求与验收标准…" />
        <div className="checkline">
          <input type="checkbox" checked={fileWrite} onChange={(e) => setFileWrite(e.target.checked)} id="fw" />
          <label htmlFor="fw" style={{ margin: 0 }}>允许在项目目录内写文件（其他操作按具体请求授权）</label>
        </div>
        <label>Agent / 模型组合</label>
        <select value={selected ? `${selected.adapter.id}|${selected.provider.profileId}` : ''} onChange={(e) => {
          const choice = choices.find(({ adapter, provider }) => `${adapter.id}|${provider.profileId}` === e.target.value);
          if (choice) { setAgentId(choice.adapter.id); setProviderId(choice.provider.providerId); setModel(choice.provider.model); }
          setDefaultNotice('');
        }}>
          {choices.map(({ adapter, provider }) => (
            <option key={`${adapter.id}|${provider.profileId}`} value={`${adapter.id}|${provider.profileId}`}>{adapter.displayName} + {provider.model}（{provider.name}）</option>
          ))}
        </select>
        <button className="btn" type="button" disabled={refreshing} onClick={() => void refreshModels(false)}>{refreshing ? '读取模型中…' : '刷新模型列表'}</button>
        <button className="btn" type="button" onClick={() => setModelManagerOpen(true)}>管理模型配置</button>
        <button className="btn" type="button" disabled={!selected} onClick={() => void saveDefault()}>保存为该 Agent 默认模型</button>
        {refreshError && <div className="combo-note">{refreshError}</div>}
        {defaultNotice && <div className="combo-note">{defaultNotice}</div>}
        {!selected && <div className="combo-note">暂无可用 Agent 与模型组合。</div>}
        {selected?.provider.providerId === 'grok-super-oauth' && <div className="combo-note">Grok Build 使用本机 Grok Super 登录；当前任务固定使用 Grok 模型。</div>}
        {selected?.provider.providerId.startsWith('grok-config:') && <div className="combo-note">此模型已保存在 Workbench 模型目录中，并引用 Grok Build 当前配置。</div>}
        {selected && ['grok', 'dsh', 'zcode'].includes(selected.adapter.id) && selected.provider.providerId !== 'grok-super-oauth' && !selected.provider.providerId.startsWith('grok-config:') && <div className="combo-note">此组合使用所选 CC Switch 凭据；需要授权时在任务详情中逐项处理。</div>}
        <div className="combo-note">凭据留在本机 Grok 或 CC Switch 配置中，不写入 Workbench 任务记录。</div>
        <div className="foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!title.trim() || !prompt.trim() || !selected || busy} onClick={submit}>{busy ? '创建中…' : '创建并开始'}</button>
        </div>
      </div>
    </div>
    {modelManagerOpen && <ModelManagerModal info={optionsInfo} onClose={() => { setModelManagerOpen(false); void refreshModels(false); }} />}
  </>);
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [rootPath, setRootPath] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!rootPath.trim() || busy) return;
    setBusy(true);
    const r = await api('projects.create', { rootPath: rootPath.trim(), name: projectName({rootPath: rootPath.trim()}) });
    setBusy(false);
    if (r.ok) onCreated(r.data.id);
    else alert(`创建失败: ${r.error}`);
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建项目</h3>
        <label>项目根目录（绝对路径；建议空目录或新目录）</label>
        <input type="text" value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder="/Users/you/path/to/project" />
        <p>项目名称：{rootPath.trim() ? projectName({rootPath: rootPath.trim()}) : "按工作文件夹名称显示"}</p>
        <div className="foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!rootPath.trim() || busy} onClick={submit}>创建</button>
        </div>
      </div>
    </div>
  );
}

function TaskMemoryUsed({ taskId, refreshKey }: { taskId: string; refreshKey: number }) {
  const [snapshot,setSnapshot] = useState<MemoryInjectionSnapshot|null>(null);
  useEffect(() => {
    let active = true;
    void api('task.memory.used',{taskId}).then((r:any)=>{ if (active) setSnapshot(r.ok ? r.data : null); });
    return () => { active=false; };
  },[taskId,refreshKey]);
  if (!snapshot) return null;
  return <details className="memory-used" style={{ padding:'7px 16px',borderBottom:'1px solid var(--border)',fontSize:11,color:'var(--text-dim)' }}>
    <summary style={{ cursor:'pointer' }}>首次输入使用的项目经验：{snapshot.entries.length ? `${snapshot.entries.length} 条（快照 ${snapshot.createdAt}）` : '无匹配的已采用经验'}</summary>
    {snapshot.entries.map((entry)=><div key={`${entry.id}:${entry.version}`} style={{ margin:'7px 0',whiteSpace:'pre-wrap' }}>
      <div>{entry.injectedText}</div>
      <details style={{marginTop:4}}><summary style={{cursor:'pointer'}}>完整记忆原文（未必全部注入）</summary><div>{entry.body}</div></details>
    </div>)}
  </details>;
}

function FactsModal({ projectId, taskId, onClose }: { projectId: string; taskId: string; onClose: () => void }) {
  const [facts,setFacts] = useState('');
  const [nightly,setNightly] = useState<{lastCompletedAt:string|null;processedTurns:number;newDrafts:number;error:string|null}|null>(null);
  const [version,setVersion] = useState<number|null>(null);
  const [entries,setEntries] = useState<MemoryEntry[]>([]);
  const [matches,setMatches] = useState<MemoryEntry[]>([]);
  const [matchedBy,setMatchedBy] = useState<Record<string,string[]>>({});
  const [selected,setSelected] = useState<MemoryEntry|null>(null);
  const [query,setQuery] = useState('');
  const [kind,setKind] = useState<MemoryKind>('lesson');
  const [title,setTitle] = useState('');
  const [body,setBody] = useState('');
  const [source,setSource] = useState('');
  const [taskLink,setTaskLink] = useState(taskId ?? '');
  const [expiresAt,setExpiresAt] = useState('');
  const [evidence,setEvidence] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const reload = useCallback(async () => {
    const [memory,items,night] = await Promise.all([api('project.memory.get',{projectId}),api('project.memory.entries.list',{projectId}),api('memory.nightly.status')]);
    if (memory.ok) { setFacts(memory.data.facts);setVersion(memory.data.version); }
    else setError(memory.error);
    if (items.ok) { setEntries(items.data);setMatches(items.data);setMatchedBy({}); }
    else setError(items.error);
    if (night.ok) setNightly(night.data);
  },[projectId]);
  useEffect(()=>{ void reload(); },[reload]);
  const clearEditor = () => { setSelected(null);setKind('lesson');setTitle('');setBody('');setSource('');setTaskLink(taskId ?? '');setExpiresAt('');setEvidence('');setError('');setNotice(''); };
  const selectEntry = (entry:MemoryEntry, preserveNotice = false) => {
    setSelected(entry);setKind(entry.kind);setTitle(entry.title);setBody(entry.body);setSource(entry.source);setTaskLink(entry.taskId ?? '');
    setExpiresAt(entry.expiresAt?.slice(0,10) ?? '');setEvidence(entry.evidenceRefs.join('\n'));setError('');
    if (!preserveNotice) setNotice('');
  };
  const runSearch = async () => {
    if (!query.trim()) { setMatches(entries);setMatchedBy({});return; }
    const r = await api('project.memory.entries.search',{projectId,query});
    if (r.ok) {
      setMatches(r.data.map((item:any)=>item.entry));
      setMatchedBy(Object.fromEntries(r.data.map((item:any)=>[item.entry.id,item.matchedTerms])));
    } else setError(r.error);
  };
  const payload = () => ({ projectId,kind,title,body,source,expiresAt:expiresAt ? new Date(`${expiresAt}T23:59:59.000Z`).toISOString() : null,
    evidenceRefs:evidence.split('\n').map((v)=>v.trim()).filter(Boolean),taskId:taskLink.trim() || (selected ? null : undefined) });
  const saveDraft = async () => {
    if (busy) return;
    const existing = selected;
    setBusy(true);setError('');setNotice('');
    const r = existing
      ? await api('project.memory.entries.update',{projectId,id:existing.id,expectedVersion:existing.version,patch:payload()})
      : await api('project.memory.entries.create',{...payload(),requestId:`ui-memory-${Date.now()}-${Math.random().toString(36).slice(2,8)}`});
    setBusy(false);
    if (!r.ok) { setError(r.error);return; }
    const entry = existing ? r.data : r.data.entry;
    setNotice(r.data.duplicateContent ? '项目已有相同内容，已定位到原条目。' : existing ? '修改已保存。' : '草稿已保存。');
    await reload();selectEntry(entry,true);
  };
  const setStatus = async (status:'adopted'|'inactive') => {
    if (!selected || busy) return;
    setBusy(true);setError('');
    const r=await api('project.memory.entries.status',{projectId,id:selected.id,status,expectedVersion:selected.version});
    setBusy(false);
    if (!r.ok) {setError(r.error);return;}
    setNotice(status==='adopted'?'已采用；后续首次输入可检索。':'已停用；不会自动召回。');
    await reload();selectEntry(r.data,true);
  };
  const replaceEntry = async () => {
    if (!selected || busy) return;
    setBusy(true);setError('');
    const { projectId:_pid, ...entry } = payload();
    const r=await api('project.memory.entries.replace',{projectId,id:selected.id,expectedVersion:selected.version,entry:{...entry,requestId:`ui-replace-${Date.now()}-${Math.random().toString(36).slice(2,8)}`}});
    setBusy(false);
    if (!r.ok) {setError(r.error);return;}
    setNotice('新条目已采用，旧条目已标记为被替代。');
    await reload();selectEntry(r.data.entry,true);
  };
  const createHandoff = async () => {
    if (!taskId || busy) {setError('请先选择任务。');return;}
    setBusy(true);setError('');
    const r=await api('project.memory.handoff.create',{taskId});
    setBusy(false);
    if (!r.ok) {setError(r.error);return;}
    setNotice('已生成交接草稿，标记为“Agent 报告，待核对”。');
    await reload();selectEntry(r.data.entry,true);
  };
  const saveFacts = async () => {
    if (version===null || busy) return;
    setBusy(true);setError('');
    const r=await api('project.memory.set',{projectId,facts,expectedVersion:version,source:'用户在项目背景页面确认'});
    setBusy(false);
    if (!r.ok) setError(r.error); else {setVersion(r.data.version);setNotice('已确认背景已保存；既有任务快照不变。');}
  };
  return <div className="modal-mask" onClick={onClose}>
    <div className="modal model-manager" style={{ width:760,maxWidth:'94vw' }} onClick={(e)=>e.stopPropagation()}>
      <h3>项目背景与经验</h3>
      <div className="hint">夜间整理（全部项目）：{nightly?.lastCompletedAt
        ? `${new Date(nightly.lastCompletedAt).toLocaleString()} 完成，处理 ${nightly.processedTurns} 个任务结果，新增 ${nightly.newDrafts} 条待核对草稿`
        : '尚未完成首次整理'}{nightly?.error ? `；上次失败：${nightly.error}` : ''}</div>
      {error&&<p role="alert" style={{color:'var(--danger)'}}>{error}</p>}{notice&&<p role="status" style={{color:'var(--accent)'}}>{notice}</p>}
      <section style={{ borderBottom:'1px solid var(--border)',paddingBottom:12,marginBottom:12 }}>
        <h4>已确认背景 · 版本 {version ?? '加载中'}</h4>
        <div style={{fontSize:11,color:'var(--text-dim)',marginBottom:6}}>新任务创建时保存这一背景快照；它优先于下面的经验参考。</div>
        <textarea style={{minHeight:72}} value={facts} onChange={(e)=>setFacts(e.target.value)} placeholder="项目已确认事实与决定" />
        <button className="btn small" disabled={version===null||busy} onClick={()=>void saveFacts()}>保存已确认背景</button>
      </section>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <input style={{minWidth:0,flex:1}} type="text" aria-label="搜索项目经验" maxLength={1000} value={query} onChange={(e)=>setQuery(e.target.value)} onKeyDown={(e)=>{if(e.key==='Enter')void runSearch();}} placeholder="中文或英文关键词" />
        <button className="btn small" style={{flexShrink:0,whiteSpace:'nowrap'}} onClick={()=>void runSearch()}>搜索</button>
        <button className="btn small" style={{flexShrink:0,whiteSpace:'nowrap'}} onClick={()=>{setQuery('');setMatches(entries);setMatchedBy({});}}>全部</button>
      </div>
      <div role="list" aria-label="项目经验条目" style={{maxHeight:125,overflowY:'auto',border:'1px solid var(--border)',borderRadius:8,margin:'8px 0',padding:'4px 8px'}}>
        {matches.length===0&&<div className="hint" style={{padding:8}}>没有匹配的条目。</div>}
        {matches.map((entry)=><button key={entry.id} type="button" role="listitem" className="ghost-btn" style={{display:'block',textAlign:'left',width:'100%',padding:7,borderBottom:'1px solid var(--border)'}} onClick={()=>selectEntry(entry)}>
          <b>{entry.title}</b> · {entry.kind} · {entry.status} · v{entry.version} · {entry.source}{entry.expiresAt?` · 至 ${entry.expiresAt.slice(0,10)}`:''}{matchedBy[entry.id]?.length?` · 命中：${matchedBy[entry.id].join('、')}`:''}
        </button>)}
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <h4 style={{margin:0,flex:1}}>{selected ? `编辑条目 · v${selected.version}` : '新建草稿'}</h4>
        <button className="btn small" type="button" onClick={clearEditor}>新建</button>
        <button className="btn small" type="button" disabled={busy||!taskId} onClick={()=>void createHandoff()}>从当前任务生成交接草稿</button>
      </div>
      <label>类型</label>
      <select disabled={!!selected} value={kind} onChange={(e)=>setKind(e.target.value as MemoryKind)}>
        <option value="fact">事实</option><option value="decision">决定</option><option value="lesson">经验</option><option value="handoff">交接</option>
      </select>
      {selected&&<div className="hint">已有条目的类型固定；如需其他类型，请新建条目。</div>}
      <label>标题</label><input type="text" readOnly={selected?.status==='superseded'} value={title} onChange={(e)=>setTitle(e.target.value)} maxLength={200} />
      <label>正文</label><textarea readOnly={selected?.status==='superseded'} style={{minHeight:75}} value={body} onChange={(e)=>setBody(e.target.value)} maxLength={20000} />
      <div style={{display:'grid',gridTemplateColumns:'1fr 180px',gap:10}}>
        <div><label>来源</label><input type="text" readOnly={selected?.status==='superseded'} value={source} onChange={(e)=>setSource(e.target.value)} maxLength={300} placeholder="例如：用户确认、文档路径、任务结果" /></div>
        <div><label>有效期至（可选）</label><input type="date" disabled={selected?.status==='superseded'} value={expiresAt} onChange={(e)=>setExpiresAt(e.target.value)} /></div>
      </div>
      <label>关联任务 ID（可选）</label><input type="text" readOnly={selected?.status==='superseded'} value={taskLink} onChange={(e)=>setTaskLink(e.target.value)} />
      <label>证据引用（每行一项，可选）</label><textarea readOnly={selected?.status==='superseded'} style={{minHeight:44}} value={evidence} onChange={(e)=>setEvidence(e.target.value)} />
      {selected?.replacedById&&<div className="hint">已被替代，替代条目 ID：{selected.replacedById}</div>}
      <div className="foot" style={{justifyContent:'space-between',flexWrap:'wrap'}}>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {selected&&selected.status!=='superseded'&&<><button className="btn small" disabled={busy} onClick={()=>void setStatus('adopted')}>采用</button><button className="btn small" disabled={busy} onClick={()=>void setStatus('inactive')}>停用</button><button className="btn small" disabled={busy} onClick={()=>void replaceEntry()}>保存为替代版本</button></>}
        </div>
        <div style={{display:'flex',gap:8}}><button className="btn" onClick={onClose}>关闭</button><button className="btn primary" disabled={busy||selected?.status==='superseded'||!title.trim()||!body.trim()||!source.trim()} onClick={()=>void saveDraft()}>{busy?'保存中…':selected?.status==='superseded'?'已被替代':selected?'保存修改':'保存草稿'}</button></div>
      </div>
    </div>
  </div>;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}

// 旧任务供应商绑定确认框：用户显式选择后才能继续真实调用（系统不擅自绑定/切换）
function BindProviderModal({ info, sessionId, onClose, onBound }: { info: AppInfo | null; sessionId: string; onClose: () => void; onBound: () => void }) {
  const [agentId, setAgentId] = useState('');
  const [selection, setSelection] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api('session.get', { sessionId }).then((r: any) => { if (r.ok) setAgentId(r.data.agentId); }); }, [sessionId]);
  const choices = (info?.combinations ?? []).filter((combo) => combo.agentId === agentId);
  const chosen = choices.find((item) => item.profileId === selection) ?? choices[0];
  const submit = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    const r = await api('sessions.bindProvider', { sessionId, providerId: chosen.providerId, model: chosen.model });
    setBusy(false);
    if (r.ok) onBound();
    else alert(`绑定失败: ${r.error}`);
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>为此任务选择供应商</h3>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
          该任务未记录供应商（或原绑定已失效）。请选择一个组合并确认；绑定仅作用于本任务，不会影响其他任务，系统也不会自动切换。
        </div>
        <select value={chosen?.profileId ?? ''} onChange={(e) => setSelection(e.target.value)}>
          {choices.map((combo) => (
            <option key={combo.profileId} value={combo.profileId}>{combo.model}（{info?.providers.find((p) => p.profileId === combo.profileId)?.name ?? combo.providerId}）</option>
          ))}
        </select>
        <div className="foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!chosen || busy} onClick={submit}>确认绑定并继续</button>
        </div>
      </div>
    </div>
  );
}
