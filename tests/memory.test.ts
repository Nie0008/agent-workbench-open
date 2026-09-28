import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import { MockAdapter } from '../src/main/adapters/mock';
import { NightlyMemoryService, dueDay } from '../src/main/nightlyMemory';

let tmp: string;
let store: Store;
let ts: TaskService;

function service(dbPath = path.join(tmp,'workbench.db')) {
  store = new Store(dbPath);
  ts = new TaskService(store,new CredentialManager());
  ts.broadcast = () => {};
  return {store,ts};
}
function project(name='project') {
  const root = path.join(tmp,name);
  fs.mkdirSync(root,{recursive:true});
  return ts.createProject(root,name);
}
function memory(projectId:string, title:string, body:string, extra:Record<string,any>={}) {
  return ts.createMemoryEntry({projectId,kind:'lesson',title,body,source:'docs/guide.md',...extra});
}
function makeTask(projectId:string, id='task-1') {
  store.createSession({id,projectId,kind:'main',parentSessionId:null,title:'Node 包管理器任务',agentId:'mock',model:'glm-5.3-flash',cwd:ts.store.getProject(projectId)!.rootPath,scope:{fileWrite:false}});
  return ts.getSession(id)!;
}
function wait(ms:number) { return new Promise((resolve)=>setTimeout(resolve,ms)); }

beforeEach(()=>{
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-memory-'));
  service();
});
afterEach(()=>{
  void ts.shutdown();
  try { store.close(); } catch {}
  fs.rmSync(tmp,{recursive:true,force:true});
});

test('project memories are isolated, idempotent, versioned, replaceable, and persistent',()=>{
  const a=project('a'), b=project('b');
  const first=memory(a.id,'包管理器规范','项目统一使用 pnpm。',{requestId:'create-1'});
  const replay=memory(a.id,'包管理器规范','项目统一使用 pnpm。',{requestId:'create-1'});
  assert.equal(replay.entry.id,first.entry.id);
  assert.equal(replay.duplicate,true);
  assert.equal(memory(a.id,'包管理器规范','项目统一使用 pnpm。',{requestId:'create-2'}).duplicateContent,true);
  assert.throws(()=>memory(a.id,'包管理器规范','项目统一使用 pnpm。',{requestId:'create-1',source:'different'}),/参数不一致/);
  assert.equal(ts.listMemoryEntries(b.id).length,0);
  assert.throws(()=>ts.getMemoryEntry(b.id,first.entry.id),/不存在/);

  const adopted=ts.setMemoryStatus(a.id,first.entry.id,'adopted',1);
  assert.equal(adopted.version,2);
  assert.throws(()=>ts.setMemoryStatus(a.id,first.entry.id,'inactive',1),/版本冲突/);
  const replacement=ts.replaceMemoryEntry(a.id,first.entry.id,2,{kind:'lesson',title:'新包管理器规范',body:'本项目使用 pnpm 10。',source:'docs/new-guide.md',requestId:'replace-1'});
  assert.equal(replacement.previous.status,'superseded');
  assert.equal(replacement.previous.replacedById,replacement.entry.id);
  assert.equal(replacement.entry.status,'adopted');
  assert.equal(ts.getMemoryHistory(a.id,first.entry.id).length,2);
  assert.throws(()=>memory(b.id,'伪造任务引用','经验',{taskId:'missing-task'}),/任务不存在或不属于此项目/);

  const dbPath=path.join(tmp,'workbench.db');
  void ts.shutdown();store.close();
  service(dbPath);
  assert.equal(ts.getMemoryEntry(a.id,first.entry.id).replacedById,replacement.entry.id);
  const replayReplace=ts.replaceMemoryEntry(a.id,first.entry.id,2,{kind:'lesson',title:'新包管理器规范',body:'本项目使用 pnpm 10。',source:'docs/new-guide.md',requestId:'replace-1'});
  assert.equal(replayReplace.entry.id,replacement.entry.id);
  assert.equal(replayReplace.duplicate,true);
});

