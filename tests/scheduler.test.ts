import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/main/store';
import {TaskService} from '../src/main/taskService';
import {CredentialManager} from '../src/main/credentials';
import {ControlServer} from '../src/main/controlServer';
import {ClaudeCodeSession} from '../src/main/adapters/claude';
import http from 'node:http';
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-scheduler-'));
 const store=new Store(path.join(dir,'db')); const service=new TaskService(store,new CredentialManager());
 service.registerMockScript('noop',{id:'noop',steps:[{t:'wait',ms:10},{t:'result',text:'done'}]});
 const project=service.createProject(dir,'test');
 const task=(extra:any={})=>service.createMainSession({projectId:project.id,title:'test',agentId:'mock',mockScript:'noop',...extra});
 return {dir,store,service,project,task,close(){service.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('普通输出不唤醒，另一个任务完成唤醒，返回增量游标',async()=>{
 const f=fixture();try{
  const a=f.task(),b=f.task();let settled=false;
  const pending=f.service.waitTaskEvents([{taskId:a.id,sinceSeq:0},{taskId:b.id,sinceSeq:0}],500).then(r=>{settled=true;return r;});
  f.store.appendEvent(a.id,'text_delta',{text:'working'});await new Promise(r=>setTimeout(r,10));assert.equal(settled,false);
  f.store.appendEvent(b.id,'result',{text:'done'});const r=await pending;
  // 任务创建时多一条 scope 审计事件，text_delta 的 seq 变为 2
  assert.equal(r.reason,'events');assert.equal(r.events.length,1);assert.equal(r.events[0].sessionId,b.id);assert.equal(r.cursors[0].sinceSeq,2);
  assert.equal(f.store.eventListenerCount,0);assert.equal(f.service.waiter.pendingCount,0);
 }finally{f.close();}
});
test('分页不丢关键事件，超大文本返回截断，普通历史不进入结果',async()=>{
 const f=fixture();try{const t=f.task();
  for(let i=0;i<205;i++){f.store.appendEvent(t.id,'text_delta',{text:'x'});f.store.appendEvent(t.id,'error',{message:'y'.repeat(4000)});}
  let cursor=0;const seen=new Set();
  for(let i=0;i<3;i++){const r=await f.service.waitTaskEvents([{taskId:t.id,sinceSeq:cursor}],0);assert.ok(r.events.length<=100);for(const e of r.events){seen.add(e.seq);assert.ok(e.payload.message.length<=1200);}cursor=r.cursors[0].sinceSeq;}
  // 205×2 条测试事件 + 任务创建时的 1 条 scope 审计事件
  assert.equal(seen.size,205);assert.equal(cursor,411);
  const r=await f.service.waitTaskEvents([{taskId:t.id,sinceSeq:cursor}],0);assert.equal(r.reason,'timeout');
 }finally{f.close();}
});
test('等待超时、abort、shutdown均释放监听；无效任务/游标拒绝',async()=>{
 const f=fixture();try{const t=f.task();
  assert.throws(()=>f.service.waitTaskEvents([{taskId:'missing',sinceSeq:0}],0),/不存在/);
  assert.throws(()=>f.service.waitTaskEvents([{taskId:t.id,sinceSeq:5}],0),/游标/);
  assert.equal((await f.service.waitTaskEvents([{taskId:t.id,sinceSeq:0}],5)).reason,'timeout');
  const abort=new AbortController();const p=f.service.waitTaskEvents([{taskId:t.id,sinceSeq:0}],1000,abort.signal);abort.abort();assert.equal((await p).reason,'aborted');
  const q=f.service.waitTaskEvents([{taskId:t.id,sinceSeq:0}],1000);f.service.shutdown();assert.equal((await q).reason,'shutdown');
  assert.equal(f.store.eventListenerCount,0);assert.equal(f.service.waiter.pendingCount,0);
 }finally{f.close();}
});
test('重复等待不增加常驻监听器；完成历史立即返回',async()=>{
 const f=fixture();try{const t=f.task();
  for(let i=0;i<100;i++)await f.service.waitTaskEvents([{taskId:t.id,sinceSeq:0}],0);
  assert.equal(f.store.eventListenerCount,0);assert.equal(f.service.waiter.pendingCount,0);
  f.store.appendEvent(t.id,'session',{status:'stopped'});assert.equal((await f.service.waitTaskEvents([{taskId:t.id,sinceSeq:0}],20000)).reason,'events');
 }finally{f.close();}
});
test('背景版本冲突拒绝覆盖，快照固定，重放不重复创建，未知Agent拒绝',async()=>{
 const f=fixture();try{
  const m=f.service.updateMemory(f.project.id,'长期决定A',0,'用户');assert.equal(m.version,1);
  assert.throws(()=>f.service.updateMemory(f.project.id,'错误覆盖',0,'agent'),/版本冲突/);
  const a=f.task({background:'验收背景B',clientRequestId:'same'});
  const b=f.task({background:'验收背景B',clientRequestId:'same'});assert.equal(a.id,b.id);
  assert.throws(()=>f.task({background:'different',clientRequestId:'same'}),/参数不一致/);
  assert.throws(()=>f.task({agentId:'not-installed'}),/未接入/);
  f.service.updateMemory(f.project.id,'长期决定C',1,'用户');
  const snap=JSON.parse(f.store.getKV(`background:${a.id}`)!);assert.equal(snap.facts,'长期决定A');assert.equal(snap.projectVersion,1);
  await f.service.send(a.id,'开始');await new Promise(r=>setTimeout(r,30));
  const text=f.store.listEvents(a.id).find(e=>e.type==='message')!.payload.text;
  assert.match(text,/长期决定A/);assert.match(text,/验收背景B/);
  f.service.shutdown();f.store.close();
  const reopened=new TaskService(new Store(path.join(f.dir,'db')),new CredentialManager());
  try{assert.equal(reopened.createMainSession({projectId:f.project.id,title:'test',agentId:'mock',mockScript:'noop',background:'验收背景B',clientRequestId:'same'}).id,a.id);}finally{reopened.shutdown();reopened.store.close();}
 }finally{f.close();}
});
test('HTTP 等待请求断开释放服务监听，控制通道继续响应',async()=>{
 const f=fixture();const server=new ControlServer(f.service);try{
  const info=await server.start(path.join(f.dir,'control.json'));const t=f.task();
  const req=http.request({host:'127.0.0.1',port:info.port,path:'/v1/rpc',method:'POST',headers:{authorization:`Bearer ${info.token}`}});
  req.on('error',()=>{});req.end(JSON.stringify({method:'tasks.wait',params:{targets:[{taskId:t.id,sinceSeq:0}],timeoutMs:20000}}));
  const until=async(expected:number)=>{
    const deadline=Date.now()+1500;
    while(f.service.waiter.pendingCount!==expected && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.waiter.pendingCount,expected);
  };
  await until(1);req.destroy();await until(0);assert.equal(f.store.eventListenerCount,0);
 }finally{server.stop();f.close();}
});
test('创建快照写入失败回滚任务，取消后晚到result不能覆盖停止状态',async()=>{
 const f=fixture();try{
  const original=f.store.setKV.bind(f.store);
  f.store.setKV=(key:string,value:string)=>{if(key.startsWith('background:'))throw new Error('disk failure');original(key,value);};
  assert.throws(()=>f.task({clientRequestId:'failed-create'}),/disk failure/);
  assert.equal(f.service.listSessions(f.project.id).length,0);
  f.store.setKV=original;const t=f.task();f.service.cancel(t.id);
  (f.service as any).onAdapterEvent(t.id,{kind:'result',isError:false,numTurns:0,text:''});
  assert.equal(f.service.getSession(t.id)?.status,'stopped');
 }finally{f.close();}
});

test('授权暂停无响应计时，多请求全部处理后重新计时，拒绝错任务和重放',async()=>{
 const f=fixture();try{
  const t=f.task(),other=f.task();const svc=f.service as any;
  let interrupted=0;
  f.service.setSettings({taskTimeoutSec:0.12});
  svc.runtimes.set(t.id,{timer:null,handle:{interrupt:async()=>{interrupted++;},close(){}}});
  svc.armTimer(t.id);
  await new Promise(r=>setTimeout(r,25));
  const one=svc.requestPermission(t,'Bash',{command:'git status'});
  const two=svc.requestPermission(t,'Bash',{command:'git log -1'});
  const pending=f.service.listPendingPermissions(t.id).permissions!;
  assert.equal(pending.length,2);
  await new Promise(r=>setTimeout(r,160));
  assert.equal(f.service.getSession(t.id)?.status,'waiting_permission');assert.equal(interrupted,0);
  assert.equal(f.service.respondPermission(pending[0].permissionId,'allow',other.id).ok,false);
  assert.equal(f.service.respondPermission(pending[0].permissionId,'allow',t.id).ok,true);
  assert.equal((await one).behavior,'allow');
  assert.equal(f.service.getSession(t.id)?.status,'waiting_permission');
  assert.equal(f.service.respondPermission(pending[0].permissionId,'allow',t.id).ok,false);
  assert.equal(f.service.respondPermission(pending[1].permissionId,'deny',t.id).ok,true);
  assert.equal((await two).behavior,'deny');
  assert.equal(f.service.getSession(t.id)?.status,'running');
  await new Promise(r=>setTimeout(r,160));
  assert.equal(f.service.getSession(t.id)?.status,'timeout');assert.equal(interrupted,1);
 }finally{f.close();}
});
test('授权事件出现时详情已可读取，取消后旧授权不可再批准',async()=>{
 const f=fixture();try{const t=f.task();let found=false;
  const off=f.store.subscribeEvents(e=>{if(e.type==='permission_request')found=f.service.listPendingPermissions(t.id).permissions!.length===1;});
  const p=(f.service as any).requestPermission(t,'Bash',{command:'git status'});
  const id=f.service.listPendingPermissions(t.id).permissions![0].permissionId;
  assert.equal(found,true);f.service.cancel(t.id);assert.equal((await p).behavior,'deny');
  assert.equal(f.service.respondPermission(id,'allow',t.id).ok,false);off();
 }finally{f.close();}
});

test('output and tool progress extend a turn; only silence times out, with permissions paused',async()=>{
 const f=fixture();const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
 // Node MockTimers.refresh() is a no-op; exercise the real refreshable timer.
 try{
  const task=f.task(),svc=f.service as any;let interrupted=0;
  f.service.setSettings({taskTimeoutSec:0.4});
  f.store.updateSession(task.id,{status:'running'});
  const rt={timer:null,handle:{interrupt:async()=>{interrupted++;},close:async()=>{}},recentToolInputs:new Map()};
  svc.runtimes.set(task.id,rt);svc.armTimer(task.id);
  for(const event of [{kind:'text_delta',text:'working'},{kind:'activity'},
   {kind:'tool_use',toolUseId:'read',name:'Read',input:{}},
   {kind:'tool_result',toolUseId:'read',isError:false,content:'data'}]){
   await wait(150);svc.onAdapterEvent(task.id,event);
   assert.equal(f.service.getSession(task.id)?.status,'running');
  }
  assert.equal(interrupted,0,'progress survives several complete timeout intervals');
  const permission=svc.requestPermission(task,'Bash',{command:'git status'});
  svc.onAdapterEvent(task.id,{kind:'activity'});assert.equal(rt.timer,null);
  await wait(450);assert.equal(interrupted,0);
  const id=f.service.listPendingPermissions(task.id).permissions![0].permissionId;
  f.service.respondPermission(id,'allow',task.id);await permission;
  await wait(250);assert.equal(interrupted,0);
  svc.onAdapterEvent(task.id,{kind:'text_delta',text:''}); // Empty events are not progress.
  await wait(200);assert.equal(interrupted,1);
  assert.equal(f.service.getSession(task.id)?.status,'timeout');
  assert.match(f.service.listEvents(task.id).find(e=>e.type==='notice')!.payload.text,/无响应超时/);
  assert.equal(f.service.listEvents(task.id).some(e=>String(e.type)==='activity'),false);
 }finally{await f.service.shutdown();f.close();}
});

test('idle runtime is closed without deleting history; active and permission states are protected',async()=>{
 const f=fixture();try{
  const t=f.task();let closed=0;
  const rt:any={handle:{close:async()=>{closed++;}},timer:null,ended:false};
  (f.service as any).runtimes.set(t.id,rt);
  for(const status of ['running','waiting_permission','resuming']){
   f.store.updateSession(t.id,{status:status as any});
   (f.service as any).scheduleIdleRelease(t.id,1);
   await new Promise(r=>setTimeout(r,10));assert.equal(closed,0);
  }
  f.store.updateSession(t.id,{status:'idle'});
  (f.service as any).scheduleIdleRelease(t.id,1);
  await new Promise(r=>setTimeout(r,10));assert.equal(closed,1);
  assert.equal(f.store.getSession(t.id)?.status,'idle');
  assert.ok(f.store.getSession(t.id));
 }finally{f.close();}
});

test('idle release retires the handle; the same task resumes with its persisted native id',async()=>{
 const f=fixture();try{
  const t=f.task();
  assert.equal((await f.service.send(t.id,'first turn')).ok,true);
  await new Promise(r=>setTimeout(r,30));
  const native=f.service.getSession(t.id)?.nativeSessionId;
  assert.ok(native);
  (f.service as any).scheduleIdleRelease(t.id,1);
  await new Promise(r=>setTimeout(r,20));
  assert.equal((f.service as any).runtimes.has(t.id),false);
  assert.equal(f.service.getSession(t.id)?.status,'idle');
  assert.equal((await f.service.send(t.id,'continue same task')).ok,true);
  await new Promise(r=>setTimeout(r,30));
  assert.equal(f.service.getSession(t.id)?.nativeSessionId,native);
  assert.equal(f.service.listEvents(t.id).filter(e=>e.type==='message'&&e.payload.role==='user').length,2);
  assert.equal((f.service as any).runtimes.has(t.id),true);
 }finally{f.close();}
});

test('parent release is deferred while a registered child is active',async()=>{
 const f=fixture();try{
  const parent=f.task(),childId='child-active';
  f.store.createSession({id:childId,projectId:f.project.id,kind:'sub',parentSessionId:parent.id,title:'child',agentId:'mock',model:'glm-5.3-flash',cwd:f.dir,scope:{fileWrite:false},providerId:null,delegation:null});
  f.store.updateSession(childId,{status:'running'});
  let closed=0;const rt:any={handle:{close:async()=>{closed++;}},timer:null,ended:false};
  (f.service as any).runtimes.set(parent.id,rt);
  (f.service as any).scheduleIdleRelease(parent.id,1);
  await new Promise(r=>setTimeout(r,15));
  assert.equal(closed,0);assert.equal((f.service as any).runtimes.has(parent.id),true);
  f.store.updateSession(childId,{status:'completed'});
  (f.service as any).scheduleIdleRelease(parent.id,1);
  await new Promise(r=>setTimeout(r,15));assert.equal(closed,1);
 }finally{f.close();}
});

test('send racing idle close waits for retirement and starts only one replacement runtime',async()=>{
 const f=fixture();try{
  const t=f.task();await f.service.send(t.id,'first');await new Promise(r=>setTimeout(r,30));
  const old=(f.service as any).runtimes.get(t.id),close=old.handle.close.bind(old.handle);
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});let closed=0;
  old.handle.close=async()=>{await gate;closed++;await close();};
  (f.service as any).scheduleIdleRelease(t.id,1);await new Promise(r=>setTimeout(r,10));
  const resumed=f.service.send(t.id,'continue');
  await new Promise(r=>setTimeout(r,10));assert.equal((f.service as any).runtimeGeneration.get(t.id),1);
  finish();assert.equal((await resumed).ok,true);await new Promise(r=>setTimeout(r,30));
  assert.equal(closed,1);assert.equal((f.service as any).runtimeGeneration.get(t.id),3);
  assert.equal(f.service.getSession(t.id)?.status,'idle');
 }finally{f.close();}
});

