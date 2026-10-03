import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = process.cwd();
// Load the script at runtime so esbuild never reinterprets its direct-execution guard in a bundled test.
const packager = import(pathToFileURL(path.join(repository, 'scripts/package-platform.mjs')).href);
function write(root: string, relative: string, text = 'fixture', mode?: number) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, text, { mode });
}
function fixture(platform = 'darwin', arch = 'arm64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-package-'));
  write(root, 'package.json', JSON.stringify({ name: 'agent-workbench', productName: 'Agent Workbench', version: '99.8.7',
    main: 'dist/main/main.js', type: 'module', dependencies: { zod: '4', '@anthropic-ai/claude-agent-sdk': 'fixture' }, private: true, scripts: { secret: 'never ship' } }));
  for (const filename of ['dist/main/main.js', 'dist/main/cli.js', 'dist/main/mcp/entry.js', 'skills/agent-workbench/SKILL.md', 'skills/agent-workbench-dispatch/SKILL.md', 'docs/CONTROLLERS.md', 'LICENSE']) write(root, filename);
  write(root, 'bin/agent-workbench.mjs', fs.readFileSync(path.join(repository, 'bin/agent-workbench.mjs'), 'utf8'));
  for (const filename of ['grok-glm.py', 'agent-glm.py', 'dsh_acp.py', 'install.sh', 'install.ps1']) write(root, `scripts/${filename}`, fs.readFileSync(path.join(repository, 'scripts', filename), 'utf8'));
  const native = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  write(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json', JSON.stringify({ optionalDependencies: { [native]: 'fixture' } }));
  write(root, `node_modules/${native}/claude`, 'native SDK fixture');
  write(root, 'node_modules/zod/package.json', '{}');
  write(root, '.env', 'PRIVATE_ROOT_INPUT');
  write(root, 'docs/local.db', 'PRIVATE_DATABASE');
  write(root, 'scripts/unrelated-helper.py', 'PRIVATE_HELPER');
  const runtime = path.join(root, 'runtime');
  if (platform === 'darwin') {
    write(runtime, 'Electron.app/Contents/Info.plist', '<plist><dict><key>CFBundleName</key><string>Electron</string></dict></plist>');
    write(runtime, 'Electron.app/Contents/MacOS/Electron', '#!/bin/sh\nset -eu\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$@" > "$WORKBENCH_TEST_CAPTURE"\nif [ "${WORKBENCH_TEST_HOLD:-0}" = 1 ]; then sleep 30; fi\n', 0o755);
    write(runtime, 'Electron.app/Contents/Resources/default_app.asar');
  } else {
    write(runtime, 'electron.exe');
    write(runtime, 'resources/default_app.asar');
  }
  return { root, runtime };
}

