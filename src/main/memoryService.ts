import * as crypto from 'node:crypto';
import type { MemoryEntry, MemoryInjectionSnapshot, MemoryKind, MemoryStatus } from '../shared/types';
import { Store } from './store';

export interface MemoryEntryInput {
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  source: string;
  taskId?: string | null;
  evidenceRefs?: string[];
  expiresAt?: string | null;
  requestId?: string;
}
export interface MemoryEntryPatch {
  title?: string;
  body?: string;
  source?: string;
  taskId?: string | null;
  evidenceRefs?: string[];
  expiresAt?: string | null;
}
export interface MemoryMatch { entry: MemoryEntry; score: number; matchedTerms: string[] }

const KINDS = new Set<MemoryKind>(['fact','decision','lesson','handoff']);
const STATUSES = new Set<MemoryStatus>(['draft','adopted','inactive','superseded']);
const STOP_WORDS = new Set([
  '项目','使用','什么','怎么','如何','是否','哪些','哪个','现在','当前','已经','需要','相关','我们','这里','请问','这个','一下','经验','记忆',
  'the','and','for','with','from','what','which','how','does','this','that','project','about','used','using',
]);
const DEFAULT_CHAR_BUDGET = 4200;
const MAX_MATCH_EXCERPT_CHARS = 1200;
export const MEMORY_CONTEXT_HEADER = '以下是同项目已采用经验，仅供参考；项目已确认背景、本次明确要求和权限优先：\n';

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}
function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizedTextWithOffsets(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const source = String.fromCodePoint(value.codePointAt(offset)!);
    const end = offset + source.length;
    const normalized = source.normalize('NFKC').toLocaleLowerCase();
    text += normalized;
    for (let i = 0; i < normalized.length; i++) {
      starts.push(offset);
      ends.push(end);
    }
    offset = end;
  }
  return { text, starts, ends };
}
function excerptAroundMatch(body: string, matchedTerms: string[], maxLength: number): string | null {
  if (maxLength <= 0) return null;
  const folded = normalizedTextWithOffsets(body);
  const candidates: Array<{ start: number; end: number; termLength: number }> = [];
  for (const rawTerm of matchedTerms) {
    const term = rawTerm.normalize('NFKC').toLocaleLowerCase();
    if (!term) continue;
    const index = folded.text.indexOf(term);
    if (index < 0) continue;
    const start = folded.starts[index];
    const end = folded.ends[index + term.length - 1];
    if (start !== undefined && end !== undefined) candidates.push({ start, end, termLength: end - start });
  }
  candidates.sort((a, b) => b.termLength - a.termLength || a.start - b.start);
  const hit = candidates[0];
  if (!hit) return null;

  const clippedBefore = hit.start > 0;
  const clippedAfter = hit.end < body.length;
  const markerBudget = Number(clippedBefore) + Number(clippedAfter);
  const contentBudget = maxLength - markerBudget;
  const hitLength = hit.end - hit.start;
  const contextBudget = contentBudget - hitLength;
  if (contextBudget < (clippedBefore && clippedAfter ? 2 : 0)) return null;

  let before = Math.min(hit.start, Math.floor(contextBudget / 2));
  let after = Math.min(body.length - hit.end, contextBudget - before);
  let unused = contextBudget - before - after;
  if (unused > 0) {
    const extraBefore = Math.min(hit.start - before, unused);
    before += extraBefore;
    unused -= extraBefore;
    after += Math.min(body.length - hit.end - after, unused);
  }
  const sliceStart = hit.start - before;
  const sliceEnd = hit.end + after;
  const excerpt = `${sliceStart > 0 ? '…' : ''}${body.slice(sliceStart, sliceEnd)}${sliceEnd < body.length ? '…' : ''}`;
  return excerpt.length <= maxLength ? excerpt : null;
}
function tokens(value: string): string[] {
  const out = new Set<string>();
  for (const match of normalizeText(value).matchAll(/[\p{Script=Han}]+|[a-z0-9][a-z0-9._+-]*/gu)) {
    const part = match[0];
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      if (part.length === 1) out.add(part);
      else {
        // Overlapping bigrams keep common Chinese compound terms searchable without an NLP dependency.
        for (let i=0;i<part.length-1;i++) out.add(part.slice(i,i+2));
        if (part.length <= 4) out.add(part);
      }
    } else if (part.length > 1 || /\d/.test(part)) out.add(part);
  }
  return [...out].filter((item) => !STOP_WORDS.has(item));
}
function isExpired(entry: MemoryEntry, now = Date.now()): boolean {
  return !!entry.expiresAt && Date.parse(entry.expiresAt) <= now;
}
function normalizedContent(kind: MemoryKind, title: string, body: string): string {
  // Search token normalization may discard punctuation; duplicate identity must not erase operators
  // or command syntax such as >=, <=, --flag, or case-sensitive identifiers.
  const preserveMeaning = (text: string) => text.normalize('NFKC').replace(/\s+/gu,' ').trim();
  return `${kind}\n${preserveMeaning(title)}\n${preserveMeaning(body)}`;
}

