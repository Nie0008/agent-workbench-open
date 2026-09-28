// 渲染辅助组件：结构化消息卡片、差异视图、轻量 Markdown（纯 React 元素，不注入 HTML）
import React, { useMemo, useState } from 'react';
import type { WorkbenchEvent, DiffLine } from '../shared/types';

export const STATUS_LABEL: Record<string, string> = {
  idle: '空闲', running: '运行中', waiting_permission: '待授权', stopped: '已停止',
  completed: '已完成', failed: '失败', canceled: '已取消', resuming: '恢复中',
  interrupted: '已中断', timeout: '超时',
};

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot ${status}`} />;
}

// 轻量 Markdown：段落 / 代码块 / 行内代码 / 列表，全部映射为 React 元素
export function Markdownish({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: React.ReactNode[] = [];
    const lines = text.split('\n');
    let i = 0, key = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        const lang = line.trim().slice(3);
        const buf: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
        i++;
        out.push(<div className="codeblock" key={key++}>{buf.join('\n')}</div>);
        continue;
      }
      if (/^#{1,4}\s/.test(line)) {
        out.push(<div key={key++} style={{ fontWeight: 700, marginTop: 6 }}>{inline(line.replace(/^#{1,4}\s/, ''))}</div>);
        i++; continue;
      }
      if (/^\s*[-*]\s/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s/, '')); i++; }
        out.push(<ul key={key++} style={{ paddingLeft: 20 }}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>);
        continue;
      }
      if (line.trim() === '') { i++; continue; }
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('```') && !/^#{1,4}\s/.test(lines[i]) && !/^\s*[-*]\s/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push(<div key={key++}>{inline(para.join('\n'))}</div>);
    }
    return out;
  }, [text]);
  return <>{nodes}</>;
}

function inline(s: string): React.ReactNode[] {
  const parts = s.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return <code key={i}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

export function ToolCard({ ev, result, onOpenFile }: {
  ev: WorkbenchEvent;
  result?: WorkbenchEvent;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = ev.payload.name as string;
  const input = ev.payload.input ?? {};
  const ok = result ? result.payload.ok !== false : undefined;
  const isError = result ? result.payload.ok === false : undefined;
  const targetPath: string | undefined = input.file_path ?? input.notebook_path
    ?? (typeof input.path === 'string' ? input.path : undefined)
    ?? (typeof input.command === 'string' ? undefined : undefined);
  const summary = (() => {
    if (name === 'Bash' && typeof input.command === 'string') return input.command.slice(0, 160);
    if (typeof input.pattern === 'string') return `${input.pattern}`;
    return '';
  })();
  return (
    <div className="card">
      <div className="card-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▼' : '▶'}</span>
        <span className="tool-name">{name}</span>
        {targetPath && onOpenFile && (
          <span className="file-chip" style={{ marginLeft: 6 }} onClick={(e) => { e.stopPropagation(); onOpenFile(relOf(targetPath)); }}>
            {relOf(targetPath)}
          </span>
        )}
        {summary && <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{summary}</span>}
        <span className={`tool-state ${ok === undefined ? '' : ok ? 'ok' : 'err'}`}>
          {ok === undefined ? '执行中…' : isError ? '失败' : '完成'}
        </span>
      </div>
      {open && (
        <div className="card-body">
          <div className="tool-input">{JSON.stringify(input, null, 2)}</div>
          {result && <div className="tool-brief">{String(result.payload.brief ?? '')}</div>}
        </div>
      )}
    </div>
  );
}

function relOf(p: string): string {
  const m = p.match(/(?:.*\/)?([^/]+)$/);
  return p;
}

export function DiffLines({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="diff-lines">
      {diff.slice(0, 1500).map((l, i) => (
        <div key={i} className={`dline ${l.type}`}>
          <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
          <span>{l.text || ' '}</span>
        </div>
      ))}
      {diff.length > 1500 && <div className="dline ctx">…（差异过长截断）</div>}
    </div>
  );
}

// 解析 git unified patch 为行数组
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file') || /^@@/.test(line)) {
      if (/^@@/.test(line)) out.push({ type: 'ctx', text: line });
      continue;
    }
    if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) out.push({ type: 'del', text: line.slice(1) });
    else out.push({ type: 'ctx', text: line.replace(/^ /, '') });
  }
  return out;
}
