// 任务范围授权后自主执行：范围校验/快照/指纹、Bash 分类、逻辑待授权去重、
// 状态衔接（取消/执行器退出/重启失效）、决定落盘顺序、控制通道入口校验。
// 全部使用隔离数据目录与临时项目，凭据为合成假 Key。
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import { ControlServer } from '../src/main/controlServer';
import { classifyBashInput } from '../src/main/policy';
import { makeSnapshot, removeSnapshot } from '../src/main/isolatedCheck';
import { validateScopeInput, normalizeScope, parseScopeJson, deriveChildScope, scopeFingerprintPart } from '../src/shared/scope';
import type { WorkbenchEvent } from '../src/shared/types';

let tmp: string;
let ccDb: string;
const PROV_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function insertProvider(id: string, name: string, model: string, key: string) {
  const db = new DatabaseSync(ccDb);
  db.prepare(`INSERT OR REPLACE INTO providers(id,app_type,name,settings_config,is_current,sort_index) VALUES (?,?,?,?,?,?)`)
    .run(id, 'claude', name, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://fake.example/api', ANTHROPIC_MODEL: model, ANTHROPIC_AUTH_TOKEN: key } }), 1, 0);
  db.close();
}

interface Fixture {
  dir: string; dbPath: string; store: Store; service: TaskService;
  project: { id: string; rootPath: string };
  task: (extra?: any) => ReturnType<TaskService['createMainSession']>;
  events: (taskId: string) => WorkbenchEvent[];
  wait: (ms: number) => Promise<void>;
  notifications: Array<{ taskId: string; toolName: string; reason: string }>;
  close: () => void;
}

function makeFixture(withProvider = true): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-policy-'));
  const dbPath = path.join(dir, 'wb.db');
  const store = new Store(dbPath);
  const cm = withProvider
    ? new CredentialManager(ccDb, { ttlMs: 0 })
    : new CredentialManager(path.join(dir, 'missing-cc.db'), { ttlMs: 0 });
  const service = new TaskService(store, cm);
  service.importModelProfiles(); // Fixture explicitly opts in to synthetic model import.
  const notifications: any[] = [];
  service.permissionNotifier = (info) => notifications.push(info);
  const projectRoot = path.join(dir, 'proj');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# 项目\n', 'utf8');
  const project = service.createProject(projectRoot, 'policy-test');
  const task = (extra: any = {}) => service.createMainSession({
    projectId: project.id, title: '范围测试', agentId: 'claude-code', providerId: withProvider ? PROV_A : undefined,
    ...extra,
    scope: extra.scope ?? { fileWrite: true, bash: 'readonly', network: false },
  });
  return {
    dir, dbPath, store, service, project, task,
    events: (taskId: string) => service.listEvents(taskId),
    wait: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    notifications,
    close() { service.shutdown(); try { store.close(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

let f: Fixture;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-policy-cc-'));
  ccDb = path.join(tmp, 'cc-switch.db');
  const db = new DatabaseSync(ccDb);
  db.exec(`CREATE TABLE providers(
    id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
    is_current INTEGER DEFAULT 0, sort_index INTEGER DEFAULT 0)`);
  db.close();
  insertProvider(PROV_A, 'Fake A', 'model-a', 'TEST-KEY-A');
  f = makeFixture();
});

afterEach(() => {
  f.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const policy = (session: any, toolName: string, input: any, ctx?: any) =>
  (f.service as any).policyCheck(session, toolName, input, ctx) as Promise<{ behavior: string; message?: string }>;

// ---- 范围模块 ----
test('范围校验：未知字段/类型错误拒绝，旧数据按最严格解释', () => {
  assert.equal(validateScopeInput({ fileWrite: true, bash: 'readonly', network: false }).ok, true);
  assert.equal(validateScopeInput({ fileWrite: true, bash: 'all' }).ok, false, 'bash=all 不存在，必须拒绝');
  assert.equal(validateScopeInput({ evil: true }).ok, false, '未知字段必须拒绝');
  assert.equal(validateScopeInput({ fileWrite: 'yes' }).ok, false);
  assert.equal(validateScopeInput('write').ok, false);
  const legacy = normalizeScope({ fileWrite: true });
  assert.deepEqual(legacy, { fileWrite: true, bash: 'none', network: false }, '旧任务缺省字段收窄，不静默扩大');
  assert.deepEqual(parseScopeJson('not-json'), { fileWrite: false, bash: 'none', network: false });
  assert.equal(scopeFingerprintPart(normalizeScope({ fileWrite: true })), scopeFingerprintPart(normalizeScope({ fileWrite: true, bash: 'none', network: false })));
});

test('隔离检查范围：只接受固定镜像 ID 与精确命令，指纹包含命令', () => {
  const image = `sha256:${'a'.repeat(64)}`;
  const a = normalizeScope({ isolatedChecks: { image, commands: ['python -m compileall -q .'] } });
  const b = normalizeScope({ isolatedChecks: { image, commands: ['python -m unittest'] } });
  assert.equal(validateScopeInput(a).ok, true);
  assert.notEqual(scopeFingerprintPart(a), scopeFingerprintPart(b));
  assert.equal(validateScopeInput({ isolatedChecks: { image: 'python:latest', commands: ['true'] } }).ok, false);
  assert.equal(validateScopeInput({ isolatedChecks: { image, commands: ['true\nrm -rf /'] } }).ok, false);
  assert.equal(validateScopeInput({ isolatedChecks: { image, commands: ['true', 'true'] } }).ok, false);
  assert.equal(deriveChildScope(a, true).isolatedChecks, undefined, '子任务不自动继承专属隔离检查');
});

test('子任务范围是父任务范围的子集', () => {
  const parent = { fileWrite: true, bash: 'readonly' as const, network: true };
  assert.deepEqual(deriveChildScope(parent, true), { fileWrite: true, bash: 'readonly', network: true });
  assert.deepEqual(deriveChildScope(parent, false), { fileWrite: false, bash: 'readonly', network: true });
  const strictParent = { fileWrite: false, bash: 'none' as const, network: false };
  assert.deepEqual(deriveChildScope(strictParent, true), strictParent, '父任务未授权时子任务不能扩大');
  const scopedParent = normalizeScope({ readRoots: ['/tmp/specific-skills'] });
  const child = deriveChildScope(scopedParent, true);
  assert.deepEqual(child.readRoots, scopedParent.readRoots);
  child.readRoots!.push('/tmp/another-root');
  assert.deepEqual(scopedParent.readRoots, ['/tmp/specific-skills'], '子任务不能修改父任务范围');
});

test('额外读取目录：校验、规范化和指纹保持稳定；旧任务不扩大', () => {
  for (const readRoots of [['relative'], ['/'], [null], 'all', ['/tmp/a\0b'], Array(21).fill('/tmp/a')])
    assert.equal(validateScopeInput({ readRoots }).ok, false);
  const a = normalizeScope({ readRoots: ['/tmp/b/', '/tmp/a', '/tmp/b'] });
  const b = normalizeScope({ readRoots: ['/tmp/a', '/tmp/b'] });
  assert.deepEqual(a.readRoots, ['/tmp/a', '/tmp/b']);
  assert.equal(scopeFingerprintPart(a), scopeFingerprintPart(b));
  assert.notEqual(scopeFingerprintPart(a), scopeFingerprintPart(normalizeScope({})));
  assert.equal(scopeFingerprintPart(normalizeScope({ readRoots: [] })), '[false,"none",false,null]', '旧创建请求指纹不变');
  assert.equal(parseScopeJson('{"readRoots":["relative"]}').readRoots, undefined);
});

test('创建时固化额外目录的真实路径、范围快照与幂等指纹', () => {
  const external = path.join(f.dir, 'skills');
  fs.mkdirSync(external);
  const alias = path.join(f.dir, 'skills-alias');
  fs.symlinkSync(external, alias, 'dir');
  const extra = { clientRequestId: 'roots-1', scope: { readRoots: [alias, external] } };
  const created = f.task(extra);
  const roots = [fs.realpathSync(external)];
  assert.deepEqual(JSON.parse(created.scopeJson).readRoots, roots);
  assert.deepEqual(f.events(created.id).find((e) => e.type === 'scope')!.payload.scope.readRoots, roots);
  assert.equal(f.task({ ...extra, scope: { readRoots: [external] } }).id, created.id);
  assert.throws(() => f.task({ ...extra, scope: {} }), /参数不一致/);
  assert.throws(() => f.task({ scope: { readRoots: [path.join(f.dir, 'missing')] } }), /现存可核验目录/);
  assert.throws(() => f.task({ scope: { readRoots: [path.join(f.project.rootPath, 'README.md')] } }), /现存可核验目录/);
  fs.symlinkSync('/', path.join(f.dir, 'root-alias'), 'dir');
  assert.throws(() => f.task({ scope: { readRoots: [path.join(f.dir, 'root-alias')] } }), /文件系统根目录/);
});

// ---- 创建入口：范围快照、来源、幂等指纹 ----
test('创建时保存范围快照与来源；指纹包含完整范围', () => {
  const t1 = f.task({ clientRequestId: 'req-1', scope: { fileWrite: true, bash: 'readonly', network: false } });
  assert.deepEqual(JSON.parse(t1.scopeJson), { fileWrite: true, bash: 'readonly', network: false });
  assert.equal(t1.scopeSource, 'legacy', '直接调用未声明来源时记为 legacy');
  const scopeEv = f.events(t1.id).find((e) => e.type === 'scope');
  assert.ok(scopeEv, '范围快照进入事件流');
  assert.deepEqual(scopeEv!.payload.scope, { fileWrite: true, bash: 'readonly', network: false });
  // 相同 clientRequestId + 相同范围 → 幂等返回同一任务
  const t1b = f.task({ clientRequestId: 'req-1', scope: { fileWrite: true, bash: 'readonly', network: false } });
  assert.equal(t1b.id, t1.id);
  // 相同 clientRequestId + 不同范围（bash 收紧）→ 明确报错，不静默创建
  assert.throws(() => f.task({ clientRequestId: 'req-1', scope: { fileWrite: true, bash: 'none', network: false } }), /参数不一致/);
});

test('非法范围在创建入口被拒绝', () => {
  assert.throws(() => f.task({ scope: { fileWrite: true, bash: 'all' } }), /scope\.bash/);
  assert.throws(() => f.task({ scope: { fileWrite: true, extra: 1 } }), /未知字段/);
});

// ---- Bash 分类器：仅固定系统程序和单个字面项目路径可自动执行 ----
test('Bash：固定项目读取与 SHA-256 可放行', () => {
  const cwd = f.project.rootPath;
  for (const command of ['/bin/cat -- README.md', '/usr/bin/shasum -a 256 -- README.md']) {
    assert.equal(classifyBashInput({ command }, cwd).decision.kind, 'allow');
  }
});

test('Bash：显式绕过沙箱不能复用只读命令授权', async () => {
  const task = f.task({ scope: { bash: 'readonly' } });
  const session = f.service.getSession(task.id)!;
  for (const command of ['/bin/cat -- README.md', '/usr/bin/shasum -a 256 -- README.md']) {
    assert.equal(classifyBashInput({ command, dangerouslyDisableSandbox: false }, session.cwd).decision.kind, 'allow');
    assert.equal(classifyBashInput({ command, dangerouslyDisableSandbox: true }, session.cwd).decision.kind, 'ask');
    const operation = policy(session, 'Bash', { command, dangerouslyDisableSandbox: true });
    const pending = (f.service.listPendingPermissions(task.id) as any).permissions.at(-1)!;
    assert.ok(pending, '固定只读命令不能自动扩大到无沙箱执行');
    assert.match(pending.reason, /绕过执行器沙箱/);
    f.service.respondPermission(pending.permissionId, 'deny');
    assert.equal((await operation).behavior, 'deny');
  }
});

test('Bash：shell 展开、Git 外部程序、越界和任意命令保持人工确认', () => {
  const cwd = f.project.rootPath;
  const outside = path.join(f.dir, 'outside-config');
  for (const command of [
    `git config --file=${outside} --list`, 'cat .env*', 'git diff --ext-diff',
    'env sh -c "touch /tmp/wb-probe"', 'git branch new-branch', 'git remote add sample https://example.com',
    'rg --pre=sh pattern .', './cat README.md', 'printenv', 'npm test',
    '/bin/cat -- ../outside-config', '/bin/cat -- .env.local', '/bin/cat -- server.pem',
    '/bin/cat -- README*', '/bin/cat -- README.md; id', '/usr/bin/shasum -a 256 -- /etc/hosts',
  ]) {
    assert.equal(classifyBashInput({ command }, cwd).decision.kind, 'ask', command);
  }
});

test('Bash：特殊文件、缺失文件和超大 cat 目标不自动执行', () => {
  const cwd = f.project.rootPath;
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  for (const command of ['/bin/cat -- missing.txt', '/bin/cat -- large.txt', '/bin/cat -- src'])
    assert.equal(classifyBashInput({ command }, cwd).decision.kind, 'ask');
});

// ---- policyCheck 集成：路径、符号链接、网络、范围联动 ----
test('policyCheck：项目内读放行', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  assert.equal((await policy(s, 'Read', { file_path: 'README.md' })).behavior, 'allow');
  assert.equal((await policy(s, 'Read', { file_path: 'src/nested/file.ts' })).behavior, 'allow');
});

test('policyCheck：额外只读目录允许文件工具，逐个核验所有目标，不授予写入或 Bash', async () => {
  const external = path.join(f.dir, 'skills');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'SKILL.md'), '# skills');
  const t = f.task({ scope: { fileWrite: true, bash: 'readonly', readRoots: [external] } });
  const s = f.service.getSession(t.id)!;
  for (const [toolName, input] of [
    ['Read', { file_path: path.join(external, 'SKILL.md') }],
    ['Glob', { path: external, pattern: '**/*.md' }],
    ['Glob', { path: external, pattern: '*.{ts,tsx}' }],
    ['Grep', { path: external, pattern: 'skills' }],
    ['LS', { path: external }],
    ['Read', { paths: ['README.md', path.join(external, 'SKILL.md')] }],
  ] as const) assert.equal((await policy(s, toolName, input)).behavior, 'allow');
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0);
  for (const [toolName, input] of [
    ['Read', { file_path: 'README.md', path: '/etc/hosts' }],
    ['Read', { paths: [path.join(external, 'SKILL.md'), '/etc/hosts'] }],
    ['Read', { file_path: 'README.md', paths: [null] }],
    ['Grep', { path: null, pattern: 'x' }],
    ['Glob', { pattern: '../*' }],
    ['Glob', { path: external, pattern: '/etc/*' }],
    ['Glob', { path: external, pattern: '{.}{.}/*' }],
    ['Glob', { path: external, pattern: '{/etc/*,*.md}' }],
    ['Glob', { path: external, pattern: '{..,foo}/*.md' }],
    ['Glob', { path: external, pattern: '{foo,..}/*.md' }],
    ['Glob', { path: external, pattern: './{foo,..}' }],
    ['Glob', { path: external, pattern: '{link,src}/*.md' }],
    ['Grep', { path: external, pattern: 'x', glob: '../*' }],
    ['Grep', { path: external, pattern: 'x', glob: '{/etc/*,*.md}' }],
    ['Write', { file_path: path.join(external, 'SKILL.md'), content: 'change' }],
    ['Bash', { command: `/bin/cat -- ${path.join(external, 'SKILL.md')}` }],
  ] as const) {
    const operation = policy(s, toolName, input);
    const pending = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!;
    assert.ok(pending, `${toolName} ${JSON.stringify(input)} 不得自动放行`);
    f.service.respondPermission(pending.permissionId, 'deny');
    assert.equal((await operation).behavior, 'deny');
  }
});

test('policyCheck：额外目录内链接与根目录替换不能扩大范围', async () => {
  const external = path.join(f.dir, 'skills');
  const other = path.join(f.dir, 'other');
  fs.mkdirSync(external); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'secret.md'), 'secret');
  fs.symlinkSync(other, path.join(external, 'link'), 'dir');
  const t = f.task({ scope: { readRoots: [external] } });
  const s = f.service.getSession(t.id)!;
  for (const target of [path.join(external, 'link/secret.md'), path.join(external, 'link/missing.md')]) {
    const operation = policy(s, 'Read', { file_path: target });
    const pending = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!;
    f.service.respondPermission(pending.permissionId, 'deny');
    assert.equal((await operation).behavior, 'deny');
  }
  const glob = policy(s, 'Glob', { path: external, pattern: 'link/*.md' });
  f.service.respondPermission((f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!.permissionId, 'deny');
  assert.equal((await glob).behavior, 'deny');
  fs.rmSync(external, { recursive: true });
  fs.symlinkSync(other, external, 'dir');
  const operation = policy(s, 'Read', { file_path: path.join(external, 'secret.md') });
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!;
  f.service.respondPermission(pending.permissionId, 'deny');
  assert.equal((await operation).behavior, 'deny', '固化根不随替换后的 symlink 重解释');
});

