// Isolated renderer retention check; no model calls or real task data.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/test-performance.mjs /path/to/Electron [result.json]
// WORKBENCH_PERF_BASELINE=1 records the old build without enforcing the retention regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-memory-'));
const projectDir = path.join(dataDir, 'project');
fs.mkdirSync(projectDir);
const db = new DatabaseSync(path.join(dataDir, 'workbench.db'));
db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root_path TEXT,is_git INTEGER,created_at TEXT);
 CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,parent_session_id TEXT,title TEXT,
 agent_id TEXT,model TEXT,status TEXT,native_session_id TEXT,cwd TEXT,scope_json TEXT,delegation_json TEXT,
 summary TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,seq INTEGER,type TEXT,payload TEXT,
 created_at TEXT,UNIQUE(session_id,seq));`);
const now = new Date().toISOString();
db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('fixture','Memory fixture',projectDir,0,now);
const insert = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for (let i = 0; i < 100; i++) insert.run(`background-${i}`,'fixture','main',null,`Background ${i}`,
 'claude-code','fixture','idle',null,projectDir,'{}',null,null,now,now);
insert.run('foreground','fixture','main',null,'Foreground','claude-code','fixture','idle',null,
 projectDir,'{}',null,null,now,now);
const insertEvent = db.prepare('INSERT INTO events(session_id,seq,type,payload,created_at) VALUES (?,?,?,?,?)');
db.exec('BEGIN');
for(let i=0;i<10000;i++) insertEvent.run(`background-${i%100}`,Math.floor(i/100)+1,'message',
 JSON.stringify({role:'assistant',text:`event ${i} ${'x'.repeat(2048)}`}),now);
for(let i=1;i<=2500;i++) insertEvent.run('foreground',i,'text_delta',JSON.stringify({text:''}),now);
insertEvent.run('foreground',2501,'permission_request',JSON.stringify({permissionId:'historical-permission',toolName:'Bash',input:{command:'fixture'},reason:'fixture'}),now);
insertEvent.run('foreground',2502,'permission_resolved',JSON.stringify({permissionId:'historical-permission',decision:'invalidated'}),now);
insertEvent.run('foreground',2503,'message',JSON.stringify({role:'assistant',text:'Latest history recovered'}),now);
insertEvent.run('foreground',2504,'result',JSON.stringify({isError:false,text:'Fixture latest summary'}),now);
db.exec('COMMIT');
db.close();

let electron;
try {
 const env = { ...process.env, WORKBENCH_DATA_DIR:dataDir, WORKBENCH_SKIP_RESTORE:'1', WORKBENCH_DEBUG:'1' };
 delete env.ELECTRON_RUN_AS_NODE;
 electron = await _electron.launch({ executablePath:process.argv[2],env,timeout:30000 });
 const page = await electron.firstWindow();
 await page.getByRole('button',{name:'进入工作区',exact:true}).click();
 await page.getByText('Foreground',{exact:true}).first().waitFor();
 await page.waitForFunction(()=>document.querySelector('.chat-head .ht')?.textContent==='Foreground');
 if(process.env.WORKBENCH_PERF_BASELINE !== '1') {
  await page.getByText('Latest history recovered',{exact:true}).waitFor();
  await page.getByText('已失效（需恢复任务后重试）',{exact:true}).waitFor();
 }
 await page.evaluate(() => {
  window.__memoryEvents = 0;
  window.wb.onEvent(e => { if (e.sessionId.startsWith('background-')) window.__memoryEvents++; });
 });
 const cdp = await electron.context().newCDPSession(page);
 const measure = async () => {
  await cdp.send('HeapProfiler.collectGarbage');
  return {rendererHeap:await cdp.send('Runtime.getHeapUsage'),processes:await electron.evaluate(({app})=>
   app.getAppMetrics().map(m=>({pid:m.pid,type:m.type,memory:m.memory})))};
 };
 const before = await measure();
 const started = performance.now();
 await electron.evaluate(({BrowserWindow})=>{
  const contents = BrowserWindow.getAllWindows()[0].webContents;
  for(let i=0;i<10000;i++) contents.send('wb:event',{
   sessionId:`background-${i%100}`,seq:Math.floor(i/100)+1,type:'message',
   payload:{role:'assistant',text:`event ${i} ${'x'.repeat(2048)}`},createdAt:new Date().toISOString(),
  });
 });
 await page.waitForFunction(()=>window.__memoryEvents===10000,{},{timeout:30000});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const after = await measure();
 const result={events:10000,backgroundTasks:100,latestHistoryVisible:await page.getByText('Latest history recovered',{exact:true}).count()>0,elapsedMs:performance.now()-started,before,after,
  retainedHeapGrowthBytes:after.rendererHeap.usedSize-before.rendererHeap.usedSize};
 assert.equal(await page.locator('.msg .bubble').filter({hasText:/^event \d+ /}).count(),0,
  'background messages must not appear in current conversation');
 if(process.env.WORKBENCH_PERF_BASELINE !== '1') assert.ok(result.retainedHeapGrowthBytes < 4 * 1024 * 1024,
  `background events retained ${result.retainedHeapGrowthBytes} bytes after garbage collection`);
 if(process.env.WORKBENCH_PERF_BASELINE !== '1') {
  await page.getByText('Background 0',{exact:true}).click();
  await page.getByText(`event 9900 ${'x'.repeat(2048)}`,{exact:true}).waitFor();
  await electron.evaluate(({ipcMain})=>{
   // Test-only fault injection into Electron's existing handler; no application diagnostic endpoint.
   const original=ipcMain._invokeHandlers.get('events.list');
   assertHandler(original);
   function assertHandler(handler) {if(typeof handler!=='function')throw new Error('Missing events.list handler');}
   globalThis.__historyHandler=original; globalThis.__historyPageFailed=false;
   ipcMain.removeHandler('events.list');
   ipcMain.handle('events.list',(event,payload)=>{
    if(payload.sessionId==='foreground' && payload.sinceSeq===2000 && !globalThis.__historyPageFailed) {
     globalThis.__historyPageFailed=true; return {ok:false,error:'fixture transient history failure'};
    }
    return original(event,payload);
   });
  });
  await page.getByText('Foreground',{exact:true}).first().click();
  const retryDeadline=Date.now()+10000;
  while(!await electron.evaluate(()=>globalThis.__historyPageFailed)) {
   assert.ok(Date.now()<retryDeadline,'second history page was requested');
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('Latest history recovered',{exact:true}).waitFor();
  await page.getByText('已失效（需恢复任务后重试）',{exact:true}).waitFor();
  await electron.evaluate(({ipcMain})=>{
   ipcMain.removeHandler('events.list'); ipcMain.handle('events.list',globalThis.__historyHandler);
   delete globalThis.__historyHandler; delete globalThis.__historyPageFailed;
  });
  const editing = new DatabaseSync(path.join(dataDir,'workbench.db'));
  try {
   editing.exec('BEGIN');
   editing.prepare("UPDATE sessions SET status='running' WHERE id='foreground'").run();
   const write = editing.prepare('INSERT INTO events(session_id,seq,type,payload,created_at) VALUES (?,?,?,?,?)');
   write.run('foreground',2505,'session',JSON.stringify({status:'running'}),now);
   for(let i=2506;i<=3505;i++) write.run('foreground',i,'text_delta',JSON.stringify({text:'s'}),now);
   write.run('foreground',3506,'message',JSON.stringify({role:'assistant',text:'STREAM_FINAL'}),now);
   write.run('foreground',3507,'result',JSON.stringify({isError:false,text:'Stream finished'}),now);
   editing.exec('COMMIT');
  } finally {editing.close();}
  await electron.evaluate(({BrowserWindow})=>{
   const contents=BrowserWindow.getAllWindows()[0].webContents;
   contents.send('wb:event',{sessionId:'foreground',seq:2505,type:'session',payload:{status:'running'}});
   for(let seq=2506;seq<=3505;seq++) contents.send('wb:event',{sessionId:'foreground',seq,type:'text_delta',payload:{text:'s'}});
   contents.send('wb:event',{sessionId:'foreground',seq:3506,type:'message',payload:{role:'assistant',text:'STREAM_FINAL'}});
   contents.send('wb:event',{sessionId:'foreground',seq:3507,type:'result',payload:{isError:false,text:'Stream finished'}});
  });
  await page.getByText('STREAM_FINAL',{exact:true}).waitFor();
  assert.equal(await page.getByText('STREAM_FINAL',{exact:true}).count(),1,'canonical streaming reply appears once');
  assert.equal(await page.locator('.streaming').count(),0,'completed stream is cleared');
  const readonly=new DatabaseSync(path.join(dataDir,'workbench.db'));
  try {assert.equal(readonly.prepare('SELECT COUNT(*) AS n FROM events').get().n,13507,'raw history remains intact');}
  finally {readonly.close();}
  result.functionalChecks={historyPast2000:true,permissionResolution:true,refreshRetriesFailedPage:true,
   streamAppearsOnce:true,streamCleared:true,rawHistoryIntact:true};
 }
 if(process.argv[3]) fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
} finally {
 if(electron) await electron.close();
 fs.rmSync(dataDir,{recursive:true,force:true});
}
