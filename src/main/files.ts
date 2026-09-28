// 文件服务：项目内文件树、读写、差异；路径限定在项目根与 worktree 内。
// 并行写入隔离：git 项目用 worktree；非 git 项目由 taskService 限制单写者。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface FileNode {
  name: string;
  path: string;         // 相对 root
  type: 'file' | 'dir';
  children?: FileNode[];
}

const IGNORED = new Set(['.git', 'node_modules', '.workbench', '.DS_Store']);

export function canonicalPath(p: string): string {
  try { return fs.realpathSync(p); } catch { /* 不存在：向上找最深存在祖先再拼接 */ }
  const abs = path.resolve(p);
  const parts = abs.split(path.sep);
  for (let i = parts.length; i >= 2; i--) {
    const candidate = parts.slice(0, i).join(path.sep);
    try {
      const real = fs.realpathSync(candidate);
      const rest = parts.slice(i).join(path.sep);
      return rest ? path.join(real, rest) : real;
    } catch { /* 更上一层 */ }
  }
  return abs;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function git(root: string, args: string[], opts?: { allowFail?: boolean }): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    if (opts?.allowFail) return null;
    throw new Error(`git ${args.join(' ')} 失败: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
}

export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true';
}

export function tree(root: string, depth = 4): FileNode | null {
  const walk = (dir: string, rel: string, d: number): FileNode | null => {
    let stat: fs.Stats;
    try { stat = fs.statSync(dir); } catch { return null; }
    if (!stat.isDirectory()) return null;
    const node: FileNode = { name: path.basename(dir) || dir, path: rel, type: 'dir', children: [] };
    if (d <= 0) return node;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return node; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        const c = walk(childPath, childRel, d - 1);
        if (c) node.children!.push(c);
      } else if (e.isFile()) {
        node.children!.push({ name: e.name, path: childRel, type: 'file' });
      }
    }
    return node;
  };
  return walk(root, '', depth);
}

export function readTextFile(root: string, relPath: string, maxBytes = 2 * 1024 * 1024): { content: string; truncated: boolean } {
  const abs = path.resolve(root, relPath);
  if (!isInside(root, abs)) throw new Error('路径超出项目范围');
  const stat = fs.statSync(abs);
  if (stat.size > maxBytes) {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return { content: buf.toString('utf8'), truncated: true };
  }
  return { content: fs.readFileSync(abs, 'utf8'), truncated: false };
}

export function writeTextFile(root: string, relPath: string, content: string): void {
  const abs = path.resolve(root, relPath);
  if (!isInside(root, abs)) throw new Error('路径超出项目范围');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// 行级 LCS diff（无第三方依赖）
export interface DiffLine { type: 'ctx' | 'add' | 'del'; text: string; }

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n'); const B = b.split('\n');
  const n = A.length, m = B.length;
  // 对大文件截断保护
  if (n * m > 4_000_000) {
    return [...A.map(t => ({ type: 'del' as const, text: t })), ...B.map(t => ({ type: 'add' as const, text: t }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'ctx', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: A[i] }); i++; }
  while (j < m) { out.push({ type: 'add', text: B[j] }); j++; }
  return out;
}

// git 项目：取某路径相对 HEAD 的统一 diff 文本
export function gitDiffPath(root: string, relPath: string, baseRef?: string): string | null {
  const args = ['diff', '--no-color', ...(baseRef ? [baseRef] : []), '--', relPath];
  return git(root, args, { allowFail: true });
}

// git 项目：整个工作区相对 HEAD 的变更列表
export function gitStatusChanges(root: string): { path: string; change: 'add' | 'modify' | 'delete' }[] {
  const out = git(root, ['status', '--porcelain'], { allowFail: true });
  if (out == null) return [];
  const res: { path: string; change: 'add' | 'modify' | 'delete' }[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3).trim().replace(/^"|"$/g, '');
    if (code.includes('??') || code.includes('A')) res.push({ path: p, change: 'add' });
    else if (code.includes('D')) res.push({ path: p, change: 'delete' });
    else res.push({ path: p, change: 'modify' });
  }
  return res;
}

// ---- worktree 隔离 ----
export function worktreeDir(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, '.workbench', 'worktrees', taskId);
}

export function createWorktree(projectRoot: string, taskId: string): string {
  const wt = worktreeDir(projectRoot, taskId);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(projectRoot, ['worktree', 'add', wt, '-b', `workbench/${taskId}`]);
  return wt;
}

export function removeWorktree(projectRoot: string, taskId: string): void {
  const wt = worktreeDir(projectRoot, taskId);
  if (fs.existsSync(wt)) {
    git(projectRoot, ['worktree', 'remove', '--force', wt], { allowFail: true });
  }
  git(projectRoot, ['branch', '-D', `workbench/${taskId}`], { allowFail: true });
}

export interface MergeCheck {
  ok: boolean;
  reason?: string;                 // 冲突/未提交改动说明
  changedPaths: string[];          // 子任务分支相对 base 的变更
  dirtyPaths: string[];            // 主树未提交且与变更重叠的路径
}

export function worktreeMergeCheck(projectRoot: string, taskId: string): MergeCheck {
  const wt = worktreeDir(projectRoot, taskId);
  if (!fs.existsSync(wt)) return { ok: false, reason: 'worktree 不存在', changedPaths: [], dirtyPaths: [] };
  const changed = (git(wt, ['diff', '--name-only', `workbench/${taskId}@{1}`], { allowFail: true })
    ?? git(wt, ['diff', '--name-only', 'HEAD'], { allowFail: true }) ?? '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  // worktree 分支创建时可能没有提交：用 diff against merge-base
  const base = git(projectRoot, ['merge-base', 'HEAD', `workbench/${taskId}`], { allowFail: true })?.trim();
  const changedFinal = base
    ? git(projectRoot, ['diff', '--name-only', base, `workbench/${taskId}`], { allowFail: true }) ?? ''
    : '';
  const paths = (changedFinal || changed.join('\n')).split('\n').map(s => s.trim()).filter(Boolean);
  const dirty = (git(projectRoot, ['status', '--porcelain'], { allowFail: true }) ?? '')
    .split('\n').filter(Boolean).map(l => l.slice(3).trim());
  const overlap = paths.filter(p => dirty.includes(p));
  if (overlap.length) {
    return { ok: false, reason: '主工作区存在同一文件的未提交改动，合并会覆盖用户修改', changedPaths: paths, dirtyPaths: overlap };
  }
  // 干跑检查冲突
  if (base) {
    const patch = git(projectRoot, ['diff', '--binary', base, `workbench/${taskId}`], { allowFail: true });
    if (patch) {
      try {
        execFileSync('git', ['apply', '--check', '-'], { cwd: projectRoot, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        return { ok: false, reason: '补丁无法干净应用（冲突）', changedPaths: paths, dirtyPaths: [] };
      }
    }
  }
  return { ok: true, changedPaths: paths, dirtyPaths: [] };
}

export function worktreeApply(projectRoot: string, taskId: string): { ok: boolean; reason?: string; changedPaths: string[] } {
  const check = worktreeMergeCheck(projectRoot, taskId);
  if (!check.ok) return { ok: false, reason: check.reason, changedPaths: check.changedPaths };
  const base = git(projectRoot, ['merge-base', 'HEAD', `workbench/${taskId}`], { allowFail: true })?.trim();
  if (!base) return { ok: false, reason: '无法确定基线提交', changedPaths: [] };
  const patch = git(projectRoot, ['diff', '--binary', base, `workbench/${taskId}`], { allowFail: true });
  if (!patch) return { ok: true, changedPaths: [] };
  try {
    execFileSync('git', ['apply', '-'], { cwd: projectRoot, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, changedPaths: check.changedPaths };
  } catch (e: any) {
    return { ok: false, reason: '应用补丁失败（冲突）', changedPaths: check.changedPaths };
  }
}

// ---- 背景快照（委派时生成：文件内容/版本 + 未提交补丁；防私密文件全量打包）----
import * as crypto from 'node:crypto';
export const SNAPSHOT_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 24 * 1024,
  maxTotalBytes: 96 * 1024,
  maxPatchBytes: 48 * 1024,
};

const SNAPSHOT_DENYLIST: RegExp[] = [
  /(^|\/)\.env[^/]*$/i,
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.workbench\//,
  /\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519|credentials|secret/i,
];

export function isSnapshotDenied(relPath: string): boolean {
  return SNAPSHOT_DENYLIST.some((re) => re.test(relPath));
}

export interface SnapshotFile {
  path: string;
  bytes: number;
  sha256: string;
  included: boolean;
  truncated?: boolean;
  reason?: string;
}

export interface BackgroundSnapshot {
  generatedAt: string;
  projectRoot: string;
  isGit: boolean;
  head?: string;
  files: SnapshotFile[];
  totalBytes: number;
  patchBytes: number;
}

// 生成背景快照：读取主树当前文件内容与版本（sha256 前16位），git 项目附带未提交补丁
export function buildBackgroundSnapshot(
  projectRoot: string,
  files: string[],
): { meta: BackgroundSnapshot; sections: string } {
  const isGit = isGitRepo(projectRoot);
  const head = isGit ? git(projectRoot, ['rev-parse', '--short', 'HEAD'], { allowFail: true })?.trim() : undefined;
  const meta: BackgroundSnapshot = {
    generatedAt: new Date().toISOString(),
    projectRoot,
    isGit,
    head,
    files: [],
    totalBytes: 0,
    patchBytes: 0,
  };
  const parts: string[] = [];
  let total = 0;
  for (const rel of files.slice(0, SNAPSHOT_LIMITS.maxFiles)) {
    const clean = rel.replace(/^\.\//, '');
    if (isSnapshotDenied(clean)) {
      meta.files.push({ path: clean, bytes: 0, sha256: '', included: false, reason: '私密/排除路径，已跳过' });
      continue;
    }
    const abs = path.join(projectRoot, clean);
    if (!isInside(projectRoot, abs)) {
      meta.files.push({ path: clean, bytes: 0, sha256: '', included: false, reason: '路径超出项目范围' });
      continue;
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch {
      meta.files.push({ path: clean, bytes: 0, sha256: '', included: false, reason: '文件不存在' });
      continue;
    }
    if (!stat.isFile()) {
      meta.files.push({ path: clean, bytes: 0, sha256: '', included: false, reason: '不是常规文件' });
      continue;
    }
    const bytes = stat.size;
    const sha = git(projectRoot, ['hash-object', abs], { allowFail: true })?.trim().slice(0, 16)
      ?? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
    meta.files.push({ path: clean, bytes, sha256: sha, included: true });
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) {
      parts.push(`#### [${clean}] sha=${sha} (${bytes}B)\n（二进制文件，未内联内容）\n`);
      continue;
    }
    if (total + Math.min(bytes, SNAPSHOT_LIMITS.maxFileBytes) > SNAPSHOT_LIMITS.maxTotalBytes) {
      meta.files[meta.files.length - 1].included = false;
      meta.files[meta.files.length - 1].reason = '超出快照总量上限，未内联';
      parts.push(`#### [${clean}] sha=${sha} (${bytes}B)\n（超出总量上限，未内联；子任务可用只读工具自行查看）\n`);
      continue;
    }
    if (bytes > SNAPSHOT_LIMITS.maxFileBytes) {
      meta.files[meta.files.length - 1].truncated = true;
      const text = buf.subarray(0, SNAPSHOT_LIMITS.maxFileBytes).toString('utf8');
      total += SNAPSHOT_LIMITS.maxFileBytes;
      parts.push(`#### [${clean}] sha=${sha} (${bytes}B，截断至前 ${SNAPSHOT_LIMITS.maxFileBytes}B)\n\`\`\`\n${text}\n\`\`\`\n`);
    } else {
      total += bytes;
      parts.push(`#### [${clean}] sha=${sha} (${bytes}B)\n\`\`\`\n${buf.toString('utf8')}\n\`\`\`\n`);
    }
  }
  if (files.length > SNAPSHOT_LIMITS.maxFiles) {
    parts.push(`（文件数超过 ${SNAPSHOT_LIMITS.maxFiles}，仅内联前 ${SNAPSHOT_LIMITS.maxFiles} 个）\n`);
  }
  meta.totalBytes = total;
  // git 项目：主树未提交改动补丁（子任务 worktree 看不到主树未提交内容，必须显式携带）
  if (isGit) {
    const cleanFiles = files.slice(0, SNAPSHOT_LIMITS.maxFiles).map((f) => f.replace(/^\.\//, ''));
    const tracked = cleanFiles.filter((f) => {
      try { execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; }
    });
    const untracked = cleanFiles.filter((f) => !tracked.includes(f));
    const patch = tracked.length
      ? git(projectRoot, ['diff', '--no-color', 'HEAD', '--', ...tracked], { allowFail: true }) ?? ''
      : '';
    const trimmed = patch.length > SNAPSHOT_LIMITS.maxPatchBytes ? patch.slice(0, SNAPSHOT_LIMITS.maxPatchBytes) + '\n…（补丁截断）' : patch;
    meta.patchBytes = trimmed.length;
    if (trimmed.trim()) {
      parts.push(`#### 主树未提交改动补丁（相对 HEAD ${head ?? ''}）\n\`\`\`diff\n${trimmed}\n\`\`\`\n`);
    } else {
      parts.push(`#### 主树未提交改动补丁\n（tracked 文件无未提交改动）\n`);
    }
    if (untracked.length) {
      parts.push(`#### 未跟踪新文件（完整内容已在上文内联）\n${untracked.map((f) => `- ${f}`).join('\n')}\n`);
    }
  }
  return { meta, sections: parts.join('\n') };
}

// 非 git 项目的写冲突兜底：记录任务基线 mtime，写入前检查文件是否被其他写者改动
export class WriteConflictGuard {
  private baseMtimes = new Map<string, number>();
  constructor(private projectRoot: string) {}
  snapshot(paths: string[]): void {
    for (const p of paths) {
      try { this.baseMtimes.set(p, fs.statSync(path.join(this.projectRoot, p)).mtimeMs); } catch { this.baseMtimes.set(p, NaN); }
    }
  }
  checkBeforeWrite(relPath: string): { ok: boolean; reason?: string } {
    const recorded = this.baseMtimes.get(relPath);
    if (recorded === undefined) return { ok: true };
    let cur = NaN;
    try { cur = fs.statSync(path.join(this.projectRoot, relPath)).mtimeMs; } catch {}
    if (!Number.isNaN(recorded) && !Number.isNaN(cur) && cur !== recorded) {
      return { ok: false, reason: `文件 ${relPath} 在任务基线后被其他写者修改，拒绝覆盖` };
    }
    return { ok: true };
  }
}