test('policyCheck：文件工具缺少可识别路径时不自动放行', async () => {
  const t = f.task({ scope: { fileWrite: true, bash: 'none', network: false } });
  const s = f.service.getSession(t.id)!;
  for (const [toolName, input] of [
    ['Read', { target: '/etc/hosts' }],
    ['Write', { target: '/tmp/outside.txt', content: 'x' }],
  ] as const) {
    const operation = policy(s, toolName, input);
    const pending = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!;
    assert.equal(pending.toolName, toolName);
    assert.match(pending.reason, /无法识别.*目标路径/);
    f.service.respondPermission(pending.permissionId, 'deny');
    assert.equal((await operation).behavior, 'deny');
  }
});

test('policyCheck：读越界进入待授权并可拒绝', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const outside = policy(s, 'Read', { file_path: path.join(f.dir, 'secret.txt') });
  const pendings = f.service.listPendingPermissions(t.id);
  assert.equal(pendings.ok, true);
  const found = (pendings as any).permissions.find((p: any) => p.toolUseId == null);
  assert.ok(found, '读越界应产生待授权');
  assert.match(found.reason, /项目目录之外/);
  const before = f.events(t.id).filter((e) => e.type === 'permission_request').length;
  f.service.respondPermission(found.permissionId, 'deny');
  assert.equal((await outside).behavior, 'deny');
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, before, '不产生额外请求');
});

