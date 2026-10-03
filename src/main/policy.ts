// 任务权限策略中可独立判定的路径和 Bash 输入。
import * as path from 'node:path';
import * as fs from 'node:fs';
import { canonicalPath } from './files';

export type PolicyDecision =
  | { kind: 'allow'; rule: string }
  | { kind: 'ask'; reason: string };

// 仅在创建时解析授权目录；保存的是物理路径，之后不重新解析根以免链接替换扩大授权。
export function canonicalReadRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => {
    let real: string;
    try {
      real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    } catch { throw new Error(`scope.readRoots 必须是现存可核验目录：${root}`); }
    if (real === path.parse(real).root) throw new Error('scope.readRoots 不能授权文件系统根目录');
    return real;
  }))].sort();
}

export function classifyReadInput(toolName: string, input: any, cwd: string, readRoots: string[] = []): PolicyDecision {
  const invalidPath = (value: unknown) => typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { kind: 'ask', reason: '无法识别读取目标路径' };
  for (const key of ['file_path', 'filePath', 'notebook_path', 'path']) {
    if (input[key] !== undefined && invalidPath(input[key])) return { kind: 'ask', reason: '读取目标路径格式无效' };
  }
  if (input.paths !== undefined && (!Array.isArray(input.paths) || !input.paths.length || input.paths.some(invalidPath)))
    return { kind: 'ask', reason: '读取目标路径格式无效' };
  if (input.edits !== undefined && (!Array.isArray(input.edits) || input.edits.some((edit: any) =>
      !edit || typeof edit !== 'object' || invalidPath(edit.file_path))))
    return { kind: 'ask', reason: '读取目标路径格式无效' };
  const targets = extractTargetPaths(toolName, input);
  if (toolName === 'Read' && !targets.length) return { kind: 'ask', reason: '无法识别读取目标路径，不能按项目内读取自动放行' };
  // 搜索工具的通配符只筛选既定目录；绝对 pattern/目录穿越无法当成 cwd 内搜索。
  const pattern = toolName === 'Glob' ? input.pattern : toolName === 'Grep' ? input.glob : undefined;
  // ponytail: 花括号仅自动允许文件名内的简单备选；复杂目录模式逐条确认，扩展时再核验解析器。
  if (pattern !== undefined && (invalidPath(pattern) || path.isAbsolute(pattern) || pattern.startsWith('~')
      || pattern.includes('\\') || pattern.replace(/[{},\[\]]/g, '').split('/').includes('..')
      || /[{}]/.test(pattern.slice(0, pattern.lastIndexOf('/') + 1))
      || /[{}]/.test(pattern.replace(/\{[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+\}/g, ''))))
    return { kind: 'ask', reason: '搜索模式可能读取目录之外的路径，需逐条确认' };
  const searchTargets = targets.length ? targets : [cwd];
  if (toolName === 'Glob' && typeof pattern === 'string') {
    const prefix: string[] = [];
    for (const segment of pattern.split('/')) {
      if (/[*?\[\]{}()!]/.test(segment)) break;
      prefix.push(segment);
    }
    if (prefix.length) targets.push(...searchTargets.map((target) => path.join(target, ...prefix)));
  }
  const roots = [canonicalPath(cwd), ...readRoots];
  for (const target of targets.length ? targets : searchTargets) {
    const canonical = canonicalPath(path.resolve(cwd, target));
    if (!roots.some((root) => {
      const rel = path.relative(root, canonical);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    })) return { kind: 'ask', reason: '读取目标在项目目录之外，且不在任务 readRoots 授权范围内' };
  }
  return { kind: 'allow', rule: '项目或任务额外只读目录内的文件读取' };
}

export function extractTargetPaths(_toolName: string, input: any): string[] {
  if (!input || typeof input !== 'object') return [];
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && v.trim()) out.push(v); };
  push(input.file_path);
  push(input.filePath);
  push(input.notebook_path);
  push(input.path);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) if (edit && typeof edit === 'object') push((edit as any).file_path);
  }
  if (Array.isArray(input.paths)) for (const p of input.paths) push(p);
  return out;
}

export function isInsideDir(root: string, target: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface BashClassification {
  decision: PolicyDecision;
  command: string;
}

// 自由形式 Bash 会做通配符展开、选项解释、PATH 查找，还可能运行 Git 配置中的外部程序。
// 只自动放行固定系统程序、固定参数、一个字面项目路径；其他命令交给任务的隔离执行范围或用户确认。
const LITERAL_FILE_COMMAND = /^(\/bin\/cat --|\/usr\/bin\/shasum -a 256 --) ([A-Za-z0-9._/-]+)$/;
const SENSITIVE_NAME = /(^|\/)(?:credentials?(?:[./]|$)|secrets?(?:[./]|$)|id_(?:rsa|ed25519|ecdsa|dsa)(?:[./]|$))|\.(?:pem|key|p12|pfx)$/i;

export function classifyBashInput(input: any, cwd: string): BashClassification {
  const command = typeof input?.command === 'string' ? input.command : '';
  if (input?.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false)
    return { command, decision: { kind: 'ask', reason: 'Bash 请求绕过执行器沙箱，不属于任务只读自动放行范围' } };
  const matched = LITERAL_FILE_COMMAND.exec(command);
  if (!matched || matched[0] !== command) {
    return { command, decision: { kind: 'ask', reason: '自由形式 Bash 无法证明操作仅限项目内读取；请使用项目读取工具或逐条确认' } };
  }
  const relativePath = matched[2];
  if (path.isAbsolute(relativePath) || !isInsideDir(cwd, path.resolve(cwd, relativePath))) {
    return { command, decision: { kind: 'ask', reason: '读取目标在项目目录之外' } };
  }
  if (relativePath.split('/').some((part) => part.startsWith('.')) || SENSITIVE_NAME.test(relativePath)) {
    return { command, decision: { kind: 'ask', reason: '读取目标可能包含凭据或隐藏文件，需逐条确认' } };
  }
  try {
    const stat = fs.statSync(path.resolve(cwd, relativePath));
    if (!stat.isFile() || (matched[1].startsWith('/bin/cat') && stat.size > 2 * 1024 * 1024))
      return { command, decision: { kind: 'ask', reason: '目标不是普通文件或超过安全读取上限' } };
  } catch {
    return { command, decision: { kind: 'ask', reason: '目标文件不存在或无法核验类型' } };
  }
  return { command, decision: { kind: 'allow', rule: matched[1].startsWith('/bin/cat') ? '固定系统程序读取项目文件' : '固定系统程序计算项目文件 SHA-256' } };
}
