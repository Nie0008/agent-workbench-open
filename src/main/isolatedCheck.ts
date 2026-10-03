// 已获任务范围授权的构建/测试：只在无网络、无宿主凭据的容器副本中运行。
import * as crypto from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const DOCKER = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT = 128 * 1024;
const SKIP_DIRS = new Set(['.git', '.workbench', 'node_modules', 'dist', 'dist-test']);
const SENSITIVE_FILE = /(?:^|[._-])(?:credentials?|secrets?|passwords?|tokens?)(?:[._-]|$)|\.(?:pem|key|p12|pfx)$/i;

export function isolatedCheckUnavailableReason(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return 'Windows 暂不支持隔离构建/测试；检查未运行，请使用支持的系统运行该检查';
  return undefined;
}

function dockerPath(): string {
  const found = DOCKER.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('未找到本机 Docker CLI；隔离检查未运行');
  return found;
}

function dockerEnv(): NodeJS.ProcessEnv {
  return { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: '/tmp' };
}

async function docker(args: string[], signal?: AbortSignal, maxOutput = MAX_OUTPUT): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawn(dockerPath(), args, { env: dockerEnv(), signal, timeout: 180_000 });
    const append = (data: Buffer) => {
      output += data.toString();
      if (output.length > maxOutput) child.kill();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code, sig) => {
      if (settled) return;
      settled = true;
      if (output.length > maxOutput) reject(new Error('隔离检查输出超过 128 KiB，已终止'));
      else if (sig) reject(new Error(`隔离检查进程被终止（${sig}）`));
      else resolve({ code: code ?? 1, output });
    });
  });
}

export async function makeSnapshot(root: string): Promise<{ directory: string; digest: string; files: number }> {
  const rootReal = await fs.realpath(root);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-isolated-'));
  const workspace = path.join(directory, 'workspace');
  // Version the serialization so old content-only cache entries cannot be reused.
  const hash = crypto.createHash('sha256').update('wb-snapshot-v2\0');
  let files = 0;
  let bytes = 0;
  try {
    await fs.mkdir(workspace);
    async function copy(src: string, dst: string, relative: string): Promise<void> {
      const real = await fs.realpath(src);
      const rel = path.relative(rootReal, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('项目目录在快照期间指向了范围外');
      const entries = await fs.readdir(src, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || SENSITIVE_FILE.test(entry.name)
          || entry.isSymbolicLink()) continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const from = path.join(src, entry.name);
        const to = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          await fs.mkdir(to);
          // Empty directories and their effective copied modes affect command behavior too.
          const mode = (await fs.stat(to)).mode & 0o777;
          hash.update(JSON.stringify(['directory', name, mode])).update('\0');
          await copy(from, to, name);
        } else if (entry.isFile()) {
          const handle = await fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error('项目快照只接受普通文件');
            files++; bytes += stat.size;
            if (files > MAX_FILES || bytes > MAX_BYTES || stat.size > 64 * 1024 * 1024)
              throw new Error('项目快照超出隔离检查上限（1 万文件 / 256 MiB / 单文件 64 MiB）');
            const contents = await handle.readFile();
            const mode = stat.mode & 0o777;
            await fs.writeFile(to, contents, { mode });
            // Creation mode is filtered by umask; explicitly preserve what the digest describes.
            await fs.chmod(to, mode);
            hash.update(JSON.stringify(['file', name, mode, contents.length])).update('\0').update(contents).update('\0');
          } finally { await handle.close(); }
        }
      }
    }
    await copy(root, workspace, '');
    return { directory, digest: hash.digest('hex'), files };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function runIsolatedContainer(image: string, command: string, directory: string,
    name: string, signal: AbortSignal): Promise<{ exitCode: number; output: string }> {
  const unavailable = isolatedCheckUnavailableReason();
  if (unavailable) throw new Error(unavailable);
  const inspected = await docker(['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', '--format', '{{.Id}}', image], signal, 4096);
  if (inspected.code !== 0 || inspected.output.trim() !== image) throw new Error('授权镜像 ID 未在本机找到；不会联网拉取或替换镜像');
  const work = await fs.realpath(path.join(directory, 'workspace'));
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : '65534';
  const group = typeof process.getgid === 'function' ? String(process.getgid()) : '65534';
  const args = ['--host', 'unix:///var/run/docker.sock', 'run', '--rm', '--pull', 'never', '--name', name,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '768m', '--cpus', '2', '--user', `${user}:${group}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--env', 'HOME=/tmp',
    '--tmpfs', '/work:rw,nosuid,nodev,size=384m,mode=1777', '--env', `WB_COMMAND=${command}`,
    '--mount', `type=bind,source=${work},target=/source,readonly`, '--workdir', '/work', image,
    '/bin/sh', '-lc', 'cp -R /source/. /work/ && exec /bin/sh -lc "$WB_COMMAND"'];
  try {
    const result = await docker(args, signal);
    return { exitCode: result.code, output: result.output };
  } finally {
    await stopIsolatedContainer(name);
  }
}

export async function stopIsolatedContainer(name: string): Promise<void> {
  if (isolatedCheckUnavailableReason()) return;
  if (!/^wb-check-[a-f0-9-]{36}-[a-f0-9]{16}$/.test(name)) return;
  try { await docker(['--host', 'unix:///var/run/docker.sock', 'rm', '-f', name], undefined, 4096); }
  catch { /* 进程/容器已退出，清理无需中断任务 */ }
}

export async function removeSnapshot(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && /^wb-isolated-[a-zA-Z0-9]+$/.test(path.basename(resolved)))
    await fs.rm(resolved, { recursive: true, force: true });
}