test('create and replacement idempotency are stable when caller JSON keys are reordered',()=>{
  const p=project();
  const created=ts.createMemoryEntry({projectId:p.id,kind:'lesson',title:'键序稳定创建',body:'同一请求的字段次序不影响指纹。',source:'docs/idempotency.md',
    taskId:null,evidenceRefs:['event:7','doc:2'],expiresAt:null,requestId:'create-key-order'});
  const replayCreate=ts.createMemoryEntry({requestId:'create-key-order',expiresAt:null,evidenceRefs:['event:7','doc:2'],taskId:null,
    source:'docs/idempotency.md',body:'同一请求的字段次序不影响指纹。',title:'键序稳定创建',kind:'lesson',projectId:p.id});
  assert.equal(replayCreate.entry.id,created.entry.id);
  assert.equal(replayCreate.duplicate,true);

  const firstReplace=ts.replaceMemoryEntry(p.id,created.entry.id,1,{kind:'lesson',title:'键序稳定替代',body:'替代请求字段次序不影响指纹。',
    source:'docs/idempotency.md',taskId:null,evidenceRefs:['event:8'],expiresAt:null,requestId:'replace-key-order'});
  const replayReplace=ts.replaceMemoryEntry(p.id,created.entry.id,1,{requestId:'replace-key-order',expiresAt:null,evidenceRefs:['event:8'],taskId:null,
    source:'docs/idempotency.md',body:'替代请求字段次序不影响指纹。',title:'键序稳定替代',kind:'lesson'});
  assert.equal(replayReplace.entry.id,firstReplace.entry.id);
  assert.equal(replayReplace.duplicate,true);
});

test('an explicit null taskId clears an existing memory association',()=>{
  const p=project();
  const task=makeTask(p.id,'associated-task');
  const item=memory(p.id,'可清除任务关联','此经验最初关联一个任务。',{taskId:task.id});
  const updated=ts.updateMemoryEntry(p.id,item.entry.id,{taskId:null},1);
  assert.equal(updated.taskId,null);
});

test('duplicate detection preserves meaningful operators and command punctuation',()=>{
  const p=project();
  const gte=memory(p.id,'版本约束','运行时版本必须 >= 5。');
  const lte=memory(p.id,'版本约束','运行时版本必须 <= 5。');
  assert.notEqual(gte.entry.id,lte.entry.id);
  assert.equal(ts.listMemoryEntries(p.id).length,2);
});

test('the existing diagnostic leak scan includes persisted memory snapshots',()=>{
  const p=project();
  const sentinel='memory-diagnostic-sentinel-7f21';
  memory(p.id,'诊断扫描条目',`该引用 ${sentinel} 仅用于本地扫描测试。`);
  assert.equal(store.countOccurrences(sentinel),1);
});

test('Chinese and mixed-language retrieval is project scoped and does not force unrelated hits',()=>{
  const a=project('a'), b=project('b');
  const relevant=memory(a.id,'Node 依赖管理','项目包管理器统一使用 pnpm，Node 24。');
  ts.setMemoryStatus(a.id,relevant.entry.id,'adopted',1);
  const other=memory(b.id,'Node 依赖管理','包管理器使用 pnpm。');
  ts.setMemoryStatus(b.id,other.entry.id,'adopted',1);

  const chinese=ts.searchMemory(a.id,'项目使用什么包管理器？');
  assert.ok(chinese.some((match)=>match.entry.id===relevant.entry.id));
  const mixed=ts.searchMemory(a.id,'pnpm 包管理器 Node');
  assert.ok(mixed.some((match)=>match.entry.id===relevant.entry.id));
  assert.equal(ts.searchMemory(a.id,'完全无关的海边风景词汇').length,0);
  assert.equal(ts.searchMemory(a.id,'').length,0);
  assert.ok(ts.searchMemory(b.id,'pnpm').every((match)=>match.entry.projectId===b.id));
});