for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
  test(`portable ${platform}-${arch} contains only product inputs and its native SDK`, async () => {
    const f = fixture(platform, arch);
    try {
      const { packagePlatform } = await packager;
      const result = await packagePlatform({ root: f.root, electronDir: f.runtime, platform, arch, archive: false });
      const pkg = JSON.parse(fs.readFileSync(path.join(result.app, 'package.json'), 'utf8'));
      assert.equal(pkg.version, '99.8.7');
      assert.equal(pkg.scripts, undefined);
      assert.equal(fs.existsSync(path.join(result.app, '.env')), false);
      assert.equal(fs.existsSync(path.join(result.app, 'docs/local.db')), false);
      assert.equal(fs.existsSync(path.join(result.app, 'docs/CONTROLLERS.md')), true);
      assert.equal(fs.existsSync(path.join(result.app, 'LICENSE')), true);
      assert.equal(fs.existsSync(path.join(result.app, 'bin/agent-workbench.mjs')), true);
      assert.equal(fs.existsSync(path.join(result.app, 'skills/agent-workbench-dispatch/SKILL.md')), true);
      const dispatch = fs.readFileSync(path.join(result.bundle, 'bin', platform === 'win32' ? 'agent-workbench.cmd' : 'agent-workbench'), 'utf8');
      assert.match(dispatch, /ELECTRON_RUN_AS_NODE=1/);
      assert.match(dispatch, platform === 'win32' ? /bin\\agent-workbench\.mjs/ : /bin\/agent-workbench\.mjs/);
      assert.equal(fs.existsSync(path.join(result.app, 'scripts/unrelated-helper.py')), false);
      assert.equal(fs.existsSync(path.join(result.app, `node_modules/@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude`)), true);
      assert.equal(fs.existsSync(path.join(result.app, 'skills/agent-workbench/SKILL.md')), true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(result.bundle, 'bundle.json'), 'utf8')).arch, arch);
      if (platform === 'win32') {
        const command = fs.readFileSync(path.join(result.bundle, 'bin/workbench.cmd'), 'utf8');
        assert.match(command, /setlocal/);
        assert.match(command, /ELECTRON_RUN_AS_NODE=1/);
        assert.match(command, /\.\.\\app\\resources\\app\\dist\\main\\cli\.js/);
      }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('a runtime database or symlink injected into dist aborts packaging', async () => {
  const f = fixture();
  try {
    const { packagePlatform } = await packager;
    write(f.root, 'dist/local.sqlite', 'PRIVATE_DATABASE');
    await assert.rejects(packagePlatform({ root: f.root, electronDir: f.runtime, platform: 'darwin', arch: 'arm64', archive: false }), /Private\/runtime file/);
    fs.unlinkSync(path.join(f.root, 'dist/local.sqlite'));
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(f.root, '.env'), path.join(f.root, 'dist/outside-link'));
      await assert.rejects(packagePlatform({ root: f.root, electronDir: f.runtime, platform: 'darwin', arch: 'arm64', archive: false }), /must not contain symlinks/);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('macOS framework links survive relocation without the source runtime', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const framework = 'Electron.app/Contents/Frameworks/Electron Framework.framework';
    write(f.runtime, `${framework}/Versions/A/Resources/icudtl.dat`, 'ICU fixture');
    fs.symlinkSync('A', path.join(f.runtime, framework, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/Resources', path.join(f.runtime, framework, 'Resources'));
    const { packagePlatform } = await packager;
    const result = await packagePlatform({ root: f.root, electronDir: f.runtime, platform: 'darwin', arch: 'arm64', archive: false });
    const moved = path.join(f.root, 'relocated');
    fs.renameSync(result.bundle, moved);
    fs.rmSync(f.runtime, { recursive: true });
    const bundled = path.join(moved, 'Agent Workbench.app/Contents/Frameworks/Electron Framework.framework');
    assert.equal(fs.readlinkSync(path.join(bundled, 'Versions/Current')), 'A');
    assert.equal(fs.readlinkSync(path.join(bundled, 'Resources')), 'Versions/Current/Resources');
    assert.equal(fs.readFileSync(path.join(bundled, 'Resources/icudtl.dat'), 'utf8'), 'ICU fixture');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('packaging refuses accidentally reused test artifacts with inline source maps', async () => {
  const f = fixture();
  try {
    const { packagePlatform } = await packager;
    write(f.root, 'dist/main/cli.js', '// compiled test build\n//# sourceMappingURL=data:application/json;base64,e30=\n');
    await assert.rejects(packagePlatform({ root: f.root, electronDir: f.runtime, archive: false }), /run npm run build before packaging/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('macOS local install verifies SHA, handles quoted paths, keeps backups and never auto-imports without TTY', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture('darwin', process.arch);
  try {
    const { packagePlatform } = await packager;
    const result = await packagePlatform({ root: f.root, electronDir: f.runtime, arch: process.arch });
    const expected = createHash('sha256').update(fs.readFileSync(result.zip)).digest('hex');
    assert.equal(fs.readFileSync(result.checksum, 'utf8').split(' ')[0], expected);
    const apps = path.join(f.root, "User's Applications");
    const bin = path.join(f.root, "User's bin");
    const capture = path.join(f.root, 'invocations');
    const env = { ...process.env, WORKBENCH_APPLICATIONS_DIR: apps, WORKBENCH_BIN_DIR: bin, WORKBENCH_TEST_CAPTURE: capture };
    const run = () => spawnSync('sh', [path.join(repository, 'scripts/install.sh'), '--archive', result.zip], { env, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const args = fs.readFileSync(capture, 'utf8').trim().split('\n');
    assert.deepEqual(args, ['1', path.join(apps, 'Agent Workbench.app/Contents/Resources/app/dist/main/cli.js'), 'setup', '--noninteractive']);
    const dispatch = spawnSync(path.join(bin, 'agent-workbench'), ['--help'], { env, encoding: 'utf8' });
    assert.equal(dispatch.status, 0, dispatch.stderr);
    assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), ['1', path.join(apps, 'Agent Workbench.app/Contents/Resources/app/bin/agent-workbench.mjs'), '--help']);
    write(apps, 'Agent Workbench.app/old-only.txt', 'preserve old version');
    const second = run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const oldApp = fs.readdirSync(apps).find(name => name.startsWith('Agent Workbench.app.backup-'))!;
    assert.equal(fs.readFileSync(path.join(apps, oldApp, 'old-only.txt'), 'utf8'), 'preserve old version');
    assert.equal(fs.readdirSync(bin).some(name => name.startsWith('workbench.backup-')), true);
    assert.equal(fs.readdirSync(bin).some(name => name.startsWith('agent-workbench.backup-')), true);
    fs.writeFileSync(result.checksum, '0'.repeat(64) + '  fixture.zip\n');
    const rejected = run();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /SHA-256 verification failed/);
    assert.equal(fs.existsSync(path.join(apps, 'Agent Workbench.app/Contents/MacOS/Electron')), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('macOS installation refuses a running target and leaves it and its tasks alone', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture('darwin', process.arch);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const { packagePlatform } = await packager;
    const result = await packagePlatform({ root: f.root, electronDir: f.runtime, arch: process.arch });
    const apps = path.join(f.root, 'Applications');
    const app = path.join(apps, 'Agent Workbench.app');
    fs.cpSync(path.join(result.bundle, 'Agent Workbench.app'), app, { recursive: true });
    const capture = path.join(f.root, 'running');
    child = spawn(path.join(app, 'Contents/MacOS/Electron'), [], { detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_TEST_CAPTURE: capture, WORKBENCH_TEST_HOLD: '1' } });
    for (let attempt = 0; attempt < 50 && !fs.existsSync(capture); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(capture), true, 'isolated fixture process started');
    const run = spawnSync('sh', [path.join(repository, 'scripts/install.sh'), '--archive', result.zip, '--noninteractive'],
      { encoding: 'utf8', env: { ...process.env, WORKBENCH_APPLICATIONS_DIR: apps, WORKBENCH_BIN_DIR: path.join(f.root, 'bin') } });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /is running/);
    assert.equal(child.exitCode, null);
    assert.equal(fs.readdirSync(apps).length, 1, 'nothing moved or replaced');
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* own fixture already exited */ } }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('Windows install verifies SHA, backs up an idle version and refuses its running process', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture('win32', 'x64');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // Use this test runner's Node binary as the synthetic Electron runtime; never start the actual desktop.
    fs.copyFileSync(process.execPath, path.join(f.runtime, 'electron.exe'));
    write(f.root, 'dist/main/cli.js', 'import fs from "node:fs"; fs.writeFileSync(process.env.WORKBENCH_TEST_CAPTURE, JSON.stringify({env:process.env.ELECTRON_RUN_AS_NODE,args:process.argv.slice(2)})); if(process.env.WORKBENCH_TEST_HOLD==="1") setInterval(()=>{},1000);');
    const { packagePlatform } = await packager;
    const result = await packagePlatform({ root: f.root, electronDir: f.runtime, platform: 'win32', arch: 'x64' });
    const installRoot = path.join(f.root, 'User portable app');
    const capture = path.join(f.root, 'invocations');
    const env = { ...process.env, WORKBENCH_TEST_CAPTURE: capture };
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(repository, 'scripts/install.ps1'), '-Archive', result.zip, '-InstallRoot', installRoot, '-NoPath'], { env, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { env: '1', args: ['setup', '--noninteractive'] });
    write(installRoot, 'app/old-only.txt', 'preserve idle version');
    const second = run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const backup = fs.readdirSync(installRoot).find(name => name.startsWith('app.backup-'))!;
    assert.equal(fs.readFileSync(path.join(installRoot, backup, 'old-only.txt'), 'utf8'), 'preserve idle version');
    const binary = path.join(installRoot, 'app/electron.exe');
    child = spawn(binary, [path.join(installRoot, 'app/resources/app/dist/main/cli.js')],
      { env: { ...env, WORKBENCH_TEST_HOLD: '1' }, stdio: 'ignore' });
    assert.ok(child.pid, 'the isolated runtime started with a retained PID');
    let observed: { ProcessId: number; ExecutablePath: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe: SpawnSyncReturns<string> = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${child.pid}" | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress`],
        { encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stdout + probe.stderr);
      if (probe.stdout.trim()) observed = JSON.parse(probe.stdout.trim());
      if (observed?.ExecutablePath) break;
      assert.equal(child.exitCode, null, 'the isolated runtime remains alive while observing its PID');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log('WINDOWS_INSTALL_PROCESS', JSON.stringify({ requestedPath: binary, canonicalPath: fs.realpathSync.native(binary), observed }));
    assert.equal(observed?.ProcessId, child.pid, 'CIM must observe the isolated runtime before checking installation');
    assert.ok(observed?.ExecutablePath, 'CIM must expose the isolated runtime executable path');
    assert.equal(child.exitCode, null);
    const blocked = run();
    assert.notEqual(blocked.status, 0, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /is running/);
    assert.equal(child.exitCode, null, 'installation never terminates the old process');
    fs.writeFileSync(result.checksum, '0'.repeat(64) + '  fixture.zip\n');
    const badHash = run();
    assert.notEqual(badHash.status, 0);
    assert.match(badHash.stderr, /SHA-256 verification failed/);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child!.once('exit', resolve));
    }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('macOS private releases use authenticated gh with exact asset patterns and no curl', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture('darwin', process.arch);
  try {
    const { packagePlatform } = await packager;
    const result = await packagePlatform({ root: f.root, electronDir: f.runtime, arch: process.arch });
    const tools = path.join(f.root, 'tools');
    write(tools, 'gh', '#!/bin/sh\nset -eu\nprintf "%s\\n" "$*" >> "$WORKBENCH_TEST_GH_LOG"\ncase "$1 $2" in\n"auth status") exit 0;;\n"release view") printf "v99.8.7\\n";;\n"release download")\n shift 2; target=; while [ "$#" -gt 0 ]; do if [ "$1" = --dir ]; then target=$2; shift 2; else shift; fi; done\n cp "$WORKBENCH_TEST_ARCHIVE" "$target/$(basename "$WORKBENCH_TEST_ARCHIVE")"\n cp "$WORKBENCH_TEST_ARCHIVE.sha256" "$target/$(basename "$WORKBENCH_TEST_ARCHIVE").sha256";;\n*) exit 23;;\nesac\n', 0o755);
    write(tools, 'curl', '#!/bin/sh\necho "CURL_MUST_NOT_BE_USED" >&2\nexit 99\n', 0o755);
    const log = path.join(f.root, 'gh.log');
    const run = spawnSync('sh', [path.join(repository, 'scripts/install.sh'), '--noninteractive'], { encoding: 'utf8', env: {
      ...process.env, PATH: tools + ':' + process.env.PATH, WORKBENCH_RELEASE_REPO: 'fixture/private-repo',
      WORKBENCH_APPLICATIONS_DIR: path.join(f.root, 'Applications'), WORKBENCH_BIN_DIR: path.join(f.root, 'bin'),
      WORKBENCH_TEST_CAPTURE: path.join(f.root, 'invocations'), WORKBENCH_TEST_ARCHIVE: result.zip, WORKBENCH_TEST_GH_LOG: log,
    } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /release view --repo fixture\/private-repo --json tagName --jq \.tagName/);
    assert.ok(calls.includes(`release download v99.8.7 --repo fixture/private-repo --pattern ${path.basename(result.zip)} --pattern ${path.basename(result.zip)}.sha256 --dir `));
    assert.equal(run.stderr.includes('CURL_MUST_NOT_BE_USED'), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('release installers default only to the maintained public open repository', () => {
  for (const file of ['install.sh', 'install.ps1']) {
    const installer = fs.readFileSync(path.join(repository, 'scripts', file), 'utf8');
    assert.ok(installer.includes('Nie0008/agent-workbench-open'));
    assert.equal(/Nie0008\/agent-workbench(?!-open)/.test(installer), false);
  }
});