test('failed idle close is visible and shutdown clears release timers',async()=>{
 const f=fixture();try{
  const t=f.task();let closed=0;
  const rt:any={handle:{close:async()=>{closed++;throw new Error('close failed');}},timer:null,ended:false};
  (f.service as any).runtimes.set(t.id,rt);
  (f.service as any).scheduleIdleRelease(t.id,1);
  await new Promise(r=>setTimeout(r,15));
  assert.equal(closed,1);assert.equal((f.service as any).runtimes.get(t.id),rt);
  assert.match(f.service.listEvents(t.id).at(-1)!.payload.message,/未确认资源已释放/);
  (f.service as any).scheduleIdleRelease(t.id,10000);assert.ok(rt.idleTimer);
  f.service.shutdown();assert.equal(rt.idleTimer,undefined);
  await new Promise(r=>setTimeout(r,15));assert.equal(closed,2);
 }finally{f.close();}
});

test('native resume failure stays on the same task and is reported as interrupted',async()=>{
 const f=fixture();try{
  const t=f.task();f.store.updateSession(t.id,{nativeSessionId:'native-resume-id',status:'idle'});
  let starts=0,resumeId:string|undefined;
  (f.service as any).adapterFor=()=>({id:'mock',displayName:'resume failure',start:(opts:any)=>{
   starts++;resumeId=opts.resumeNativeSessionId;
   setTimeout(()=>opts.onEnd('error','native session unavailable'),0);
   return {send:async()=>{},interrupt:async()=>{},close:async()=>{},nativeSessionId:()=>resumeId??null};
  }});
  assert.equal((await f.service.send(t.id,'continue')).ok,true);
  await new Promise(r=>setTimeout(r,15));
  assert.equal(starts,1);assert.equal(resumeId,'native-resume-id');
  assert.equal(f.service.getSession(t.id)?.status,'interrupted');
  assert.match(f.service.listEvents(t.id).find(e=>e.type==='session'&&e.payload.status==='interrupted')!.payload.reason,/native session unavailable/);
  assert.equal(f.service.listSessions(f.project.id).filter(x=>x.id===t.id).length,1);
 }finally{f.close();}
});

