// D 阶段真实委派闭环（默认跳过；WORKBENCH_DELEGATE=1 时运行）
// 主 Agent（Claude Code + GLM-5.3-Flash）自主调用 workbench MCP 委派工具，
// 子任务在 git worktree 中执行审查，完成后主 Agent 读取结果并汇总。
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import { createWorkbenchMcpServer } from '../src/main/mcp/agentTools';

const RUN = process.env.WORKBENCH_DELEGATE === '1';

test('真实委派闭环：主Agent委派审查子任务并汇总', { skip: !RUN }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-delegate-'));
  const store = new Store(path.join(tmp, 'wb.db'));
  const ts = new TaskService(store, new CredentialManager());
  ts.broadcast = () => {};
  ts.mcpServerFactory = (id: string) => createWorkbenchMcpServer(ts, id);
  ts.setSettings({ taskTimeoutSec: 300, maxConcurrentSubtasks: 2, maxDelegationsPerTask: 5 });

  const projDir = path.join(tmp, 'counter-page');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# 计数页面\n纯静态实现。\n');
  execFileSync('git', ['init', '-q'], { cwd: projDir });
  execFileSync('git', ['add', '.'], { cwd: projDir });
  execFileSync('git', ['-c', 'user.email=w@w', '-c', 'user.name=w', 'commit', '-qm', 'init'], { cwd: projDir });
  const proj = ts.createProject(projDir);
  assert.ok(proj.isGit);

  const providers = ts.credentials.listProviderInfos();
  const glm = providers.find((p) => p.model.startsWith('glm-'))!;
  const sess = ts.createMainSession({
    projectId: proj.id, title: '计数页面+审查', agentId: 'claude-code',
    providerId: glm.providerId, model: glm.model, scope: { fileWrite: true },
    prompt: [
      '任务：在当前目录实现一个计数页面 index.html（纯 HTML+JS：数字显示、+1 和 -1 两个按钮、无依赖）。',
      '完成后，你必须使用 delegate_task 工具委派一个「代码审查」子任务核对实现：context_files 必须包含 index.html，要求与验收标准写清楚（功能完整、无语法错误、无外部依赖）。',
      '收到子任务完成通知后，用 read_task_result 读取其结果；若审查发现问题请修复，最后用中文汇总：实现内容、审查结论、最终状态。不要使用 append_task_message 以外的追加方式重复发送文件内容。',
    ].join('\n'),
  });

  const t0 = Date.now();
  const deadline = Date.now() + 420_000;
  let delegated = false;
  const declined = new Set<string>();
  const respondPending = () => {
    // 无头环境：对所有待授权请求自动拒绝（子任务应改用只读工具；主任务项目内写已自动放行）
    const all = [sess.id, ...ts.listSubtasks(sess.id).map((s) => s.id)];
    for (const id of all) {
      for (const e of ts.listEvents(id)) {
        if (e.type === 'permission_request' && !declined.has(e.payload.permissionId)) {
          declined.add(e.payload.permissionId);
          void ts.respondPermission(e.payload.permissionId, 'deny');
        }
      }
    }
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    respondPending();
    const st = ts.getSession(sess.id)!.status;
    const subs = ts.listSubtasks(sess.id);
    if (subs.length > 0) delegated = true;
    // 打印进度（非敏感）
    if (subs.length > 0) {
      const s = subs[0];
      if (process.env.WORKBENCH_DEBUG) console.log(`[progress] main=${st} sub=${s.title}:${s.status}`);
    }
    if (delegated && ['idle', 'failed', 'stopped', 'interrupted', 'timeout'].includes(st) && subs.every((s) => ['completed', 'failed', 'stopped', 'canceled'].includes(s.status))) {
      // 主回合结束且子任务终态
      const lastResult = ts.listEvents(sess.id).filter((e) => e.type === 'result').slice(-1)[0];
      if (lastResult) break;
    }
    // 主任务直接失败/中断（未委派）时快速退出，避免空等
    if (!delegated && ['failed', 'interrupted', 'stopped'].includes(st) && Date.now() - t0 > 30000) break;
  }

  const mainRow = ts.getSession(sess.id)!;
  const subs = ts.listSubtasks(sess.id);
  const mainEvents = ts.listEvents(sess.id);
  console.log('== 耗时(s):', Math.round((Date.now() - t0) / 1000));
  console.log('== 全部事件类型:', mainEvents.map((e) => e.type).join(','));
  for (const e of mainEvents.filter((e) => e.type === 'error' || e.type === 'session')) {
    console.log('   [ev]', e.type, JSON.stringify(e.payload).slice(0, 300));
  }
  console.log('== 主任务状态:', mainRow.status, '| 摘要:', mainRow.summary?.slice(0, 240));
  console.log('== 子任务数:', subs.length);
  for (const s of subs) {
    console.log(`   - ${s.title} status=${s.status} cwd不同于主树=${s.cwd !== projDir} 摘要=${(s.summary ?? '').slice(0, 140)}`);
  }
  console.log('== 主会话工具调用:', mainEvents.filter((e) => e.type === 'tool_request').map((e) => e.payload.name).join(','));
  console.log('== 主会话最后回复:', mainEvents.filter((e) => e.type === 'message' && e.payload.role === 'assistant').slice(-1)[0]?.payload.text?.slice(0, 240));

  assert.ok(delegated, '主Agent自主委派了子任务');
  assert.ok(subs.length >= 1, '子任务已创建');
  const sub = subs[0];
  assert.equal(sub.cwd !== projDir, true, '子任务运行在 worktree（与主树隔离）');
  assert.ok(['completed', 'failed'].includes(sub.status), `子任务到达终态（实际 ${sub.status}）`);
  const delegatedEv = mainEvents.some((e) => e.type === 'task_delegated');
  assert.ok(delegatedEv, '主会话记录委派事件');
  // 背景快照机制：子任务委派记录含快照元数据；子任务首条提示词内联文件内容与版本
  const del = JSON.parse(sub.delegationJson ?? '{}');
  assert.ok(del.snapshot, '委派记录包含快照元数据');
  assert.ok(del.snapshot.files?.some((f: any) => f.path === 'index.html'), '快照包含 index.html');
  const subFirst = ts.listEvents(sub.id).find((e) => e.type === 'message' && e.payload.role === 'user');
  assert.ok(subFirst?.payload.text.includes('背景快照'), '子任务提示词含背景快照段');
  const readResultCall = mainEvents.some((e) => e.type === 'tool_request' && e.payload.name === 'mcp__workbench__read_task_result');
  assert.ok(readResultCall, '主Agent调用了 read_task_result 读取子任务结果');
  const finalText = mainEvents.filter((e) => e.type === 'message' && e.payload.role === 'assistant').slice(-1)[0]?.payload.text ?? '';
  assert.ok(finalText.length > 40, '主Agent输出了汇总');

  // worktree 清理验证
  for (const s of subs) ts.cleanupWorktree(s.id);
  ts.shutdown();
  store.close();
  if (mainRow.status === 'idle') fs.rmSync(tmp, { recursive: true, force: true });
  else console.log('== 失败现场保留:', tmp);
});
