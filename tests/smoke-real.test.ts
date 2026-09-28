// C 阶段真实模型冒烟（默认跳过；WORKBENCH_SMOKE=1 时运行）
// 使用真实 Claude Code 执行器 + CC Switch 供应商（GLM-5.3-Flash）。
// 凭据仅在主进程内读取并注入子进程环境，本测试不打印任何环境变量。
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';

const RUN = process.env.WORKBENCH_SMOKE === '1';

test('真实 Claude+GLM：流式对话 + 项目内写文件 + 结果', { skip: !RUN }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-smoke-'));
  const store = new Store(path.join(tmp, 'wb.db'));
  const ts = new TaskService(store, new CredentialManager());
  const events: any[] = [];
  ts.broadcast = (e) => events.push(e);

  const projDir = path.join(tmp, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const proj = ts.createProject(projDir);
  const providers = ts.credentials.listProviderInfos();
  assert.ok(providers.length > 0, '存在可用供应商');
  // 统一使用 GLM-5.3-Flash：显式选择智谱供应商（模型 ID 以 glm- 开头）
  const glm = providers.find((p) => p.model.startsWith('glm-')) ?? providers[0];
  const sess = ts.createMainSession({
    projectId: proj.id, title: '真实冒烟', agentId: 'claude-code',
    providerId: glm.providerId, model: glm.model,
    prompt: '请在当前目录创建文件 hello.txt，内容为一行文本 hello-glm。写完后只回复“完成”。',
    scope: { fileWrite: true },
  });

  const deadline = Date.now() + 180_000;
  const respondedDeclined = new Set<string>();
  let responded = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = ts.getSession(sess.id)!.status;
    // 项目内 Write 由策略自动放行；此处对其余授权请求（如 Bash/网络）自动拒绝
    const pending = events.filter((e) => e.type === 'permission_request');
    for (const p of pending) {
      const pid = p.payload.permissionId;
      if (pid && !respondedDeclined.has(pid)) { respondedDeclined.add(pid); responded++; void ts.respondPermission(pid, 'deny'); }
    }
    if (['idle', 'failed', 'stopped', 'interrupted', 'timeout'].includes(st)) break;
  }
  const final = ts.getSession(sess.id)!;
  const evs = ts.listEvents(sess.id);
  const types = new Set(evs.map((e) => e.type));
  assert.ok(types.has('text_delta') || types.has('message'), '有模型回复');
  assert.ok(types.has('usage'), '有用量事件');
  const fileOk = fs.existsSync(path.join(projDir, 'hello.txt'));
  const content = fileOk ? fs.readFileSync(path.join(projDir, 'hello.txt'), 'utf8') : '';
  console.log('状态:', final.status, '| 文件存在:', fileOk, '| 内容包含 hello-glm:', content.includes('hello-glm'));
  console.log('事件类型:', [...types].join(','));
  console.log('摘要:', final.summary?.slice(0, 200));
  assert.equal(final.status, 'idle', '回合完成回到 idle');
  assert.ok(fileOk, '真实写出了 hello.txt');
  assert.ok(content.includes('hello-glm'), '文件内容正确');
  assert.ok(types.has('file_change'), '有文件变更事件');

  // 取消/停止路径在真实模型下的验证：发第二turn并立即停止
  await ts.send(sess.id, '请在目录下创建 never.txt（内容随便）。');
  await new Promise((r) => setTimeout(r, 1500));
  ts.cancel(sess.id, {});
  await new Promise((r) => setTimeout(r, 2500));
  const neverExists = fs.existsSync(path.join(projDir, 'never.txt'));
  console.log('停止后 never.txt 是否存在（存在与否均可能，关键是不再继续）:', neverExists);
  assert.ok(['stopped', 'idle'].includes(ts.getSession(sess.id)!.status), '停止后状态如实');

  ts.shutdown();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
