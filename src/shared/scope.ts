// 任务范围（TaskScope）的规范化、校验、子集判定与幂等指纹。
// 主进程 / renderer / MCP 入口共用；旧任务缺省字段一律收窄为最严格值，不回填扩大。
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { TaskScope } from './types';

export const BASH_MODES = ['none', 'readonly'] as const;
export type BashMode = (typeof BASH_MODES)[number];

export type ScopeSource = 'ui' | 'mcp' | 'control' | 'derived' | 'legacy';

function validReadRoots(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 20 && value.every((root) =>
    typeof root === 'string' && root.length <= 4096 && !/[\r\n\0]/.test(root)
    && path.isAbsolute(root) && path.resolve(root) !== path.parse(root).root);
}

function normalizedReadRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(root)))].sort();
}

function validChecks(value: unknown): value is NonNullable<TaskScope['isolatedChecks']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checks = value as Record<string, unknown>;
  return Object.keys(checks).every((key) => ['image', 'commands'].includes(key))
    && typeof checks.image === 'string' && /^sha256:[a-f0-9]{64}$/.test(checks.image)
    && Array.isArray(checks.commands) && checks.commands.length >= 1 && checks.commands.length <= 10
    && checks.commands.every((command) => typeof command === 'string' && !!command.trim()
      && command.length <= 500 && !/[\r\n\0]/.test(command))
    && new Set(checks.commands).size === checks.commands.length;
}

// 完整授权范围。旧库 scopeJson 只写 fileWrite：缺省字段按最严格解释（bash=none、network=false），
// 保证旧任务授权不被静默扩大。
export function normalizeScope(raw: unknown): TaskScope {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bash = typeof src.bash === 'string' && (BASH_MODES as readonly string[]).includes(src.bash)
    ? src.bash as BashMode : 'none';
  return {
    fileWrite: src.fileWrite === true,
    bash,
    network: src.network === true,
    ...(validReadRoots(src.readRoots) && src.readRoots.length ? { readRoots: normalizedReadRoots(src.readRoots) } : {}),
    ...(validChecks(src.isolatedChecks) ? { isolatedChecks: src.isolatedChecks } : {}),
  };
}

export function parseScopeJson(scopeJson: string | null | undefined): TaskScope {
  try { return normalizeScope(JSON.parse(scopeJson || '{}')); } catch { return normalizeScope(null); }
}

// 入口校验：未知/类型不符的字段直接报错，不做静默修正（MCP/control/UI 创建入口共用）。
// readRoots 的现存目录/realpath 核验由主进程创建入口完成。
export function validateScopeInput(input: unknown): { ok: true; scope: TaskScope } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, scope: normalizeScope(null) };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'scope 必须是对象' };
  const src = input as Record<string, unknown>;
  const allowed = new Set(['fileWrite', 'bash', 'network', 'readRoots', 'isolatedChecks']);
  for (const key of Object.keys(src)) {
    if (!allowed.has(key)) return { ok: false, error: `scope 含未知字段：${key}（允许 fileWrite/bash/network/readRoots/isolatedChecks）` };
  }
  if (src.fileWrite !== undefined && typeof src.fileWrite !== 'boolean') return { ok: false, error: 'scope.fileWrite 必须是布尔值' };
  if (src.network !== undefined && typeof src.network !== 'boolean') return { ok: false, error: 'scope.network 必须是布尔值' };
  if (src.readRoots !== undefined && !validReadRoots(src.readRoots))
    return { ok: false, error: 'scope.readRoots 需要最多 20 个具体绝对目录路径（不能是文件系统根目录）' };
  if (src.bash !== undefined && !(BASH_MODES as readonly string[]).includes(String(src.bash)))
    return { ok: false, error: `scope.bash 仅支持 ${BASH_MODES.join('/')}` };
  if (src.isolatedChecks !== undefined) {
    if (!validChecks(src.isolatedChecks))
      return { ok: false, error: 'scope.isolatedChecks 需要本地镜像 sha256 ID 与 1-10 条不重复的单行命令（每条最多 500 字）' };
  }
  return { ok: true, scope: normalizeScope(src) };
}

// 子任务范围：只能是父任务范围的子集；隔离检查目前只有主任务工具可用，不继承。
export function deriveChildScope(parent: TaskScope, childCanWrite: boolean): TaskScope {
  return {
    fileWrite: parent.fileWrite && childCanWrite,
    bash: parent.bash,
    network: parent.network,
    ...(parent.readRoots?.length ? { readRoots: [...parent.readRoots] } : {}),
  };
}

export function scopeEquals(a: TaskScope, b: TaskScope): boolean {
  return scopeFingerprintPart(a) === scopeFingerprintPart(b);
}

// 幂等指纹输入：创建请求去重必须包含完整范围（而非其中一两个字段）。
export function scopeFingerprintPart(scope: TaskScope): string {
  const existing = [scope.fileWrite, scope.bash, scope.network, scope.isolatedChecks ?? null];
  const roots = normalizedReadRoots(scope.readRoots ?? []);
  return JSON.stringify(roots.length ? [...existing, roots] : existing);
}

export function scopeSummary(scope: TaskScope): string {
  const parts = [`项目内写文件：${scope.fileWrite ? '允许' : '禁止'}`];
  parts.push(scope.bash === 'readonly' ? 'Bash：仅严格只读命令自动放行' : 'Bash：逐条请求确认');
  parts.push(`网络工具：${scope.network ? '允许' : '禁止'}`);
  if (scope.readRoots?.length) parts.push(`额外只读目录：${scope.readRoots.join('、')}（仅文件读取工具）`);
  if (scope.isolatedChecks) parts.push(`隔离检查：镜像 ${scope.isolatedChecks.image.slice(0, 19)}…，${scope.isolatedChecks.commands.length} 条固定命令`);
  return parts.join('；');
}

export function scopeHash(scope: TaskScope): string {
  return crypto.createHash('sha1').update(scopeFingerprintPart(scope)).digest('hex').slice(0, 12);
}
