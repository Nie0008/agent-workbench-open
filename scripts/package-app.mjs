// 手工打包 .app（本地开发交付，未签名未公证）
// 结构：复制 Electron.app → Agent Workbench.app，注入应用代码与运行时依赖
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const src = path.join(root, 'node_modules/electron/dist/Electron.app');
const outApp = path.join(root, 'release', 'Agent Workbench.app');

fs.rmSync(path.join(root, 'release'), { recursive: true, force: true });
fs.mkdirSync(path.dirname(outApp), { recursive: true });
execFileSync('cp', ['-R', fs.realpathSync(src), outApp]);

// 注入应用
const resourcesDir = path.join(outApp, 'Contents', 'Resources');
const appDir = path.join(resourcesDir, 'app');
fs.mkdirSync(appDir, { recursive: true });
const copy = (p) => execFileSync('cp', ['-R', path.join(root, p), appDir]);
copy('package.json');
copy('dist');
copy('bin');
const cliLauncher = path.join(outApp, 'Contents', 'MacOS', 'agent-workbench');
fs.writeFileSync(cliLauncher, '#!/bin/sh\nexec node "$(dirname "$0")/../Resources/app/bin/agent-workbench.mjs" "$@"\n', { mode: 0o755 });
fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
for (const file of ['grok-glm.py', 'agent-glm.py', 'dsh_acp.py']) {
  fs.copyFileSync(path.join(root, 'scripts', file), path.join(appDir, 'scripts', file));
}
for (const dep of ['@anthropic-ai/claude-agent-sdk', 'zod']) {
  fs.mkdirSync(path.join(appDir, 'node_modules', path.dirname(dep)), { recursive: true });
  execFileSync('cp', ['-R', path.join(root, 'node_modules', dep), path.join(appDir, 'node_modules', path.dirname(dep))]);
}

// Info.plist 元数据
const plist = path.join(outApp, 'Contents', 'Info.plist');
const pb = (cmd) => { try { execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist]); } catch { /* 已存在等场景忽略 */ } };
pb('Set :CFBundleName Agent Workbench');
pb('Add :CFBundleDisplayName string Agent Workbench');
pb('Set :CFBundleDisplayName Agent Workbench');
pb('Set :CFBundleIdentifier io.github.nie0008.agent-workbench');
pb(`Set :CFBundleShortVersionString ${appVersion}`);
pb(`Set :CFBundleVersion ${appVersion}`);
// 防止 App Nap 在后台启动时挂起主进程（否则定时器/socket 停摆）
pb('Add :NSAppSleepDisabled bool true');

// 去掉隔离属性
execFileSync('xattr', ['-rc', outApp]);

// --stage-only 只生成 release，供正在运行的工作台安全验收；正式安装另行执行。
const stageOnly = process.argv.includes('--stage-only');
// 安装到 ~/Applications（正式运行位置）。
// 重要：不要从 ~/Documents 等受 macOS TCC 保护的位置运行本应用——
// 双击启动时其子进程（claude）访问资源会被隐私授权静默阻塞（详见《测试与验收报告》已知问题）。
const homeApps = path.join(process.env.HOME ?? '', 'Applications');
if (!stageOnly && fs.existsSync(path.dirname(homeApps))) {
  const dest = path.join(homeApps, 'Agent Workbench.app');
  let installed = false;
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    execFileSync('cp', ['-R', outApp, dest]);
    execFileSync('xattr', ['-rc', dest]);
    installed = true;
    console.log(`已安装: ${dest}（双击运行请用此副本）`);
  } catch (e) {
    console.log(`安装到 ~/Applications 失败: ${String(e.message).slice(0, 120)}（可手动复制）`);
  }
  if (installed) try {
    const binDir = path.join(process.env.HOME ?? '', '.local', 'bin');
    const command = path.join(binDir, 'agent-workbench');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(command, { throwIfNoEntry: false })) {
      fs.symlinkSync(path.join(dest, 'Contents', 'Resources', 'app', 'bin', 'agent-workbench.mjs'), command);
      console.log(`已安装命令: ${command}`);
    } else console.log(`命令位置已占用，未覆盖: ${command}`);
  } catch (e) {
    console.log(`命令安装失败: ${String(e.message).slice(0, 120)}（可手动运行应用内命令）`);
  }
}

const sizeMB = Math.round(execFileSync('du', ['-sm', outApp]).toString().split('\t')[0]);
console.log(`构建完成: ${outApp} (约 ${sizeMB} MB, 未签名未公证)`);
console.log(stageOnly ? '仅生成候选包，未替换正在使用的应用。' : '运行: 双击 ~/Applications/Agent Workbench.app（或 release/启动 Agent Workbench.command）');
console.log('如遇 Gatekeeper 提示，右键 → 打开（不修改系统安全设置）。');