test('expired matches are filtered before retrieval limits and only adopted valid entries are snapshotted',()=>{
  const p=project();
  const expiresAt=new Date(Date.now()+60_000).toISOString();
  for (let i=0;i<15;i++) {
    const old=memory(p.id,`包管理器过期策略 ${i}`,'项目包管理器曾使用 npm 包管理器。',{expiresAt});
    ts.setMemoryStatus(p.id,old.entry.id,'adopted',1);
    ts.updateMemoryEntry(p.id,old.entry.id,{expiresAt:new Date(Date.now()-60_000).toISOString()},2);
  }
  const current=memory(p.id,'依赖安装','项目包管理器当前固定使用 pnpm。');
  ts.setMemoryStatus(p.id,current.entry.id,'adopted',1);
  const draft=memory(p.id,'项目包管理器草稿','项目包管理器使用 yarn。');
  const inactive=memory(p.id,'包管理器已停用规则','项目包管理器已停用旧策略。');
  ts.setMemoryStatus(p.id,inactive.entry.id,'adopted',1);
  ts.setMemoryStatus(p.id,inactive.entry.id,'inactive',2);
  const superseded=memory(p.id,'旧包管理器规则','旧的项目包管理器规则。');
  ts.setMemoryStatus(p.id,superseded.entry.id,'adopted',1);
  ts.replaceMemoryEntry(p.id,superseded.entry.id,2,{kind:'lesson',title:'数据库规则',body:'数据库选 SQLite。',source:'docs/db.md'});
  const task=makeTask(p.id);
  const snapshot=ts.memory.prepareTaskInjection(task.id,'项目使用什么包管理器？');
  assert.ok(snapshot.entries.some((entry)=>entry.id===current.entry.id));
  assert.ok(!snapshot.entries.some((entry)=>entry.id===draft.entry.id));
  assert.ok(!snapshot.entries.some((entry)=>entry.id===inactive.entry.id));
  assert.ok(!snapshot.entries.some((entry)=>entry.id===superseded.entry.id));
  assert.equal(snapshot.entries.length,1);
  assert.ok(snapshot.entries[0].injectedText.includes('来源：docs/guide.md'));
  assert.ok(ts.searchMemory(p.id,'包管理器',{statuses:['adopted'],excludeExpired:true}).every((match)=>!match.entry.expiresAt || Date.parse(match.entry.expiresAt)>Date.now()));
  const bounded=ts.memory.prepareTaskInjection(makeTask(p.id,'bounded-budget-task').id,'Node 包管理器',256);
  const actualLength=bounded.entries.map((entry)=>entry.injectedText).join('\n\n').length
    +(bounded.entries.length ? '以下是同项目已采用经验，仅供参考；项目已确认背景、本次明确要求和权限优先：\n'.length : 0);
  assert.ok(actualLength<=256,`注入快照长度 ${actualLength} 超过预算`);
});

test('long memories inject a bounded contextual excerpt around a body hit instead of an irrelevant prefix',()=>{
  const p=project();
  const body=`${'与本次检索无关的历史内容。'.repeat(500)}召回链路：HNSW 查询使用分层图索引，最终结果需要人工确认。后续步骤为精确重排。${'查询上下文继续说明。'.repeat(90)}`;
  const item=memory(p.id,'向量检索经验',body);
  ts.setMemoryStatus(p.id,item.entry.id,'adopted',1);
  const task=makeTask(p.id,'excerpt-task');
  const snapshot=ts.memory.prepareTaskInjection(task.id,'HNSW');
  assert.equal(snapshot.entries.length,1);
  const injected=snapshot.entries[0].injectedText;
  assert.ok(injected.includes('正文摘录（含命中词与上下文，非全文）'));
  assert.ok(injected.includes('召回链路：HNSW 查询使用分层图索引'));
  assert.ok(injected.includes('最终结果需要人工确认。后续步骤为精确重排。'));
  assert.ok(injected.includes('来源：docs/guide.md；版本：2'));
  assert.ok(!injected.includes(body.slice(0,2000)),'没有把正文无关前缀误称为已使用内容');
  assert.ok(injected.length+'以下是同项目已采用经验，仅供参考；项目已确认背景、本次明确要求和权限优先：\n'.length<=4200);
  assert.equal(snapshot.entries[0].body,body,'快照保留完整原文供溯源');
});

test('oversized memories are skipped when the body has no usable query hit',()=>{
  const p=project();
  const item=memory(p.id,'HNSW 项目标题','正文没有查询匹配词，只记录普通项目背景。'.repeat(300));
  ts.setMemoryStatus(p.id,item.entry.id,'adopted',1);
  const snapshot=ts.memory.prepareTaskInjection(makeTask(p.id,'title-only-hit').id,'HNSW');
  assert.deepEqual(snapshot.entries,[]);
});