test('shutdown waits for every adapter and an in-flight close, without closing twice',async()=>{
 const f=fixture();
 const releases:Array<()=>void>=[];
 try{
  const a=f.task(),b=f.task(),svc=f.service as any;
  let calls=0,settled=false;
  const gate=()=>new Promise<void>(resolve=>releases.push(resolve));
  svc.runtimes.set(a.id,{handle:{close:()=>{calls++;return gate();}},timer:null,ended:false});
  svc.runtimes.set(b.id,{handle:{close:()=>{throw new Error('already closing');}},closing:gate(),timer:null,ended:true});
  const permission=svc.requestPermission(a,'Bash',{command:'git status'});
  const pending=f.service.shutdown();
  assert.equal(f.service.shutdown(),pending);
  void pending.then(()=>{settled=true;});
  assert.equal((await permission).behavior,'deny');
  assert.equal(calls,1);assert.equal(settled,false);assert.equal(svc.runtimes.size,0);
  releases[0]();await Promise.resolve();assert.equal(settled,false);
  releases[1]();await pending;assert.equal(settled,true);
 }finally{for(const release of releases)release();await f.service.shutdown();f.close();}
});

test('repeated Claude resume failures retain the native id and never become a fresh session',async()=>{
 const resumes:Array<string|undefined>=[],ends:string[]=[];let ended!:()=>void;
 const waitForEnd=()=>new Promise<void>(resolve=>{ended=resolve;});let endGate=waitForEnd();
 const session=new ClaudeCodeSession({cwd:'/tmp',model:'test',env:{},resumeNativeSessionId:'native-stable-id',
  onEvent:()=>{},onEnd:(reason)=>{ends.push(reason);ended();}},async()=>({query:((options:any)=>{
   resumes.push(options.options.resume);
   return {close(){},interrupt:async()=>{},async *[Symbol.asyncIterator](){throw new Error('resume rejected');}} as any;
  }) as any}));
 session.start();await endGate;
 endGate=waitForEnd();await session.send('retry same task');await endGate;
 assert.deepEqual(resumes,['native-stable-id','native-stable-id']);
 assert.deepEqual(ends,['error','error']);
 await session.close();
});