test('无原生调用 ID 的相同输入在不同任务中不能共用授权', async () => {
  const a = f.task();
  const b = f.task();
  const pa = policy(f.service.getSession(a.id)!, 'Read', { file_path: '/etc/hosts' });
  const pb = policy(f.service.getSession(b.id)!, 'Read', { file_path: '/etc/hosts' });
  const ra = (f.service.listPendingPermissions(a.id) as any).permissions;
  const rb = (f.service.listPendingPermissions(b.id) as any).permissions;
  assert.equal(ra.length, 1);
  assert.equal(rb.length, 1);
  assert.notEqual(ra[0].permissionId, rb[0].permissionId);
  f.service.respondPermission(ra[0].permissionId, 'allow');
  f.service.respondPermission(rb[0].permissionId, 'deny');
  assert.equal((await pa).behavior, 'allow');
  assert.equal((await pb).behavior, 'deny');
});

test('policyCheck：符号链接逃逸被 realpath 规范化拦截', async () => {
  const linkPath = path.join(f.project.rootPath, 'link-outside');
  try { fs.symlinkSync(f.dir, linkPath, 'dir'); } catch { /* 平台不支持则跳过 */ }
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  if (fs.existsSync(linkPath)) {
    const r = policy(s, 'Read', { file_path: 'link-outside/cc-switch.db' });
    const pending = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1);
    assert.ok(pending, '符号链接指向项目外必须请求确认');
    f.service.respondPermission(pending.permissionId, 'deny');
    assert.equal((await r).behavior, 'deny');
  }
});

