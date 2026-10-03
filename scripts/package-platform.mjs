// Native, portable Electron packaging. Run after the production build; never installs or reads user data.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supported = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);
const bridges = ['grok-glm.py', 'agent-glm.py', 'dsh_acp.py'];
const forbidden = /^(?:\.env(?:\..*)?|\.git|\.workbench|control\.json|.*\.(?:db|sqlite)(?:-.*)?|.*\.log|\.DS_Store)$/i;

function checkTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (forbidden.test(entry.name)) throw new Error(`Private/runtime file in package input: ${path.join(directory, entry.name)}`);
    if (entry.isDirectory()) checkTree(path.join(directory, entry.name));
    else if (entry.isSymbolicLink()) throw new Error(`Application input must not contain symlinks: ${path.join(directory, entry.name)}`);
  }
}

function checkProduction(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) checkProduction(filename);
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name) && /^\/\/# sourceMappingURL=data:/m.test(fs.readFileSync(filename, 'utf8'))) {
      throw new Error('Test build contains inline source maps; run npm run build before packaging');
    }
  }
}

export function windowsLauncher(entry = 'dist/main/cli.js') {
  const cliPath = entry.replaceAll('/', '\\');
  return '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\app\\electron.exe" "%~dp0..\\app\\resources\\app\\' + cliPath + '" %*\r\nexit /b %errorlevel%\r\n';
}

function updatePlist(filename, version) {
  let text = fs.readFileSync(filename, 'utf8');
  for (const [key, value] of Object.entries({ CFBundleName: 'Agent Workbench', CFBundleDisplayName: 'Agent Workbench',
    CFBundleIdentifier: 'io.github.nie0008.agent-workbench', CFBundleShortVersionString: version, CFBundleVersion: version })) {
    const pattern = new RegExp(`(<key>${key}</key>\\s*)<string>[^<]*</string>`);
    if (pattern.test(text)) text = text.replace(pattern, `$1<string>${value}</string>`);
    else text = text.replace('</dict>', `<key>${key}</key><string>${value}</string>\n</dict>`);
  }
  if (text.includes('<key>NSAppSleepDisabled</key>')) text = text.replace(/(<key>NSAppSleepDisabled<\/key>\s*)<(?:true|false)\s*\/>/, '$1<true/>');
  else text = text.replace('</dict>', '<key>NSAppSleepDisabled</key><true/>\n</dict>');
  fs.writeFileSync(filename, text);
}