test('Claude start and native resume preserve ask-all settings and permission callback IDs',async()=>{
 const options:any[]=[],calls:any[]=[];let ended!:()=>void;
 const waitForEnd=()=>new Promise<void>(resolve=>{ended=resolve;});let endGate=waitForEnd();
 const session=new ClaudeCodeSession({cwd:'/tmp',model:'test',env:{},
  canUseTool:async(name,input,ctx)=>{calls.push({name,input,ctx});return {behavior:'deny'};},
  onEvent:()=>{},onEnd:()=>{ended();}},async()=>({query:((request:any)=>{
   options.push(request.options);const round=options.length;
   return {close(){},interrupt:async()=>{},async *[Symbol.asyncIterator](){
    await request.prompt[Symbol.asyncIterator]().next();
    yield {type:'system',subtype:'init',session_id:'native-policy-id'};
    const result=await request.options.canUseTool('Bash',{command:'true'},{toolUseID:`call-${round}`,requestId:`request-${round}`});
    assert.equal(result.behavior,'deny');
    yield {type:'result',num_turns:1,is_error:false,result:'done'};
   }} as any;
  }) as any}));
 try{
  session.start();await session.send('first');await endGate;
  endGate=waitForEnd();await session.send('resume');await endGate;
  assert.equal(options.length,2);
  for(const option of options){
   assert.deepEqual(option.settings,{permissions:{ask:['*']}});
   assert.equal(option.permissionMode,'default');
   assert.deepEqual(option.settingSources,[]);
   assert.equal(option.allowDangerouslySkipPermissions,undefined);
  }
  assert.equal(options[0].resume,undefined);assert.equal(options[1].resume,'native-policy-id');
  assert.deepEqual(calls.map(c=>c.ctx),[{toolUseId:'call-1',requestId:'request-1'},{toolUseId:'call-2',requestId:'request-2'}]);
 }finally{await session.close();}
});

test('Claude SDK error results retain the failure reason without credential values',()=>{
 const events:any[]=[];
 const secret='SDK_ERROR_SECRET_SENTINEL';
 const session=new ClaudeCodeSession({cwd:os.tmpdir(),model:'fixture',env:{ANTHROPIC_AUTH_TOKEN:secret},
   onEvent:e=>events.push(e),onEnd:()=>{}});
 (session as any).dispatch({type:'result',is_error:true,subtype:'error_during_execution',
   errors:[`Missing working directory; ${secret}`],num_turns:0});
 const result=events.find(e=>e.kind==='result');
 assert.equal(result.isError,true);assert.match(result.text,/Missing working directory/);
 assert.equal(JSON.stringify(events).includes(secret),false);
});