test('create-with-prompt prepares memory before the first user event is sent',async()=>{
  const p=project();
  const item=memory(p.id,'Node 包管理器','本项目使用 pnpm。');
  ts.setMemoryStatus(p.id,item.entry.id,'adopted',1);
  ts.registerMockScript('prompt-create',{id:'prompt-create',steps:[{t:'result',text:'已检查'}]});
  const task=ts.createMainSession({projectId:p.id,title:'Node 包管理器任务',agentId:'mock',mockScript:'prompt-create',prompt:'检查 Node 包管理器配置'});
  await wait(80);
  const sent=ts.listEvents(task.id).find((event)=>event.type==='message'&&event.payload?.role==='user');
  assert.ok(sent?.payload.text.includes('本项目使用 pnpm。'));
  assert.equal(ts.taskMemoryUsed(task.id)?.entries[0].id,item.entry.id);
});

test('first input injects immutable experience snapshot once, including after earlier non-message events and long prompts',async()=>{
  const p=project();
  const item=memory(p.id,'Node 包管理器','项目包管理器固定使用 pnpm。');
  ts.setMemoryStatus(p.id,item.entry.id,'adopted',1);
  ts.registerMockScript('quiet',{id:'quiet',steps:[{t:'result',text:'完成'}]});
  const task=ts.createMainSession({projectId:p.id,title:'包管理器任务',agentId:'mock',mockScript:'quiet'});
  // A validation/error event may precede the first user prompt; it must not suppress preparation.
  store.appendEvent(task.id,'error',{message:'此前的供应商探测失败'});
  const longPrompt=`请说明项目的包管理器。${'追加详细任务要求。'.repeat(150)}`;
  const sent=await ts.send(task.id,longPrompt,'long-first');
  assert.equal(sent.ok,true);
  await wait(60);
  const firstMessage=ts.listEvents(task.id).find((event)=>event.type==='message'&&event.payload?.role==='user')!;
  assert.ok(firstMessage.payload.text.includes('项目包管理器固定使用 pnpm。'));
  assert.ok(firstMessage.payload.text.endsWith(longPrompt),'完整任务正文没有被检索长度限制截断');
  const snapshot=ts.taskMemoryUsed(task.id)!;
  assert.equal(snapshot.query.length,1000);
  assert.equal(snapshot.entries[0].id,item.entry.id);
  assert.equal(snapshot.entries[0].version,2);

  const revised=ts.updateMemoryEntry(p.id,item.entry.id,{body:'已改为 bun。'},2);
  assert.equal(revised.version,3);
  assert.equal(ts.taskMemoryUsed(task.id)!.entries[0].body,'项目包管理器固定使用 pnpm。');
  await ts.send(task.id,'第二轮只发送本次补充。','second-turn');
  await wait(50);
  const users=ts.listEvents(task.id).filter((event)=>event.type==='message'&&event.payload?.role==='user');
  assert.equal(users.length,2);
  assert.equal(users[1].payload.text,'第二轮只发送本次补充。');
  assert.equal(ts.taskMemoryUsed(task.id)!.entries[0].id,item.entry.id);
});

test('a task with no relevant adopted memory stores an empty usage snapshot',async()=>{
  const p=project();
  ts.registerMockScript('empty',{id:'empty',steps:[{t:'result',text:'完成'}]});
  const task=ts.createMainSession({projectId:p.id,title:'海边天气',agentId:'mock',mockScript:'empty'});
  await ts.send(task.id,'查一下今日天气');
  await wait(50);
  assert.deepEqual(ts.taskMemoryUsed(task.id)?.entries,[]);
});