test('policyCheck：Glob/Grep 的 path 参数逐个校验，无 path 默认 cwd 放行', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  assert.equal((await policy(s, 'Grep', { pattern: 'x' })).behavior, 'allow');
  assert.equal((await policy(s, 'Glob', { pattern: '**/*.ts', path: 'src' })).behavior, 'allow');
  const outside = policy(s, 'Glob', { pattern: '*', path: path.join(f.dir, 'elsewhere') });
  const p = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!;
  f.service.respondPermission(p.permissionId, 'deny');
  assert.equal((await outside).behavior, 'deny');
});

test('policyCheck：写入按 scope，越界写与未授权写请求确认并给出原因', async () => {
  const t = f.task({ scope: { fileWrite: true, bash: 'none', network: false } });
  const s = f.service.getSession(t.id)!;
  assert.equal((await policy(s, 'Write', { file_path: 'inside.txt', content: 'x' })).behavior, 'allow');
  const r1 = policy(s, 'Write', { file_path: path.join(f.dir, 'out.txt'), content: 'x' });
  let p1 = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!;
  assert.match(p1.reason, /项目目录之外/);
  f.service.respondPermission(p1.permissionId, 'deny');
  assert.equal((await r1).behavior, 'deny');

  const t2 = f.task({ scope: { fileWrite: false, bash: 'none', network: false } });
  const s2 = f.service.getSession(t2.id)!;
  const r2 = policy(s2, 'Edit', { file_path: 'inside.txt', old_string: 'a', new_string: 'b' });
  const p2 = (f.service.listPendingPermissions(t2.id) as any).permissions.at(-1)!;
  assert.match(p2.reason, /scope\.fileWrite=false/);
  f.service.respondPermission(p2.permissionId, 'deny');
  assert.equal((await r2).behavior, 'deny');
});

test('policyCheck：Bash 按任务范围联动，网络与未知工具逐条请求', async () => {
  const t = f.task({ scope: { fileWrite: false, bash: 'readonly', network: false } });
  const s = f.service.getSession(t.id)!;
  assert.equal((await policy(s, 'Bash', { command: '/usr/bin/shasum -a 256 -- README.md' })).behavior, 'allow');
  const slow = policy(s, 'Bash', { command: 'npm test' });
  const p = (f.service.listPendingPermissions(t.id) as any).permissions.at(-1)!;
  assert.match(p.reason, /自由形式 Bash/);
  f.service.respondPermission(p.permissionId, 'deny');
  assert.equal((await slow).behavior, 'deny');

  const t2 = f.task({ scope: { fileWrite: false, bash: 'none', network: false } });
  const s2 = f.service.getSession(t2.id)!;
  const r = policy(s2, 'Bash', { command: '/bin/cat -- README.md' });
  const p2 = (f.service.listPendingPermissions(t2.id) as any).permissions.at(-1)!;
  assert.match(p2.reason, /未授予 Bash/);
  f.service.respondPermission(p2.permissionId, 'allow');
  assert.equal((await r).behavior, 'allow');

  const t3 = f.task({ scope: { fileWrite: false, bash: 'none', network: true } });
  const s3 = f.service.getSession(t3.id)!;
  assert.equal((await policy(s3, 'WebFetch', { url: 'https://example.com' })).behavior, 'allow');
  const r4 = policy(s3, 'UnknownTool', { anything: 1 });
  const p4 = (f.service.listPendingPermissions(t3.id) as any).permissions.at(-1)!;
  assert.ok(p4.reason.length > 0, '未知工具必须给出请求确认的理由');
  f.service.respondPermission(p4.permissionId, 'deny');
  assert.equal((await r4).behavior, 'deny');
});