export class MemoryService {
  constructor(private readonly store: Store) {}

  private project(projectId: string) {
    if (typeof projectId !== 'string' || !projectId || !this.store.getProject(projectId)) throw new Error('项目不存在');
  }
  private validateInput(input: MemoryEntryInput) {
    this.project(input.projectId);
    if (!KINDS.has(input.kind)) throw new Error('无效的经验类型');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('标题不能为空且不超过200字符');
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 20000) throw new Error('正文不能为空且不超过20000字符');
    if (typeof input.source !== 'string' || !input.source.trim() || input.source.length > 300) throw new Error('来源不能为空且不超过300字符');
    if (input.taskId != null) {
      const task = this.store.getSession(input.taskId);
      if (!task || task.projectId !== input.projectId) throw new Error('关联任务不存在或不属于此项目');
    }
    if (input.requestId != null && (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 200)) throw new Error('请求 ID 必须为1到200字符');
    if (input.expiresAt != null && (Number.isNaN(Date.parse(input.expiresAt)) || !input.expiresAt.trim())) throw new Error('有效期必须是有效日期');
    if (input.evidenceRefs != null && (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 30
      || input.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim() || ref.length > 300))) throw new Error('证据引用最多30项，每项不超过300字符');
  }

  list(projectId: string, filters: { status?: MemoryStatus; kind?: MemoryKind } = {}): MemoryEntry[] {
    this.project(projectId);
    if (filters.status && !STATUSES.has(filters.status)) throw new Error('无效的经验状态');
    if (filters.kind && !KINDS.has(filters.kind)) throw new Error('无效的经验类型');
    return this.store.listMemoryEntries(projectId).filter((entry) => (!filters.status || entry.status === filters.status)
      && (!filters.kind || entry.kind === filters.kind));
  }

  get(projectId: string, id: string): MemoryEntry {
    this.project(projectId);
    const entry = this.store.getMemoryEntry(id);
    if (!entry || entry.projectId !== projectId) throw new Error('经验条目不存在');
    return entry;
  }
  history(projectId: string, id: string): MemoryEntry[] {
    this.get(projectId,id);
    return this.store.listMemoryHistory(id);
  }

  create(input: MemoryEntryInput): { entry: MemoryEntry; duplicate?: boolean; duplicateContent?: boolean } {
    this.validateInput(input);
    const normalized = { ...input, title: input.title.trim(), body: input.body.trim(), source: input.source.trim(),
      evidenceRefs: input.evidenceRefs ?? [], taskId: input.taskId ?? null, expiresAt: input.expiresAt ?? null };
    // Keep the serialized field order independent of how IPC/MCP callers ordered JSON keys.
    const fp = fingerprint({ projectId:input.projectId,kind:input.kind,title:normalized.title,body:normalized.body,
      source:normalized.source,taskId:normalized.taskId,evidenceRefs:normalized.evidenceRefs,expiresAt:normalized.expiresAt });
    return this.store.transaction(() => {
      if (input.requestId) {
        const prior = this.store.getMemoryRequest(input.projectId,input.requestId);
        if (prior) {
          if (prior.fingerprint !== fp) throw new Error('相同请求 ID 的参数不一致');
          const entry = this.get(input.projectId,prior.entryId);
          return { entry, duplicate: true };
        }
      }
      const content = normalizedContent(input.kind,normalized.title,normalized.body);
      // Handoff entries carry task/result provenance. Identical reported text from another task is
      // still a distinct record; the stable requestId above handles retries for one result event.
      const existing = input.kind === 'handoff' ? undefined : this.store.listMemoryEntries(input.projectId).find((entry) => entry.status !== 'inactive'
        && entry.status !== 'superseded' && normalizedContent(entry.kind,entry.title,entry.body) === content);
      if (existing) {
        if (input.requestId) this.store.createMemoryRequest(input.projectId,input.requestId,fp,existing.id);
        return { entry:existing, duplicateContent:true };
      }
      const now = new Date().toISOString();
      const entry: MemoryEntry = { id:crypto.randomUUID(), projectId:input.projectId, kind:input.kind,
        title:normalized.title, body:normalized.body, source:normalized.source, taskId:normalized.taskId,
        evidenceRefs:normalized.evidenceRefs, status:'draft', version:1, createdAt:now, updatedAt:now,
        expiresAt:normalized.expiresAt, replacedById:null };
      this.store.createMemoryEntry(entry,input.requestId);
      if (input.requestId) this.store.createMemoryRequest(input.projectId,input.requestId,fp,entry.id);
      return { entry };
    });
  }

  update(projectId: string, id: string, patch: MemoryEntryPatch, expectedVersion: number): MemoryEntry {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('必须提供有效的 expectedVersion');
    return this.store.transaction(() => {
      const current = this.get(projectId,id);
      if (current.version !== expectedVersion) throw new Error('经验版本冲突，请重新读取后合并');
      if (current.status === 'superseded') throw new Error('已被替代的经验不可编辑');
      const next: MemoryEntry = { ...current,
        title: patch.title === undefined ? current.title : patch.title.trim(),
        body: patch.body === undefined ? current.body : patch.body.trim(),
        source: patch.source === undefined ? current.source : patch.source.trim(),
        taskId: patch.taskId === undefined ? current.taskId : patch.taskId,
        evidenceRefs: patch.evidenceRefs === undefined ? current.evidenceRefs : patch.evidenceRefs,
        expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
        version:current.version+1, updatedAt:new Date().toISOString() };
      this.validateInput({ projectId,kind:next.kind,title:next.title,body:next.body,source:next.source,taskId:next.taskId,
        evidenceRefs:next.evidenceRefs,expiresAt:next.expiresAt });
      if (next.kind !== 'handoff' && this.store.listMemoryEntries(projectId).some((entry) => entry.id !== id && entry.status !== 'inactive'
        && entry.status !== 'superseded' && normalizedContent(entry.kind,entry.title,entry.body) === normalizedContent(next.kind,next.title,next.body)))
        throw new Error('项目中已有相同内容的有效条目');
      this.store.saveMemoryHistory(current);
      this.store.updateMemoryEntry(next);
      return next;
    });
  }

  setStatus(projectId: string, id: string, status: 'adopted'|'inactive', expectedVersion: number): MemoryEntry {
    if (status !== 'adopted' && status !== 'inactive') throw new Error('该状态不能通过此操作设置');
    return this.store.transaction(() => {
      const current = this.get(projectId,id);
      if (current.version !== expectedVersion) throw new Error('经验版本冲突，请重新读取后操作');
      if (current.status === 'superseded') throw new Error('已被替代的经验不可更改状态');
      if (status === 'adopted' && isExpired(current)) throw new Error('已过期的经验不能采用，请先更新有效期');
      if (current.status === status) return current;
      const next = { ...current,status,version:current.version+1,updatedAt:new Date().toISOString() };
      this.store.saveMemoryHistory(current);
      this.store.updateMemoryEntry(next);
      return next;
    });
  }

  replace(projectId: string, id: string, expectedVersion: number, input: Omit<MemoryEntryInput,'projectId'>): { previous:MemoryEntry; entry:MemoryEntry; duplicate?:boolean } {
    const fullInput = { ...input, projectId };
    this.validateInput(fullInput);
    const normalized = { ...fullInput,title:fullInput.title.trim(),body:fullInput.body.trim(),source:fullInput.source.trim(),
      evidenceRefs:fullInput.evidenceRefs ?? [],taskId:fullInput.taskId ?? null,expiresAt:fullInput.expiresAt ?? null };
    const fp = fingerprint({ replaces:id,expectedVersion,projectId,kind:normalized.kind,title:normalized.title,body:normalized.body,
      source:normalized.source,taskId:normalized.taskId,evidenceRefs:normalized.evidenceRefs,expiresAt:normalized.expiresAt });
    return this.store.transaction(() => {
      if (input.requestId) {
        const prior = this.store.getMemoryRequest(projectId,input.requestId);
        if (prior) {
          if (prior.fingerprint !== fp) throw new Error('相同请求 ID 的参数不一致');
          const entry = this.get(projectId,prior.entryId);
          const previous = entry.replacedById ? this.get(projectId,id) : this.get(projectId,id);
          return { previous,entry,duplicate:true };
        }
      }
      const previous = this.get(projectId,id);
      if (previous.version !== expectedVersion) throw new Error('经验版本冲突，请重新读取后操作');
      if (previous.status === 'superseded') throw new Error('该经验已被其他条目替代');
      if (normalizedContent(previous.kind,previous.title,previous.body) === normalizedContent(normalized.kind,normalized.title,normalized.body))
        throw new Error('替代内容与原条目相同');
      const duplicate = normalized.kind === 'handoff' ? undefined : this.store.listMemoryEntries(projectId).find((entry) => entry.id !== id && entry.status !== 'inactive'
        && entry.status !== 'superseded' && normalizedContent(entry.kind,entry.title,entry.body) === normalizedContent(normalized.kind,normalized.title,normalized.body));
      if (duplicate) throw new Error('项目中已有相同内容的有效条目');
      const now = new Date().toISOString();
      const replacement: MemoryEntry = { id:crypto.randomUUID(),projectId,kind:normalized.kind,title:normalized.title,body:normalized.body,
        source:normalized.source,taskId:normalized.taskId,evidenceRefs:normalized.evidenceRefs,status:'adopted',version:1,
        createdAt:now,updatedAt:now,expiresAt:normalized.expiresAt,replacedById:null };
      const superseded = { ...previous,status:'superseded' as const,replacedById:replacement.id,version:previous.version+1,updatedAt:now };
      this.store.saveMemoryHistory(previous);
      this.store.createMemoryEntry(replacement,input.requestId);
      this.store.updateMemoryEntry(superseded);
      if (input.requestId) this.store.createMemoryRequest(projectId,input.requestId,fp,replacement.id);
      return { previous:superseded,entry:replacement };
    });
  }

  search(projectId: string, query: string, options: { statuses?: MemoryStatus[]; kind?: MemoryKind; limit?: number; excludeExpired?: boolean } = {}): MemoryMatch[] {
    this.project(projectId);
    if (typeof query !== 'string' || query.length > 1000) throw new Error('检索内容最多1000字符');
    const terms = tokens(query);
    if (!terms.length) return [];
    const statuses = options.statuses ? new Set(options.statuses) : null;
    const scored: MemoryMatch[] = [];
    for (const entry of this.store.listMemoryEntries(projectId)) {
      if (statuses && !statuses.has(entry.status)) continue;
      if (options.kind && entry.kind !== options.kind) continue;
      if (options.excludeExpired && isExpired(entry)) continue;
      const titleTerms = new Set(tokens(entry.title));
      const bodyTerms = new Set(tokens(entry.body));
      const matchedTerms = terms.filter((term) => titleTerms.has(term) || bodyTerms.has(term));
      const titleHits = matchedTerms.filter((term) => titleTerms.has(term)).length;
      const bodyHits = matchedTerms.filter((term) => bodyTerms.has(term)).length;
      const score = titleHits*3+bodyHits;
      if (score > 0) scored.push({entry,score,matchedTerms});
    }
    return scored.sort((a,b)=>b.score-a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0,Math.max(0,Math.min(options.limit ?? 20,100)));
  }

  prepareTaskInjection(taskId: string, query: string, charBudget = DEFAULT_CHAR_BUDGET): MemoryInjectionSnapshot {
    const prior = this.store.getTaskMemoryInjection(taskId);
    if (prior) return prior;
    const task = this.store.getSession(taskId);
    if (!task) throw new Error('任务不存在');
    if (!Number.isInteger(charBudget) || charBudget < 0 || charBudget > 20000) throw new Error('记忆注入预算必须为0到20000字符');
    // Retrieval input is bounded independently; the original task text remains unchanged in TaskService.send.
    const retrievalQuery = query.slice(0,1000);
    const matches = this.search(task.projectId,retrievalQuery,{statuses:['adopted'],limit:12,excludeExpired:true});
    const entries: MemoryInjectionSnapshot['entries'] = [];
    let remaining = Math.max(0,charBudget-MEMORY_CONTEXT_HEADER.length);
    for (const match of matches) {
      const entry = match.entry;
      const fixed = `[项目经验参考 · 已采用 · ${entry.kind}] ${entry.title}\n来源：${entry.source}；版本：${entry.version}\n`;
      const separator = entries.length ? 2 : 0;
      if (remaining <= fixed.length+separator) continue;
      const contentBudget = remaining-fixed.length-separator;
      const fullLabel = '正文：\n';
      const excerptLabel = '正文摘录（含命中词与上下文，非全文）：\n';
      let bodyText: string;
      if (entry.body.length+fullLabel.length <= contentBudget) {
        bodyText = `${fullLabel}${entry.body}`;
      } else {
        const excerptBudget = Math.min(MAX_MATCH_EXCERPT_CHARS,contentBudget-excerptLabel.length);
        const excerpt = excerptAroundMatch(entry.body,match.matchedTerms,excerptBudget);
        if (!excerpt) continue;
        bodyText = `${excerptLabel}${excerpt}`;
      }
      const injectedText = `${fixed}${bodyText}`;
      remaining -= injectedText.length+separator;
      entries.push({ ...entry,matchedTerms:match.matchedTerms,injectedText });
      if (entries.length >= 5) break;
    }
    return this.store.saveTaskMemoryInjection({ taskId,projectId:task.projectId,query:retrievalQuery,createdAt:new Date().toISOString(),charBudget,entries });
  }

  getTaskInjection(taskId: string): MemoryInjectionSnapshot | null {
    const task = this.store.getSession(taskId);
    if (!task) throw new Error('任务不存在');
    return this.store.getTaskMemoryInjection(taskId);
  }
}
