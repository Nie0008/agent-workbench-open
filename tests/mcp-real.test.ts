// 阶段五：经 stdio MCP 入口驱动真实 Claude+GLM 合成任务（WORKBENCH_MCP_E2E=1 时运行）
// 协议链路真实（entry 子进程 + JSON-RPC），任务执行真实（Claude Code + glm-5.3-flash）。
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child from 'node:child_process';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import { ControlServer } from '../src/main/controlServer';

const ROOT = path.resolve(path.dirname(decodeURI(new URL(import.meta.url).pathname)), '..');
const RUN = process.env.WORKBENCH_MCP_E2E === '1';

let tmp: string;
let store: Store;
let ts: TaskService;
let control: ControlServer;
let childProc: child.ChildProcess | null = null;

function spawnEntry(): child.ChildProcess {
  return child.spawn(process.execPath, [path.join(ROOT, 'dist/main/mcp/entry.js'), '--control', path.join(tmp, 'control.json')], { stdio: ['pipe', 'pipe', 'pipe'] });
}

test('MCP→真实GLM：建任务(带背景)→轮询→读结果→文件落盘', { skip: !RUN }, async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mcp-real-'));
  store = new Store(path.join(tmp, 'wb.db'));
  ts = new TaskService(store, new CredentialManager());
  ts.broadcast = () => {};
  control = new ControlServer(ts);
  await control.start(path.join(tmp, 'control.json'));

  const projDir = path.join(tmp, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const proj = ts.createProject(projDir);
  const providers = ts.credentials.listProviderInfos();
  const glm = providers.find((p) => p.model.startsWith('glm-'))!;

  const rpcProc = spawnEntry();
  childProc = rpcProc;
  const bufHolder = { buf: '', waiters: [] as any[], nextId: 1 };
  rpcProc.stdout!.on('data', (d: any) => {
    bufHolder.buf += d.toString();
    let i: number;
    while ((i = bufHolder.buf.indexOf('\n')) >= 0) {
      const line = bufHolder.buf.slice(0, i).trim();
      bufHolder.buf = bufHolder.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const w = bufHolder.waiters.findIndex((w) => w.match(msg));
        if (w >= 0) bufHolder.waiters.splice(w, 1)[0].resolve(msg);
      } catch { /* ignore */ }
    }
  });
  const send = (method: string, params?: any) => {
    const id = bufHolder.nextId++;
    return new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('MCP 超时: ' + method)), 15000);
      bufHolder.waiters.push({ match: (m: any) => m.id === id, resolve: (m: any) => { clearTimeout(t); resolve(m); } });
      rpcProc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const call = async (name: string, args: any) => {
    const r = await send('tools/call', { name, arguments: args });
    return JSON.parse(r.result.content[0].text);
  };

  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  rpcProc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const created = await call('workbench_create_task', {
    projectId: proj.id, title: 'MCP真实任务',
    prompt: '【项目背景】这是一个合成测试项目。\n【要求】在当前目录创建文件 mcp-real.txt，内容为一行 mcp-real-ok。完成后只回复“完成”。',
    providerId: glm.providerId,
  });
  assert.ok(created.task?.id, '真实任务已由 MCP 创建');
  const taskId = created.task.id;

  const deadline = Date.now() + 240_000;
  let finalStatus = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const got = await call('workbench_get_task', { taskId });
    finalStatus = got.task.status;
    if (['idle', 'failed', 'stopped', 'interrupted', 'timeout'].includes(finalStatus)) break;
  }
  const res = await call('workbench_read_task_result', { taskId });
  const fileOk = fs.existsSync(path.join(projDir, 'mcp-real.txt'));
  const content = fileOk ? fs.readFileSync(path.join(projDir, 'mcp-real.txt'), 'utf8') : '';
  console.log('最终状态:', finalStatus, '| 文件:', fileOk, '| 内容正确:', content.includes('mcp-real-ok'), '| 摘要:', (res.result?.summary ?? '').slice(0, 120));

  assert.equal(finalStatus, 'idle', '回合完成');
  assert.ok(fileOk, '真实模型经 MCP 创建了文件');
  assert.ok(content.includes('mcp-real-ok'), '文件内容正确');

  rpcProc.kill('SIGKILL');
  control.stop();
  ts.shutdown();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