test('真实 Docker 隔离检查：构建和测试自动执行、结果持久化、越界命令待授权',
  { skip: process.platform === 'win32' || process.env.WORKBENCH_TEST_DOCKER !== '1' }, async () => {
    const image = 'sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31';
    const commands = ['python -m compileall -q .', 'python -m unittest discover -v',
      'python -c "import os,socket; print(os.getenv(\'ANTHROPIC_AUTH_TOKEN\',\'HIDDEN\'), os.path.exists(\'.env\'), socket.socket().connect_ex((\'1.1.1.1\',80)))"'];
    fs.writeFileSync(path.join(f.project.rootPath, 'calc.py'), 'def add(a, b): return a + b\n');
    fs.writeFileSync(path.join(f.project.rootPath, 'test_calc.py'),
      'import unittest\nfrom calc import add\nclass CalcTest(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(1, 2), 3)\n');
    fs.writeFileSync(path.join(f.project.rootPath, '.env'), 'PROJECT-SECRET\n');
    const task = f.task({ scope: { fileWrite: false, bash: 'none', network: false, isolatedChecks: { image, commands } } });
    (f.service as any).setStatus(task.id, 'running');
    const built = await f.service.runIsolatedCheck(task.id, commands[0]);
    assert.equal(built.ok, true, JSON.stringify(built));
    const tested = await f.service.runIsolatedCheck(task.id, commands[1]);
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.match(tested.output ?? '', /Ran 1 test/);
    const previousToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = 'HOST-SECRET-SENTINEL';
    try {
      const boundary = await f.service.runIsolatedCheck(task.id, commands[2]);
      assert.equal(boundary.ok, true, JSON.stringify(boundary));
      assert.match(boundary.output ?? '', /HIDDEN False (?:101|113)/);
      assert.doesNotMatch(boundary.output ?? '', /HOST-SECRET-SENTINEL|PROJECT-SECRET/);
    } finally {
      if (previousToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = previousToken;
    }
    const again = await f.service.runIsolatedCheck(task.id, commands[1]);
    assert.equal(again.cached, true);
    assert.equal(f.events(task.id).filter((e) => e.type === 'tool_request' && e.payload.name === 'IsolatedCheck').length, 3);
    assert.equal(f.events(task.id).filter((e) => e.type === 'permission_request').length, 0);
    const outside = f.service.runIsolatedCheck(task.id, 'python -c "print(999)"');
    for (let i = 0; i < 100 && !(f.service.listPendingPermissions(task.id) as any).permissions.length; i++) await f.wait(5);
    const pending = (f.service.listPendingPermissions(task.id) as any).permissions.at(-1);
    assert.ok(pending);
    assert.match(pending.reason, /不在任务已授权/);
    f.service.respondPermission(pending.permissionId, 'deny');
    assert.equal((await outside).ok, false);
  });

test('只改变可执行权限的隔离检查不能复用之前通过的缓存', { skip: process.platform === 'win32' }, async () => {
  const image = `sha256:${'a'.repeat(64)}`;
  const command = './check.sh';
  const script = path.join(f.project.rootPath, 'check.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(script, 0o755);
  const task = f.task({ scope: { isolatedChecks: { image, commands: [command] } } });
  (f.service as any).setStatus(task.id, 'running');
  const snapshot = await makeSnapshot(f.project.rootPath);
  const key = `isolated:${crypto.createHash('sha256').update(image).update('\0').update(command)
    .update('\0').update(snapshot.digest).digest('hex')}`;
  await removeSnapshot(snapshot.directory);
  // Seed a persisted successful result; no container or host credentials are needed.
  f.store.firstRun(task.id, key);
  f.store.completeTool(task.id, key, { ok: true, exitCode: 0, output: 'previous pass' });
  assert.equal((await f.service.runIsolatedCheck(task.id, command)).cached, true);
  fs.chmodSync(script, 0o644);
  const changed = await f.service.runIsolatedCheck(task.id, command);
  assert.notEqual(changed.cached, true, 'chmod must invalidate the persisted pass');
  assert.equal(changed.ok, false, 'the synthetic image cannot run and must not return the old pass');
  assert.equal(f.events(task.id).filter(e => e.type === 'tool_request' && e.payload.name === 'IsolatedCheck').length, 1);
});

test('重启前已启动但结果未知的隔离检查，同一快照不自动重跑', { skip: process.platform === 'win32' }, async () => {
  const image = `sha256:${'a'.repeat(64)}`;
  const command = 'python -m unittest discover -v';
  const task = f.task({ scope: { fileWrite: false, bash: 'none', network: false,
    isolatedChecks: { image, commands: [command] } } });
  (f.service as any).setStatus(task.id, 'running');
  const snapshot = await makeSnapshot(f.project.rootPath);
  const key = `isolated:${crypto.createHash('sha256').update(image).update('\0').update(command)
    .update('\0').update(snapshot.digest).digest('hex')}`;
  await removeSnapshot(snapshot.directory);
  assert.equal(f.store.firstRun(task.id, key).first, true, '模拟运行中崩溃后留下的未决执行记录');
  const result = await f.service.runIsolatedCheck(task.id, command);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /结果未知.*不会自动重复执行/);
  assert.equal(f.events(task.id).filter((e) => e.type === 'tool_request' && e.payload.name === 'IsolatedCheck').length, 0);
});

test('无隔离检查范围时，指定镜像与命令只可经一次人工确认', { skip: process.platform === 'win32' }, async () => {
  const task = f.task({ scope: { fileWrite: false, bash: 'none', network: false } });
  (f.service as any).setStatus(task.id, 'running');
  assert.equal((await f.service.runIsolatedCheck(task.id, 'python -m unittest')).ok, false);
  const requested = f.service.runIsolatedCheck(task.id, 'python -m unittest', `sha256:${'a'.repeat(64)}`);
  for (let i = 0; i < 100 && !(f.service.listPendingPermissions(task.id) as any).permissions.length; i++) await f.wait(5);
  const pending = (f.service.listPendingPermissions(task.id) as any).permissions.at(-1);
  assert.ok(pending);
  assert.equal(pending.toolName, 'IsolatedCheck');
  assert.match(pending.reason, /不在任务已授权/);
  f.service.respondPermission(pending.permissionId, 'deny');
  assert.equal((await requested).ok, false);
  assert.equal(f.events(task.id).filter((e) => e.type === 'tool_request' && e.payload.name === 'IsolatedCheck').length, 0);
});

test('一次批准后的同快照隔离检查重试复用结果，不再请求批准', { skip: process.platform === 'win32' }, async () => {
  const task = f.task({ scope: { fileWrite: false, bash: 'none', network: false } });
  (f.service as any).setStatus(task.id, 'running');
  const image = `sha256:${'a'.repeat(64)}`;
  const command = 'python -m unittest';
  const first = f.service.runIsolatedCheck(task.id, command, image);
  for (let i = 0; i < 100 && !(f.service.listPendingPermissions(task.id) as any).permissions.length; i++) await f.wait(5);
  const pending = (f.service.listPendingPermissions(task.id) as any).permissions.at(-1);
  assert.ok(pending);
  f.service.respondPermission(pending.permissionId, 'allow');
  const result = await first;
  assert.equal(result.ok, false, '不存在的本地镜像必须失败，不能下载替代');
  const retry = await f.service.runIsolatedCheck(task.id, command, image);
  assert.equal(retry.cached, true);
  assert.equal(f.events(task.id).filter((e) => e.type === 'permission_request').length, 1);
});

// ---- 逻辑待授权去重：同一原生调用的协议重试 vs 文本相同的新调用 ----
test('同一 toolUseId 的协议重试共用一条待授权与决定；输入变化立即拒绝', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-1', requestId: 'r-1' });
  const p2 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-1', requestId: 'r-2' });
  const p3 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-1', requestId: 'r-3' });
  await f.wait(10);
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 1, '三次重试只有一条待授权');
  const requestEvents = f.events(t.id).filter((e) => e.type === 'permission_request');
  assert.equal(requestEvents.length, 1, '只落一条 permission_request 事件');
  // 输入变化：同 ID 不同输入 → 立即拒绝且不产生新事件
  const changed = await policy(s, 'Bash', { command: 'npm run evil' }, { toolUseId: 'call-1' });
  assert.equal(changed.behavior, 'deny');
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, 1);
  // 批准一次：全部重试共用该决定
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  f.service.respondPermission(pending.permissionId, 'allow');
  const results = await Promise.all([p1, p2, p3]);
  assert.deepEqual(results.map((r) => r.behavior), ['allow', 'allow', 'allow']);
  // 决定后再重试：重放决定，不产生新待授权/新事件
  const replay = await policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-1' });
  assert.equal(replay.behavior, 'allow');
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0);
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, 1);
});

