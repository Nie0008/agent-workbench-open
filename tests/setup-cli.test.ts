import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';
import { ControlServer } from '../src/main/controlServer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('fresh install scans without importing; confirmed import is bound to preview; CLI/MCP share backend', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-setup-'));
  const cc=path.join(tmp,'cc.db'), db=new DatabaseSync(cc);
  const secret='TEST-SECRET-MUST-NOT-LEAVE-SOURCE';
  db.exec('CREATE TABLE providers (id TEXT,app_type TEXT,name TEXT,settings_config TEXT,is_current INTEGER,sort_index INTEGER)');
  db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)').run('fixture','claude','Fixture',JSON.stringify({env:{
    ANTHROPIC_MODEL:'test-model',ANTHROPIC_BASE_URL:'https://example.test/anthropic',ANTHROPIC_AUTH_TOKEN:secret}}),1,0);db.close();
  const store=new Store(path.join(tmp,'workbench.db'));
  const service=new TaskService(store,new CredentialManager(cc),()=>[]);
  const control=new ControlServer(service);store.setKV('appVersion','0.4.0');
  await control.start(path.join(tmp,'control.json'));
  const run=(args:string[],input='{}')=>new Promise<{code:number|null,out:string,err:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'dist/main/cli.js'),...args],
      {env:{...process.env,WORKBENCH_DATA_DIR:tmp},stdio:['pipe','pipe','pipe']});
    let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('CLI timeout'));},10000);
    child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);
    child.on('exit',code=>{clearTimeout(timer);resolve({code,out,err});});child.stdin.end(input);
  });
  try {
    assert.deepEqual(service.modelCatalog.list(),[]);assert.equal(store.getKV('modelCatalog.v1'),null);
    const scan=await run(['scan','--json']);assert.equal(scan.code,0,scan.err);
    const preview=JSON.parse(scan.out);assert.ok(preview.models.some((m:any)=>m.model==='test-model' && m.importable));
    assert.equal(scan.out.includes(secret),false);assert.equal(store.getKV('modelCatalog.v1'),null);
    const setup=await run(['setup','--noninteractive']);assert.equal(setup.code,0,setup.err);
    assert.ok(setup.out.includes('未导入'));assert.equal(store.getKV('modelCatalog.v1'),null);
    assert.throws(()=>service.importConfiguration(false,preview.fingerprint),/明确确认/);
    assert.throws(()=>service.importConfiguration(true,'stale'),/已变化/);
    const imported=service.importConfiguration(true,preview.fingerprint);assert.ok(imported.added>=1);
    assert.equal(store.getKV('modelCatalog.v1')!.includes(secret),false);
    assert.equal(service.importConfiguration(true,preview.fingerprint).added,0);
    const tools=await run(['call','workbench_list_agent_options']);assert.equal(tools.code,0,tools.err);
    assert.ok(JSON.parse(tools.out).combinations.some((c:any)=>c.model==='test-model'));
    const bad=await run(['call','workbench_missing_tool']);assert.equal(bad.code,1);
    assert.match(bad.out,/未知工具/);
    const status=await run(['status']);assert.equal(JSON.parse(status.out).running,true);
    assert.equal(store.getKV('defaultTaskCombo'),null,'import never changes defaults');
  } finally {control.stop();await service.shutdown();store.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('native Claude model import uses source references; secrets remain in original settings and rotation is respected', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-native-claude-'));
  const previous=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=tmp;
  const file=path.join(tmp,'settings.json');const store=new Store(path.join(tmp,'wb.db'));
  const write=(key:string)=>fs.writeFileSync(file,JSON.stringify({model:'fixture-native',env:{ANTHROPIC_AUTH_TOKEN:key}}));
  const credentials=new CredentialManager(path.join(tmp,'missing.db'),{ttlMs:0});
  const service=new TaskService(store,credentials,()=>[]);
  try {
    write('SECRET_ORIGINAL');
    const scan=service.scanConfiguration();assert.ok(scan.models.some(m=>m.importable && m.model==='fixture-native'));
    assert.equal(JSON.stringify(scan).includes('SECRET_ORIGINAL'),false);
    service.importConfiguration(true,scan.fingerprint);
    assert.deepEqual(service.modelCatalog.find('native:claude','fixture-native')?.agents,['claude-code']);
    assert.equal(store.getKV('modelCatalog.v1')!.includes('SECRET_ORIGINAL'),false);
    write('SECRET_ROTATED');assert.equal(credentials.buildSessionEnv('native:claude')!.ANTHROPIC_AUTH_TOKEN,'SECRET_ROTATED');
  } finally {
    if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;
    await service.shutdown();store.close();fs.rmSync(tmp,{recursive:true,force:true});
  }
});
