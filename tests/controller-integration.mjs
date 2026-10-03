// Optional isolated controller/configuration and MCP check. Real worker calls require --real.
// node tests/controller-integration.mjs --cli-entry /path/to/dist/main/cli.js --app /path/to/Electron
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const flags = new Set(['--real', '--self-check', '--help']);
const values = new Set(['--workbench', '--cli-entry', '--app', '--data-dir', '--agent', '--provider-id', '--model', '--output']);
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  assert.ok(flags.has(arg) || values.has(arg), `Unknown option: ${arg}`);
  if (flags.has(arg)) options[arg] = true;
  else { assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value: ${arg}`); options[arg] = process.argv[++i]; }
}
if (options['--help']) {
  console.log('Isolated MCP/config check: --workbench EXE or --cli-entry FILE; --app EXE; --output JSON.\nOptional worker verification: --real --agent ID --provider-id ID --model ID [--data-dir TEMP_DIR].\nNo controller model is invoked; --self-check validates this script without launching services.');
  process.exit(0);
}

function temporaryDirectory(value) {
  const resolved = fs.realpathSync(value);
  return [fs.realpathSync(os.tmpdir()), '/private/tmp', '/tmp'].some(root => {
    const relative = path.relative(root, resolved);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}
function resolveExecutable(value) {
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) return path.resolve(value);
  const suffixes = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) for (const suffix of ['',...suffixes]) {
    const candidate = path.join(directory, `${value}${suffix}`);
    try { fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return path.resolve(candidate); } catch {}
  }
  throw new Error(`Executable not found: ${value}`);
}
function controlPid() {
  try { const pid=JSON.parse(fs.readFileSync(controlPath,'utf8')).pid; return Number.isSafeInteger(pid) && pid>1 ? pid : null; } catch { return null; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid,0); return true; } catch { return false; }
}
function assertServiceIdentity(expectedPid, currentPid, pidAlive) {
  assert.ok(Number.isSafeInteger(expectedPid) && expectedPid > 1, 'Backend must publish its native process PID');
  assert.equal(currentPid, expectedPid, 'Backend PID changed during the persistent MCP check');
  assert.equal(pidAlive, true, 'Native backend exited during the persistent MCP check');
}
function stopOwnedPid(pid) {
  if (!alive(pid)) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID',String(pid),'/T','/F'], {encoding:'utf8',timeout:10000});
    assert.ok(result.status===0 || !alive(pid),result.stderr || 'Owned test process tree could not be stopped');
  } else process.kill(pid,'SIGTERM');
}
function decodeTool(reply) {
  assert.equal(reply.error, undefined, 'MCP request must succeed');
  const result = reply.result;
  const text = result?.content?.find(item => item.type === 'text')?.text;
  assert.notEqual(result?.isError, true, text || 'MCP tool must succeed');
  const value = JSON.parse(text);
  assert.equal(value.ok, true, value.error || 'Workbench tool must succeed');
  return value;
}
if (options['--self-check']) {
  assert.deepEqual(decodeTool({result:{content:[{type:'text',text:'{"ok":true,"projects":[]}'}]}}).projects, []);
  assert.throws(() => decodeTool({result:{isError:true,content:[]}}));
  assert.throws(() => decodeTool({result:{isError:true,content:[{type:'text',text:'synthetic control failure'}]}}), /synthetic control failure/);
  assertServiceIdentity(42,42,true);
  assert.throws(() => assertServiceIdentity(42,43,true), /PID changed/);
  assert.throws(() => assertServiceIdentity(42,42,false), /backend exited/);
  assert.throws(() => assertServiceIdentity(null,null,false), /publish its native process PID/);
  assert.equal(temporaryDirectory(path.parse(os.tmpdir()).root), false, 'filesystem root must not be accepted as test data');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-controller-self-'));
  try { assert.equal(temporaryDirectory(fixture),true); } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
  console.log('PASS: tool errors, backend restarts/exits and unsafe data directories are rejected');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-controller-'));
const home = path.join(root, 'home');
const dataDir = options['--data-dir'] ? fs.realpathSync(options['--data-dir']) : path.join(root, 'data');
if (options['--data-dir']) assert.ok(temporaryDirectory(dataDir), 'Only an explicit temporary service directory is allowed');
fs.mkdirSync(home, {recursive:true}); fs.mkdirSync(dataDir, {recursive:true});
const controlPath = path.join(dataDir, 'control.json');
const beforePid = controlPid();
const existingServicePid = alive(beforePid) ? beforePid : null;
const env = {...process.env};
for(const key of Object.keys(env)) if(/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || /^(DSH|CODEX|CLAUDE|ANTHROPIC|OPENAI|DEEPSEEK|GROK|ZHIPU|GOOGLE|GEMINI|AWS|AZURE|BEDROCK)_/.test(key)) delete env[key];
Object.assign(env, {HOME:home, USERPROFILE:home, CODEX_HOME:path.join(home,'.codex'),
  DSH_HOME:path.join(home,'.dsh'), CLAUDE_CONFIG_DIR:path.join(home,'.claude'),
  WORKBENCH_DATA_DIR:dataDir, WORKBENCH_START_HIDDEN:'1', WORKBENCH_SKIP_RESTORE:'1'});
for(const directory of [env.CODEX_HOME,env.DSH_HOME,env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(directory,{recursive:true});
delete env.ELECTRON_RUN_AS_NODE;
if (options['--app']) env.WORKBENCH_APP_EXECUTABLE = path.resolve(options['--app']);
const cliEntry = options['--cli-entry'] || process.env.WORKBENCH_CLI_ENTRY;
if (cliEntry) env.WORKBENCH_CLI_ENTRY = path.resolve(cliEntry);
const command = resolveExecutable(options['--workbench'] || (cliEntry ? process.execPath : 'workbench'));
const prefix = options['--workbench'] || !cliEntry ? [] : [path.resolve(cliEntry)];
const wrapper = path.join(root, 'workbench');
// A configuration points to this task-owned wrapper, never a user's global installation.
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${[command,...prefix].map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ')} "$@"\n`, {mode:0o700});
env.PATH = `${root}${path.delimiter}${process.env.PATH || ''}`;
const tasks = [];
let mcp;
const report = {realWorker:options['--real'] === true, controllerModelsInvoked:false, checks:{}, clients:{}};
function run(executable, args, timeout = 35000) {
  const r = spawnSync(executable, args, {cwd:root,env,encoding:'utf8',timeout,maxBuffer:4*1024*1024});
  const label = executable===command ? args.slice(prefix.length, prefix.length+2).join(' ') : args.slice(0,2).join(' ');
  assert.equal(r.status, 0, `${path.basename(executable)} ${label} failed (status ${r.status}, ${r.error?.code || 'isolated client/service rejected request'})`);
  return r.stdout;
}
function cli(args) { return run(command, [...prefix,...args]); }
function call(name, args = {}) {
  const file = path.join(root, `${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(args), {mode:0o600});
  const result = JSON.parse(cli(['call',name,'--args-file',file]));
  assert.equal(result.ok, true, result.error || `${name} failed`);
  return result;
}
async function waitTurn(taskId, expected, initialTargets = [{taskId,sinceSeq:0}]) {
  let targets = initialTargets;
  let sawResult = false;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const waited = call('workbench_wait_task_events', {targets,timeoutMs:20000});
    targets = waited.cursors;
    assert.ok(Array.isArray(targets), 'wait returns resumable cursors');
    sawResult ||= waited.events.some(event => event.type === 'result');
    if (waited.events.some(event => event.type === 'permission_request')) {
      const pending = call('workbench_list_permissions', {taskId});
      for (const permission of pending.permissions || []) call('workbench_respond_permission',
        {taskId,permissionId:permission.permissionId,decision:'deny'});
      assert.fail('No tool permission was authorized for this text-only synthetic task');
    }
    const task = call('workbench_get_task', {taskId}).task;
    assert.ok(!['failed','timeout','stopped','canceled','interrupted'].includes(task.status), `Task stopped: ${task.status}`);
    if (sawResult && ['idle','completed'].includes(task.status)) {
      const result = call('workbench_read_task_result', {taskId}).result;
      assert.ok(result.summary.includes(expected), 'canonical task result contains the random marker');
      return {task,cursors:targets};
    }
  }
  assert.fail('Synthetic task did not finish within four minutes');
}
try {
  JSON.parse(cli(['scan','--json']));
  report.checks.scan = true;
  mcp = spawn(command, [...prefix,'mcp'], {cwd:root,env,stdio:['pipe','pipe','pipe']});
  mcp.stderr.resume();
  const lines = createInterface({input:mcp.stdout});
  const pending = new Map(); let nextId = 0; let protocolFailure;
  const failPending = error => { protocolFailure=error; for(const item of pending.values()) item.reject(error); pending.clear(); };
  mcp.on('error',failPending);
  mcp.on('exit',() => failPending(new Error('MCP process exited before its connection was closed')));
  lines.on('line', line => {
    let response; try { response=JSON.parse(line); } catch { failPending(new Error('MCP stdout contains non-protocol output')); return; }
    const item = pending.get(response.id); if (item) {pending.delete(response.id);item.resolve(response);}
  });
  const request = (method,params) => new Promise((resolve,reject) => {
    if(protocolFailure) {reject(protocolFailure);return;}
    const id = ++nextId;
    const timer = setTimeout(()=>{pending.delete(id);reject(new Error(`MCP timeout: ${method}`));},35000);
    pending.set(id,{resolve:response=>{clearTimeout(timer);resolve(response);},reject:error=>{clearTimeout(timer);reject(error);}});
    mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  const initialized = await request('initialize', {protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'controller-integration',version:'1'}});
  assert.equal(initialized.error,undefined);
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools = (await request('tools/list',{})).result.tools;
  for (const name of ['workbench_list_agent_options','workbench_create_task','workbench_wait_task_events','workbench_list_permissions'])
    assert.ok(tools.some(tool=>tool.name===name), `Missing tool: ${name}`);
  report.checks.mcpHandshakeAndDiscovery = true;
  const backendPid = controlPid();
  assertServiceIdentity(backendPid,controlPid(),alive(backendPid));
  const projectDir = path.join(root,'project');fs.mkdirSync(projectDir);
  const project = call('workbench_create_project',{rootPath:projectDir,name:'Synthetic controller fixture'}).project;
  const projects = decodeTool(await request('tools/call',{name:'workbench_list_projects',arguments:{}}));
  assert.ok(projects.projects.some(item=>item.id===project.id), 'MCP and call use the same service');
  report.checks.sharedCallAndMcp = true;
  const stabilityStarted = Date.now();
  for (let probe = 1; probe <= 10; probe++) {
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,stabilityStarted+probe*1000-Date.now())));
    assertServiceIdentity(backendPid,controlPid(),alive(backendPid));
    const currentProjects = decodeTool(await request('tools/call',{name:'workbench_list_projects',arguments:{}}));
    assert.ok(currentProjects.projects.some(item=>item.id===project.id), 'The persistent MCP connection must retain its fixture');
    assertServiceIdentity(backendPid,controlPid(),alive(backendPid));
  }
  report.checks.backendStability = {durationMs:Date.now()-stabilityStarted,probes:10,pidUnchanged:true};
  for (const [client, executable] of [['codex','codex'],['claude-code','claude'],['dsh','dsh']]) {
    const available=spawnSync(executable,['--version'],{cwd:root,env,encoding:'utf8',timeout:10000}).status===0;
    if (!available) {report.clients[client]={status:'skipped',reason:'client not installed'};continue;}
    const unrelated = 'controller-fixture';
    if(client==='codex') run('codex',['mcp','add',unrelated,'--',wrapper,'mcp']);
    if(client==='claude-code') run('claude',['mcp','add-json','--scope','user',unrelated,JSON.stringify({type:'stdio',command:wrapper,args:['mcp']})]);
    const connected = JSON.parse(cli(['connect',client]));
    assert.equal(connected.ok,true);
    if(client==='codex') {
      const config=JSON.parse(run('codex',['mcp','get','agent-workbench','--json']));
      assert.equal(config.name,'agent-workbench');
      assert.ok(JSON.stringify(config).includes('mcp'));
      assert.equal(JSON.parse(run('codex',['mcp','get',unrelated,'--json'])).name,unrelated);
    } else if(client==='claude-code') {
      const config=run('claude',['mcp','get','agent-workbench']);
      assert.ok(config.includes('agent-workbench') && config.includes('mcp'));
      assert.ok(run('claude',['mcp','get',unrelated]).includes(unrelated));
    } else {
      const response=connected;
      assert.equal(typeof response.patchPath,'string','DSH connect returns its independent patchPath');
      const patch=JSON.parse(fs.readFileSync(response.patchPath,'utf8'));
      const row=patch.flatMap(item=>item.insert || []).find(item=>item.name==='@deepseek-ai/dsh-mcp-client');
      assert.equal(row?.config?.transport,'stdio');assert.ok(row.config.args.includes('mcp'));
      const dumped=run('dsh',['--profile','headless','--patch',response.patchPath,'--dump-config']);
      assert.ok(dumped.includes('@deepseek-ai/dsh-mcp-client') && dumped.includes('agent-workbench'));
      const repeated=JSON.parse(cli(['connect',client]));
      assert.equal(fs.readFileSync(repeated.backupPath,'utf8'),JSON.stringify(patch,null,2)+'\n','DSH preserves the prior independent patch');
    }
    if(client!=='dsh') {
      assert.equal(typeof connected.backupPath,'string','existing configuration is backed up');
      const backup=fs.readFileSync(connected.backupPath,'utf8');
      assert.ok(backup.includes(unrelated) && !backup.includes('agent-workbench'),'backup contains the unchanged prior configuration');
    }
    report.clients[client]={status:'configured-and-read-back',backupVerified:true,modelInvocationVerified:false};
  }
  if (options['--real']) {
    for (const key of ['--agent','--provider-id','--model']) assert.ok(options[key], `${key} is required for explicit real verification`);
    const binding={agentId:options['--agent'],providerId:options['--provider-id'],model:options['--model']};
    const combinations=call('workbench_list_agent_options').combinations;
    assert.ok(combinations.some(combo=>Object.entries(binding).every(([key,value])=>combo[key]===value)),
      'The isolated service must expose the explicitly selected model binding');
    const marker=`CONTROLLER_${randomUUID()}`;
    const args={projectId:project.id,title:'Synthetic controller verification',prompt:`Reply exactly ${marker}. Do not use tools or read/write files.`,
      ...binding,fileWrite:false,bash:'none',network:false,clientRequestId:randomUUID()};
    const first=call('workbench_create_task',args).task;tasks.push(first.id);
    assert.equal(call('workbench_create_task',args).task.id,first.id,'create retry preserves task identity');
    const finished=await waitTurn(first.id,marker);
    const message={taskId:first.id,message:'Repeat the exact marker from your previous reply. Do not use tools.',clientMsgId:randomUUID()};
    call('workbench_send_message',message);
    assert.equal(call('workbench_send_message',message).duplicate,true,'send retry preserves message identity');
    const resumed=await waitTurn(first.id,marker,finished.cursors);
    assert.ok(finished.task.nativeSessionId && finished.task.nativeSessionId===resumed.task.nativeSessionId,'native session identity survives continuation');
    report.checks.realWorker={taskId:first.id,...binding,sameNativeSession:true,createIdempotent:true,sendIdempotent:true};
  }
  if(options['--output'])fs.writeFileSync(path.resolve(options['--output']),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report));
} catch (error) {
  if (!report.realWorker && !options['--data-dir']) {
    console.error(`Isolated backend alive: ${alive(controlPid())}`);
    try { console.error(fs.readFileSync(path.join(dataDir,'main.log'),'utf8').slice(-6000)); } catch {}
    if (process.platform === 'darwin') {
      await new Promise(resolve=>setTimeout(resolve,2000));
      const directory=path.join(os.homedir(),'Library/Logs/DiagnosticReports');
      try {
        for (const name of fs.readdirSync(directory).filter(name=>name.startsWith('Electron-') && name.endsWith('.ips'))) {
          const source=fs.readFileSync(path.join(directory,name),'utf8');
          const crash=JSON.parse(source.slice(source.indexOf('\n')+1));
          if (crash.pid===controlPid()) console.error(JSON.stringify({exception:crash.exception,termination:crash.termination,asi:crash.asi,
            frames:crash.threads?.filter(thread=>thread.triggered).flatMap(thread=>thread.frames?.slice(0,12).map(frame=>frame.symbol))}));
        }
      } catch {}
    }
  }
  throw error;
} finally {
  for(const taskId of tasks) {try{call('workbench_cancel_task',{taskId});}catch{}}
  if(mcp && mcp.exitCode===null){
    const closed=once(mcp,'close');
    mcp.stdin.end();stopOwnedPid(mcp.pid);
    let timer;
    try { await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned MCP process did not close')),5000);})]); }
    finally {clearTimeout(timer);}
  }
  let serviceStopped = true;
  const startedPid = controlPid();
  if(!existingServicePid && alive(startedPid)) {
    stopOwnedPid(startedPid);
    const deadline=Date.now()+5000;
    while(alive(startedPid) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
    serviceStopped = !alive(startedPid);
  }
  assert.ok(serviceStopped,`Isolated service did not stop; retained its temporary data: ${root}`);
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