test('不同 toolUseId 的相同文本调用各自待授权；一次批准只对一次执行有效', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-A' });
  const p2 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-B' });
  await f.wait(10);
  const pendings = (f.service.listPendingPermissions(t.id) as any).permissions;
  assert.equal(pendings.length, 2, '两次独立调用各自待授权');
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, 2);
  f.service.respondPermission(pendings[0].permissionId, 'allow');
  assert.equal((await p1).behavior, 'allow');
  await f.wait(5);
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 1, '批准第一个不影响第二个');
  f.service.respondPermission(pendings[1].permissionId, 'deny');
  assert.equal((await p2).behavior, 'deny');
});

test('拒绝后同调用重试不重复打扰；重复响应明确失败；跨任务响应拒绝', async () => {
  const t = f.task();
  const tOther = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'curl https://x' }, { toolUseId: 'call-9' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  assert.equal(f.service.respondPermission(pending.permissionId, 'deny', tOther.id).ok, false, '任务不匹配拒绝');
  assert.equal(f.service.respondPermission(pending.permissionId, 'deny').ok, true);
  assert.equal((await p1).behavior, 'deny');
  assert.equal(f.service.respondPermission(pending.permissionId, 'allow').ok, false, '重复/相反决定不能再放行');
  // 拒绝后的同调用协议重试：重放拒绝，不新增待授权与事件
  const before = f.events(t.id).filter((e) => e.type === 'permission_request').length;
  const retry = await policy(s, 'Bash', { command: 'curl https://x' }, { toolUseId: 'call-9' });
  assert.equal(retry.behavior, 'deny');
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, before);
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0);
});

test('已决后同调用 ID 输入变化 → 拒绝，不共用旧批准也不重新请求', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-mut' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  f.service.respondPermission(pending.permissionId, 'allow');
  assert.equal((await p1).behavior, 'allow');
  // 同 ID 不同输入（已决阶段）→ 拒绝，且不产生新待授权/事件
  const before = f.events(t.id).filter((e) => e.type === 'permission_request').length;
  const mutated = await policy(s, 'Bash', { command: 'rm -rf /' }, { toolUseId: 'call-mut' });
  assert.equal(mutated.behavior, 'deny');
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, before);
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0);
});

test('跨回合不复用旧批准：新回合开始后同 ID 同输入需重新授权', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'tool-1' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  f.service.respondPermission(pending.permissionId, 'allow');
  assert.equal((await p1).behavior, 'allow');
  // 新回合（send 触发 newTurn；此处直接等价调用）
  (f.service as any).newTurn(t.id);
  // 同 ID 同输入在新回合 → 不再复用旧批准，重新进入待授权
  const p2 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'tool-1' });
  await f.wait(5);
  const pendings = (f.service.listPendingPermissions(t.id) as any).permissions;
  assert.equal(pendings.length, 1, '新回合重新请求授权');
  assert.notEqual(pendings[0].permissionId, pending.permissionId);
  const requestEvents = f.events(t.id).filter((e) => e.type === 'permission_request').length;
  assert.equal(requestEvents, 2, '新回合产生新的 permission_request 事件');
  f.service.respondPermission(pendings[0].permissionId, 'deny');
  assert.equal((await p2).behavior, 'deny');
});

test('执行器重建（runtime 世代更替）后同 ID 不复用旧批准', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'tool-2' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  f.service.respondPermission(pending.permissionId, 'allow');
  assert.equal((await p1).behavior, 'allow');
  (f.service as any).retireRuntime(t.id);   // 空闲回收/重建路径
  const p2 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'tool-2' });
  await f.wait(5);
  const pendings = (f.service.listPendingPermissions(t.id) as any).permissions;
  assert.equal(pendings.length, 1, '重建后同 ID 重新请求授权');
  f.service.respondPermission(pendings[0].permissionId, 'deny');
  assert.equal((await p2).behavior, 'deny');
});

test('请求落盘失败：拒绝执行器并清除待办，存储恢复后可重新请求', async () => {
  const t = f.task();
  f.store.updateSession(t.id, { status: 'running' });
  const s = f.service.getSession(t.id)!;
  const store2 = f.service.store as any;
  const original = store2.appendEvent.bind(store2);
  store2.appendEvent = (...args: any[]) => {
    if (args[1] === 'permission_request') throw new Error('模拟请求写盘失败');
    return original(...args);
  };
  const denied = await policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-request-disk' });
  store2.appendEvent = original;
  assert.equal(denied.behavior, 'deny');
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0);
  assert.equal(f.service.getSession(t.id)?.status, 'running');
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, 0);
  const retry = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-request-disk' });
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  assert.ok(pending);
  f.service.respondPermission(pending.permissionId, 'deny');
  assert.equal((await retry).behavior, 'deny');
});