test('the same first-input memory preparation runs before each client adapter without using real executors',async()=>{
  const p=project();
  const item=memory(p.id,'四客户端共用','同一项目使用 pnpm。');
  ts.setMemoryStatus(p.id,item.entry.id,'adopted',1);
  const originalResolve=(ts as any).resolveSessionProvider;
  const originalEnv=(ts as any).buildEnv;
  const originalAdapter=(ts as any).adapterFor;
  (ts as any).resolveSessionProvider=()=>({ok:true,providerId:'fixture-provider'});
  (ts as any).buildEnv=()=>({});
  (ts as any).adapterFor=()=>new MockAdapter({id:'test-capture',steps:[{t:'result',text:'mock only'}]});
  try {
    for (const [index,agentId] of ['claude-code','grok','dsh','zcode'].entries()) {
      const id=`fake-adapter-${index}`;
      store.createSession({id,projectId:p.id,kind:'main',parentSessionId:null,title:'pnpm 项目任务',agentId,model:'fixture-model',providerId:'fixture-provider',cwd:p.rootPath,scope:{fileWrite:false}});
      const result=await ts.send(id,'查询项目依赖');
      assert.equal(result.ok,true,agentId);
      await wait(35);
      const first=ts.listEvents(id).find((event)=>event.type==='message'&&event.payload?.role==='user');
      assert.ok(first?.payload.text.includes('同一项目使用 pnpm。'),`${agentId} 获取相同受控背景`);
      assert.equal(ts.getSession(id)?.providerId,'fixture-provider','记忆准备不改写供应商绑定');
      assert.equal(ts.taskMemoryUsed(id)?.entries[0].version,2);
    }
  } finally {
    (ts as any).resolveSessionProvider=originalResolve;
    (ts as any).buildEnv=originalEnv;
    (ts as any).adapterFor=originalAdapter;
  }
});

test('handoff drafts quote only a successful recorded result and are idempotent',()=>{
  const p=project();
  const success=makeTask(p.id,'success');
  const event=store.appendEvent(success.id,'result',{isError:false,numTurns:2,text:'Agent completed the requested changes.'});
  store.updateSession(success.id,{status:'idle',summary:'Agent completed the requested changes.'});
  const draft=ts.createHandoffDraft(success.id);
  assert.equal(draft.entry.status,'draft');
  assert.ok(draft.entry.body.startsWith('Agent 报告，待核对'));
  assert.ok(draft.entry.body.includes('Agent completed the requested changes.'));
  assert.ok(draft.entry.evidenceRefs.includes(`event:seq:${event.seq}`));
  assert.equal(ts.createHandoffDraft(success.id).entry.id,draft.entry.id);
  assert.equal(ts.listMemoryEntries(p.id).length,1);

  const otherTask=makeTask(p.id,'same-title-other-task');
  const otherEvent=store.appendEvent(otherTask.id,'result',{isError:false,numTurns:2,text:'Agent completed the requested changes.'});
  store.updateSession(otherTask.id,{status:'idle',summary:'Agent completed the requested changes.'});
  const otherDraft=ts.createHandoffDraft(otherTask.id);
  assert.notEqual(otherDraft.entry.id,draft.entry.id,'相同标题和正文的不同任务仍保存独立交接来源');
  assert.equal(otherDraft.entry.taskId,otherTask.id);
  assert.ok(otherDraft.entry.source.includes(`task ${otherTask.id}`));
  assert.ok(otherDraft.entry.evidenceRefs.includes(`event:seq:${otherEvent.seq}`));
  assert.equal(ts.createHandoffDraft(otherTask.id).entry.id,otherDraft.entry.id,'同一任务结果重试仍幂等');
  assert.equal(ts.listMemoryEntries(p.id).length,2);

  const failed=makeTask(p.id,'failed');
  store.appendEvent(failed.id,'result',{isError:true,numTurns:1,text:'Partial and failed.'});
  store.updateSession(failed.id,{status:'failed'});
  assert.throws(()=>ts.createHandoffDraft(failed.id),/不能生成成功交接草稿/);
  const canceled=makeTask(p.id,'canceled');
  store.appendEvent(canceled.id,'result',{isError:false,numTurns:1,text:'Old result'});
  store.updateSession(canceled.id,{status:'canceled'});
  assert.throws(()=>ts.createHandoffDraft(canceled.id),/不能生成成功交接草稿/);
});