export async function packagePlatform({ root = projectRoot, output = path.join(root, 'release', 'portable'),
  platform = process.platform, arch = process.arch, electronDir = path.join(root, 'node_modules', 'electron', 'dist'), archive = true } = {}) {
  if (!supported.has(`${platform}-${arch}`)) throw new Error(`Unsupported target: ${platform}-${arch}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Invalid package version');
  for (const required of ['dist/main/main.js', 'dist/main/cli.js', 'dist/main/mcp/entry.js', 'skills/agent-workbench/SKILL.md', 'skills/agent-workbench-dispatch/SKILL.md', 'bin/agent-workbench.mjs', 'LICENSE', 'docs/CONTROLLERS.md']) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`Missing build input: ${required}`);
  }
  checkProduction(path.join(root, 'dist'));
  const name = `agent-workbench-${pkg.version}-${platform}-${arch}`;
  const stage = path.join(output, name);
  const bundle = path.join(stage, 'agent-workbench');
  fs.mkdirSync(output, { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(bundle, { recursive: true });
  const desktop = path.join(bundle, platform === 'darwin' ? 'Agent Workbench.app' : 'app');
  const runtimeSource = platform === 'darwin' ? path.join(electronDir, 'Electron.app') : electronDir;
  const binarySource = platform === 'darwin' ? path.join(runtimeSource, 'Contents/MacOS/Electron') : path.join(runtimeSource, 'electron.exe');
  if (!fs.existsSync(binarySource)) throw new Error(`Missing Electron binary for ${platform}: ${binarySource}`);
  fs.cpSync(runtimeSource, desktop, { recursive: true, dereference: false, verbatimSymlinks: true });
  const resources = path.join(desktop, platform === 'darwin' ? 'Contents/Resources' : 'resources');
  const app = path.join(resources, 'app');
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  fs.rmSync(path.join(resources, 'app.asar'), { force: true });
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  const copyInput = (relative, destination = path.join(app, relative)) => {
    const source = path.join(root, relative);
    checkTree(source);
    fs.cpSync(source, destination, { recursive: true, dereference: false });
  };
  copyInput('dist');
  copyInput('skills/agent-workbench');
  copyInput('skills/agent-workbench-dispatch');
  copyInput('bin');
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(app, 'LICENSE'));
  fs.mkdirSync(path.join(app, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(root, 'docs/CONTROLLERS.md'), path.join(app, 'docs/CONTROLLERS.md'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName,
    version: pkg.version, description: pkg.description, main: pkg.main, type: pkg.type,
    dependencies: Object.fromEntries(['@anthropic-ai/claude-agent-sdk', 'zod'].map(name => [name, pkg.dependencies[name]])) }, null, 2) + '\n');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  for (const file of bridges) fs.copyFileSync(path.join(root, 'scripts', file), path.join(app, 'scripts', file));
  const sdk = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  const nativeSdk = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const dependencies = ['@anthropic-ai/claude-agent-sdk', 'zod'];
  if (sdk.optionalDependencies?.[nativeSdk]) dependencies.push(nativeSdk);
  for (const dependency of dependencies) copyInput(`node_modules/${dependency}`);
  if (platform === 'darwin') updatePlist(path.join(desktop, 'Contents/Info.plist'), pkg.version);
  fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
  if (platform === 'darwin') {
    // Resolve the portable app from the wrapper's own location; the installed wrapper uses an absolute app path.
    fs.writeFileSync(path.join(bundle, 'bin/workbench'), '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec env ELECTRON_RUN_AS_NODE=1 "$base/Agent Workbench.app/Contents/MacOS/Electron" "$base/Agent Workbench.app/Contents/Resources/app/dist/main/cli.js" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bundle, 'bin/agent-workbench'), '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec env ELECTRON_RUN_AS_NODE=1 "$base/Agent Workbench.app/Contents/MacOS/Electron" "$base/Agent Workbench.app/Contents/Resources/app/bin/agent-workbench.mjs" "$@"\n', { mode: 0o755 });
  } else {
    fs.writeFileSync(path.join(bundle, 'bin/workbench.cmd'), windowsLauncher());
    fs.writeFileSync(path.join(bundle, 'bin/agent-workbench.cmd'), windowsLauncher('bin/agent-workbench.mjs'));
  }
  for (const installer of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(root, 'scripts', installer), path.join(bundle, installer));
  fs.chmodSync(path.join(bundle, 'install.sh'), 0o755);
  fs.writeFileSync(path.join(bundle, 'bundle.json'), JSON.stringify({ version: pkg.version, platform, arch,
    desktop: platform === 'darwin' ? 'Agent Workbench.app' : 'app', unsigned: true }, null, 2) + '\n');
  if (!archive) return { bundle, name, app };
  const zip = path.join(output, `${name}.zip`);
  fs.rmSync(zip, { force: true });
  if (platform === 'darwin') execFileSync('zip', ['-q', '-r', '-y', zip, 'agent-workbench'], { cwd: stage });
  else execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:AWB_PACKAGE_SOURCE -DestinationPath $env:AWB_PACKAGE_DEST -CompressionLevel Optimal'],
  { env: { ...process.env, AWB_PACKAGE_SOURCE: bundle, AWB_PACKAGE_DEST: zip } });
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(zip)) hash.update(chunk);
  const checksum = `${zip}.sha256`;
  fs.writeFileSync(checksum, `${hash.digest('hex')}  ${path.basename(zip)}\n`);
  return { bundle, name, app, zip, checksum };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
  const platform = flag('--platform', process.platform);
  const arch = flag('--arch', process.arch);
  if (platform !== process.platform || arch !== process.arch) throw new Error('Use a native runner for each target; cross-labeled Electron packages are refused');
  const binary = platform === 'darwin' ? path.join(projectRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(projectRoot, 'node_modules/electron/dist/electron.exe');
  const runtime = JSON.parse(execFileSync(binary, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch})'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
  if (runtime.platform !== platform || runtime.arch !== arch) throw new Error('Installed Electron target does not match the package target');
  const result = await packagePlatform({ platform, arch, output: path.resolve(flag('--out', path.join(projectRoot, 'release/portable'))) });
  console.log(JSON.stringify(result));
}