test('界面广播失败不改变已落盘的授权请求和决定', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  f.service.broadcast = (event) => {
    if (event.type === 'permission_request' || event.type === 'permission_resolved')
      throw new Error('模拟窗口关闭');
  };
  const operation = policy(s, 'Bash', { command: 'npm test' });
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  assert.ok(pending);
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_request').length, 1);
  const response = f.service.respondPermission(pending.permissionId, 'allow');
  assert.equal(response.persisted, true);
  assert.equal((await operation).behavior, 'allow');
  assert.equal(f.events(t.id).filter((e) => e.type === 'permission_resolved').at(-1)?.payload.decision, 'allow');
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0);
});

test('决定落盘失败：执行器回调按拒绝释放，不悬挂、不越权执行', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-disk' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  const store2 = f.service.store as any;
  const original = store2.appendEvent.bind(store2);
  store2.appendEvent = (...args: any[]) => { throw new Error('模拟磁盘故障'); };
  const r = f.service.respondPermission(pending.permissionId, 'allow');
  store2.appendEvent = original;
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false, '落盘失败如实上报');
  const outcome = await p1;
  assert.equal(outcome.behavior, 'deny', '未能落盘的批准不得放行执行器');
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0, '不遗留悬挂待办');
  // 存储恢复后同调用重试 → 重新请求授权（deny 已入缓存）
  const retry = await policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'call-disk' });
  assert.equal(retry.behavior, 'deny');
});

test('决定先落盘再返回执行器（事件顺序可解释）', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  let sawResolved = false;
  const off = f.store.subscribeEvents((e) => { if (e.type === 'permission_resolved') sawResolved = true; });
  const p = policy(s, 'Bash', { command: 'npm run build' }, { toolUseId: 'call-ord' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  f.service.respondPermission(pending.permissionId, 'allow');
  await p;
  off();
  assert.equal(sawResolved, true, 'permission_resolved 事件在执行器拿到决定之前已落盘广播');
});

// ---- 状态衔接：多待办、取消、执行器退出、重启失效 ----
test('多项待办保持 waiting_permission，全部结清后恢复 running；每条新待办只提醒一次', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  void policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'c1' });
  await f.wait(5);
  void policy(s, 'Bash', { command: 'npm run lint' }, { toolUseId: 'c2' });
  await f.wait(5);
  assert.equal(f.service.getSession(t.id)!.status, 'waiting_permission');
  assert.equal(f.notifications.length, 2, '每条新逻辑待办提醒一次');
  assert.equal(f.notifications[1].toolName, 'Bash');
  const pendings = (f.service.listPendingPermissions(t.id) as any).permissions;
  f.service.respondPermission(pendings[0].permissionId, 'allow');
  assert.equal(f.service.getSession(t.id)!.status, 'waiting_permission', '仍有待办时保持等待授权');
  f.service.respondPermission(pendings[1].permissionId, 'allow');
  assert.equal(f.service.getSession(t.id)!.status, 'running', '全部结清后恢复运行');
});

test('取消结清全部待办：旧 permissionId 不能再放行', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'cx' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  f.service.cancel(t.id);
  assert.equal((await p1).behavior, 'deny');
  assert.equal(f.service.respondPermission(pending.permissionId, 'allow').ok, false, '取消后旧授权 ID 不能放行');
  assert.equal(f.service.getSession(t.id)!.status, 'stopped');
  const resolved = f.events(t.id).filter((e) => e.type === 'permission_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].payload.decision, 'deny');
  // 取消后同调用重试重放拒绝，不新增待办
  const retry = await policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'cx' });
  assert.equal(retry.behavior, 'deny');
});

test('执行器授权回调：同步启动正常，取消关闭中及重建后的旧回调不得执行或新增待办', async () => {
  const starts: any[] = [];
  const synchronousReads: Promise<any>[] = [];
  const prompts: string[] = [];
  let finishInterrupt!: () => void;
  const interrupted = new Promise<void>((resolve) => { finishInterrupt = resolve; });
  (f.service as any).adapterFor = () => ({
    start(opts: any) {
      starts.push(opts);
      synchronousReads.push(opts.canUseTool('Read', { file_path: 'README.md' }));
      return { send: async (text: string) => { prompts.push(text); },
        interrupt: () => interrupted, close: async () => {}, nativeSessionId: () => 'controlled-session' };
    },
  });
  const task = f.task();
  assert.equal((await f.service.send(task.id, 'first turn')).ok, true);
  assert.equal((await synchronousReads[0]).behavior, 'allow', 'adapter.start 同步请求时任务已运行');
  assert.match(prompts[0], /对应文件工具可用时，读取优先用 Read\/Grep\/Glob\/LS/);
  const old = starts[0].canUseTool;
  f.service.cancel(task.id);
  for (const [toolName, input] of [['Read', { file_path: 'README.md' }], ['Bash', { command: 'npm test' }]] as const)
    assert.equal((await old(toolName, input, { toolUseId: 'late-while-closing' })).behavior, 'deny');
  assert.equal(f.service.getSession(task.id)!.status, 'stopped');
  assert.equal((f.service.listPendingPermissions(task.id) as any).permissions.length, 0);
  finishInterrupt();
  await f.wait(5);
  assert.equal((await f.service.send(task.id, 'resume same task')).ok, true);
  assert.equal(starts.length, 2);
  assert.equal((await synchronousReads[1]).behavior, 'allow', '同 taskId 停止后正常恢复');
  assert.equal((await old('Read', { file_path: 'README.md' })).behavior, 'deny');
  assert.equal((await old('Bash', { command: 'npm test' }, { toolUseId: 'late-after-rebuild' })).behavior, 'deny');
  assert.equal(f.service.getSession(task.id)!.status, 'running');
  assert.equal((f.service.listPendingPermissions(task.id) as any).permissions.length, 0);
  assert.equal(f.events(task.id).filter((event) => event.type === 'permission_request').length, 0);
});