test('nightly memory starts from new successful Workbench turns and leaves sourced drafts for review',async()=>{
  const p=project();
  const old=makeTask(p.id,'old-turn');
  store.appendEvent(old.id,'result',{isError:false,text:'Old result before activation.'});
  let calls=0;
  const nightly=new NightlyMemoryService(ts,async(turn)=>{
    calls++;
    assert.equal(turn.title,'Node 包管理器任务');
    assert.equal(turn.request,'请核对依赖命令');
    assert.ok(turn.result.includes('验证命令 npm test 通过'));
    return {model:'fixture-glm',text:JSON.stringify({items:[{title:'先跑项目测试',
      body:'提交前执行 npm test，并核对退出码。',quote:'验证命令 npm test 通过',scope:'project'}]})};
  });
  nightly.initialize(new Date(2026,8,27,2));
  const task=makeTask(p.id,'new-turn');
  store.appendEvent(task.id,'message',{role:'user',text:'本次要求：\n请核对依赖命令'});
  const result=store.appendEvent(task.id,'result',{isError:false,text:'验证命令 npm test 通过，退出码 0。'});
  const failed=makeTask(p.id,'failed-turn');
  store.appendEvent(failed.id,'result',{isError:true,text:'验证失败，不可视为成功'});
  assert.equal(dueDay(new Date(2026,8,27,2,59)),'2026-09-26');
  const before=await nightly.runIfDue(new Date(2026,8,27,2,59));
  assert.equal(before.processedTurns,0);
  const status=await nightly.runIfDue(new Date(2026,8,27,3,1));
  assert.equal(status.error,null);
  assert.equal(status.processedTurns,1);
  assert.equal(status.newDrafts,1);
  assert.equal(calls,1);
  const drafts=ts.listMemoryEntries(p.id);
  assert.equal(drafts.length,1);
  assert.equal(drafts[0].status,'draft');
  assert.equal(drafts[0].taskId,task.id);
  assert.ok(drafts[0].evidenceRefs.includes(`event:${task.id}:seq:${result.seq}`));
  assert.ok(drafts[0].body.includes('原文依据：验证命令 npm test 通过'));
  const next=makeTask(p.id,'no-injection');
  assert.equal(ts.memory.prepareTaskInjection(next.id,'npm test').entries.length,0);
  await nightly.runIfDue(new Date(2026,8,27,4));
  assert.equal(calls,1,'同一夜间窗口不重复调用模型');
  const repeat=makeTask(p.id,'same-lesson-turn');
  store.appendEvent(repeat.id,'message',{role:'user',text:'请核对依赖命令'});
  const repeatResult=store.appendEvent(repeat.id,'result',{isError:false,text:'验证命令 npm test 通过，退出码 0。'});
  const nextNight=await nightly.runIfDue(new Date(2026,8,28,3,1));
  assert.equal(nextNight.newDrafts,0,'同内容经验不重复创建');
  assert.equal(ts.listMemoryEntries(p.id).length,1);
  assert.ok(ts.listMemoryEntries(p.id)[0].evidenceRefs.includes(`event:${repeat.id}:seq:${repeatResult.seq}`));
});

test('nightly memory retries a failed model response without advancing the source cursor',async()=>{
  const p=project();
  let calls=0;
  const nightly=new NightlyMemoryService(ts,async()=>{
    calls++;
    return {model:'fixture-glm',text:calls===1 ? '{bad json' : JSON.stringify({items:[{
      title:'结果核验',body:'对结果执行复核。',quote:'本次核验通过',scope:'domain'}]})};
  });
  nightly.initialize(new Date(2026,8,27,1));
  const task=makeTask(p.id,'retry-turn');
  store.appendEvent(task.id,'result',{isError:false,text:'本次核验通过，但仍须人工查看。'});
  const first=await nightly.runIfDue(new Date(2026,8,27,3));
  assert.match(first.error ?? '',/JSON/);
  assert.equal(ts.listMemoryEntries(p.id).length,0);
  const second=await nightly.runIfDue(new Date(2026,8,27,3,1));
  assert.equal(second.error,null);
  assert.equal(second.newDrafts,1);
  assert.equal(calls,2);
  assert.equal(ts.listMemoryEntries(p.id)[0].status,'draft');
});