test('执行器异常退出结清待办，不产生幽灵授权', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  const p1 = policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'cz' });
  await f.wait(5);
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 1);
  (f.service as any).onAdapterEnd(t.id, 'error', '会话异常退出');
  assert.equal((await p1).behavior, 'deny');
  assert.equal((f.service.listPendingPermissions(t.id) as any).permissions.length, 0);
  const resolved = f.events(t.id).filter((e) => e.type === 'permission_resolved').at(-1)!;
  assert.match(resolved.payload.reason, /执行器已退出/);
});

test('重启恢复：已消失回调显式失效，旧 ID 不可批准，任务标记为待恢复', async () => {
  const t = f.task();
  const s = f.service.getSession(t.id)!;
  void policy(s, 'Bash', { command: 'npm test' }, { toolUseId: 'crash-1' });
  await f.wait(5);
  const pending = (f.service.listPendingPermissions(t.id) as any).permissions[0];
  // 模拟崩溃：直接关闭存储，不经过 shutdown 的结清流程
  f.store.close();
  // 重启：同一数据目录重新打开
  const store2 = new Store(f.dbPath);
  const cm2 = new CredentialManager(ccDb, { ttlMs: 0 });
  const service2 = new TaskService(store2, cm2);
  try {
    const resumed = service2.restoreOnStartup();
    assert.ok(resumed.includes(t.id), '进行中任务标记为恢复');
    assert.equal(service2.getSession(t.id)!.status, 'resuming');
    const resolved = service2.listEvents(t.id).filter((e) => e.type === 'permission_resolved').at(-1)!;
    assert.equal(resolved.payload.decision, 'invalidated', '未决授权显式失效');
    assert.match(resolved.payload.reason, /重启|消失/);
    assert.equal((service2 as any).pendingPermissions.size, 0, '没有幽灵待办');
    assert.equal(service2.respondPermission(pending.permissionId, 'allow').ok, false, '重启后旧 permissionId 不能再放行');
  } finally { service2.shutdown(); store2.close(); }
});

// ---- 控制通道入口 ----
function controlRpc(port: number, token: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/rpc', agent: false,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('控制通道创建任务：完整范围传入校验、来源 control、幂等指纹含完整范围', async () => {
  const controlFile = path.join(tmp, 'control.json');
  const control = new ControlServer(f.service);
  const info = await control.start(controlFile);
  const base = { projectId: f.project.id, providerId: PROV_A, model: 'model-a' };
  try {
    const created = await controlRpc(info.port, info.token, 'task.create', {
      ...base, title: '控制通道范围', prompt: 'hi',
      scope: { fileWrite: true, bash: 'readonly', network: true }, clientRequestId: 'ctl-1',
    });
    assert.equal(created.ok, true, `创建失败: ${created.error ?? ''}`);
    assert.deepEqual(JSON.parse(created.task.scopeJson), { fileWrite: true, bash: 'readonly', network: true });
    assert.equal(created.task.scopeSource, 'control');
    const again = await controlRpc(info.port, info.token, 'task.create', {
      ...base, title: '控制通道范围', prompt: 'hi',
      scope: { fileWrite: true, bash: 'readonly', network: true }, clientRequestId: 'ctl-1',
    });
    assert.equal(again.task.id, created.task.id, '同请求 ID + 同范围幂等');
    const conflict = await controlRpc(info.port, info.token, 'task.create', {
      ...base, title: '控制通道范围', prompt: 'hi',
      scope: { fileWrite: true, bash: 'none', network: true }, clientRequestId: 'ctl-1',
    });
    assert.equal(conflict.ok, false, '同请求 ID 不同范围必须报错');
    assert.match(conflict.error, /参数不一致/);
    const invalid = await controlRpc(info.port, info.token, 'task.create', {
      ...base, title: '坏范围', prompt: 'hi', scope: { bash: 'all' },
    });
    assert.equal(invalid.ok, false, '非法范围在控制通道被拒绝');
    const strict = await controlRpc(info.port, info.token, 'task.create', {
      ...base, title: '最严格默认', prompt: 'hi',
    });
    assert.deepEqual(JSON.parse(strict.task.scopeJson), { fileWrite: false, bash: 'none', network: false }, '外部派发默认最严格');
    const external = path.join(f.dir, 'external-skills'); fs.mkdirSync(external);
    const withRoots = await controlRpc(info.port, info.token, 'task.create', {
      ...base, title: '读取指定技能', readRoots: [external],
    });
    assert.deepEqual(JSON.parse(withRoots.task.scopeJson).readRoots, [fs.realpathSync(external)], '顶层简写真实传入');
    assert.equal((await controlRpc(info.port, info.token, 'task.create', {
      ...base, title: '非法外部读取', readRoots: ['relative'],
    })).ok, false);
  } finally { control.stop(); }
});

// ---- 委派：子任务范围派生（mock 父任务：只验证范围派生，不拉起真实执行器）----
test('委派：子任务范围是父任务子集且来源 derived', async () => {
  f.service.registerMockScript('noop', { id: 'noop', steps: [{ t: 'result', text: 'done' }] });
  const mkMock = (scope: any) => f.service.createMainSession({
    projectId: f.project.id, title: 'mock 父任务', agentId: 'mock', mockScript: 'noop', scope,
  });
  const parent = mkMock({ fileWrite: true, bash: 'readonly', network: false });
  const r = await f.service.delegate(parent.id, { title: '子任务', instructions: '只做内部分析' });
  assert.equal(r.ok, true);
  const child = f.service.getSession(r.taskId!)!;
  assert.deepEqual(parseScopeJson(child.scopeJson), { fileWrite: true, bash: 'readonly', network: false });
  assert.equal(child.scopeSource, 'derived');
  // 父任务无写入 → 子任务只读
  const parent2 = mkMock({ fileWrite: false, bash: 'none', network: false });
  const r2 = await f.service.delegate(parent2.id, { title: '只读子任务', instructions: '分析' });
  const child2 = f.service.getSession(r2.taskId!)!;
  assert.equal(parseScopeJson(child2.scopeJson).fileWrite, false);
  await f.wait(50);
  f.service.cancel(parent.id);
  f.service.cancel(r.taskId!);
  f.service.cancel(r2.taskId!);
});
