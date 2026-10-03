// Opt-in local controller -> restricted MCP -> canonical Workbench worker verification.
// DSH/Claude use a loopback proxy; Codex uses its existing native login.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const options = {};
for (let i=2;i<process.argv.length;i++) {
  const key=process.argv[i]; assert.ok(/^--(cli-entry|data-dir|agent|provider-id|model|controller|controller-model|output|app|relay-contract|self-check|keep-project|help)$/.test(key),'Unknown option');
  if(['--self-check','--keep-project','--help'].includes(key)) options[key]=true;
  else { assert.ok(process.argv[++i] && !process.argv[i].startsWith('--'),'Missing option value'); options[key]=process.argv[i]; }
}
const allowed=new Set(['workbench_list_agent_options','workbench_create_project','workbench_create_task','workbench_get_task','workbench_get_task_events','workbench_wait_task_events','workbench_read_task_result']);
const createFields=new Set(['agentId','providerId','model','projectId','title','prompt','clientRequestId','fileWrite','bash','network']);
function visibleTool(tool) {
  if(tool.name!=='workbench_create_task') return tool;
  const schema=tool.inputSchema;
  return {...tool,inputSchema:{...schema,properties:Object.fromEntries(Object.entries(schema.properties).filter(([key])=>createFields.has(key))),required:(schema.required || []).filter(key=>createFields.has(key)),additionalProperties:false}};
}
function isTemporary(value) {
  const resolved=fs.realpathSync(value);
  return [fs.realpathSync(os.tmpdir()),'/tmp','/private/tmp'].some(base=>{const p=path.relative(base,resolved);return p && p!=='..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p);});
}
function permitted(name,args,c,state) {
  if(!allowed.has(name) || !args || typeof args!=='object' || Array.isArray(args)) return false;
  if(name==='workbench_list_agent_options') return Object.keys(args).length===0;
  if(name==='workbench_create_project') return args.rootPath===c.projectDir && Object.keys(args).every(k=>['rootPath','name'].includes(k));
  if(name==='workbench_create_task') {
    const exact={...c.binding,title:c.title,prompt:c.prompt,clientRequestId:c.requestId,fileWrite:false,bash:'none',network:false};
    return state.projectId===args.projectId && !!state.projectId && Object.entries(exact).every(([k,v])=>args[k]===v) && Object.keys(args).every(k=>k==='projectId'||Object.hasOwn(exact,k));
  }
  if(name==='workbench_wait_task_events') return Object.keys(args).every(k=>['targets','timeoutMs'].includes(k)) && Array.isArray(args.targets) && args.targets.length===1 &&
    args.targets.every(t=>state.taskId && t.taskId===state.taskId && Number.isSafeInteger(t.sinceSeq) && t.sinceSeq>=0 && Object.keys(t).every(k=>['taskId','sinceSeq'].includes(k))) &&
    (args.timeoutMs===undefined || Number.isInteger(args.timeoutMs) && args.timeoutMs>=0 && args.timeoutMs<=20000);
  return state.taskId && args.taskId===state.taskId && Object.keys(args).every(k=>k==='taskId' || name==='workbench_get_task_events' && k==='sinceSeq' && Number.isSafeInteger(args[k]) && args[k]>=0);
}
function payload(reply) {return JSON.parse(reply.result.content.find(c=>c.type==='text').text);}
async function relay(file) {
  assert.ok(isTemporary(path.dirname(file)),'Relay contract must be temporary');
  const c=JSON.parse(fs.readFileSync(file,'utf8')); assert.ok(isTemporary(c.dataDir) && isTemporary(c.projectDir) && path.dirname(c.audit)===path.dirname(file),'Relay must use isolated directories');
  const state={}; const pending=new Map();
  const record=item=>fs.appendFileSync(c.audit,JSON.stringify(item)+'\n',{mode:0o600});
  if(fs.existsSync(c.audit)) for(const line of fs.readFileSync(c.audit,'utf8').trim().split('\n').filter(Boolean)) Object.assign(state,JSON.parse(line).identity || {});
  const child=spawn(process.execPath,[c.entry,'mcp'],{env:{...process.env,WORKBENCH_DATA_DIR:c.dataDir},stdio:['pipe','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors=(errors+d).slice(-8192));
  const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
  createInterface({input:child.stdout}).on('line',line=>{
    const reply=JSON.parse(line);const request=pending.get(reply.id);pending.delete(reply.id);
    if(request?.method==='tools/list' && reply.result) reply.result.tools=reply.result.tools.filter(t=>allowed.has(t.name)).map(visibleTool);
    if(request?.method==='tools/call') {
      const name=request.params.name;let value;try{value=payload(reply);}catch{}
      if(value?.ok && name==='workbench_create_project') state.projectId=value.project.id;
      if(value?.ok && name==='workbench_create_task') state.taskId=value.task.id;
      record({phase:'result',name,ok:value?.ok===true,identity:{...state}});
    }
    write(reply);
  });
  const input=createInterface({input:process.stdin});input.on('line',line=>{
    const request=JSON.parse(line);
    if(request.method==='tools/call') {
      const {name,arguments:args}=request.params || {};
      if(!permitted(name,args,c,state)) {record({phase:'denied',name});write({jsonrpc:'2.0',id:request.id,result:{isError:true,content:[{type:'text',text:'{"ok":false,"error":"Outside this synthetic test contract"}'}]}});return;}
      record({phase:'request',name,args});
    }
    if(request.id!==undefined) pending.set(request.id,request);
    child.stdin.write(JSON.stringify(request)+'\n');
  });
  input.on('close',()=>{child.stdin.end();child.kill();});
  child.on('error',()=>process.exit(1));child.on('exit',code=>{if(code && errors)record({phase:'relay_error',diagnostic:errors});process.exit(code ?? 1);});
}
if(options['--help']) {console.log('Real controller: --controller dsh|claude-code|codex (default dsh) --cli-entry FILE --data-dir TEMP_DIR --agent ID --provider-id ID --model glm-5.3-flash --output RECEIPT [--controller-model MODEL] [--keep-project]. DSH/Claude require loopback proxy env; Codex uses its existing native login with user config disabled. --keep-project retains the temporary cwd for continuation; caller cancels and cleans it afterwards. --self-check never invokes a model.');process.exit(0);}
if(options['--relay-contract']) {await relay(path.resolve(options['--relay-contract']));await new Promise(()=>{});}
if(options['--self-check']) {
  const c={binding:{agentId:'dsh',providerId:'fixture',model:'glm-5.3-flash'},projectDir:'/synthetic',title:'fixture',prompt:'marker',requestId:'stable'};const state={projectId:'p',taskId:'t'};
  const args={...c.binding,projectId:'p',title:c.title,prompt:c.prompt,clientRequestId:c.requestId,fileWrite:false,bash:'none',network:false};
  assert.ok(permitted('workbench_create_task',args,c,state));
  for(const changed of [{fileWrite:true},{network:true},{bash:'readonly'},{providerId:'other'},{clientRequestId:'other'},{readRoots:['/']}]) assert.ok(!permitted('workbench_create_task',{...args,...changed},c,state));
  assert.ok(!permitted('workbench_create_project',{rootPath:'/'},c,state));assert.ok(!permitted('workbench_get_task',{taskId:'other'},c,state));
  assert.ok(!permitted('workbench_respond_permission',{taskId:'t',decision:'allow'},c,state));
  const visible=visibleTool({name:'workbench_create_task',inputSchema:{properties:{projectId:{type:'string'},background:{type:'string'},readRoots:{type:'array'}},required:['projectId','background']}}).inputSchema;
  assert.deepEqual(Object.keys(visible.properties),['projectId']);assert.deepEqual(visible.required,['projectId']);
  assert.ok(!permitted('workbench_create_task',{...args,background:''},c,state));
  console.log('PASS: controller relay rejects extra permissions, bindings, projects, tasks and tools');process.exit(0);
}
for(const key of ['--cli-entry','--data-dir','--agent','--provider-id','--model']) assert.ok(options[key],`${key} is required`);
assert.equal(options['--model'],'glm-5.3-flash');assert.ok(['dsh','claude-code'].includes(options['--agent']));
const controllerId=options['--controller'] || 'dsh';assert.ok(['dsh','claude-code','codex'].includes(controllerId));
const proxy=controllerId==='codex' ? null : new URL(process.env.WORKBENCH_TEST_PROXY_URL || '');const token=process.env.WORKBENCH_TEST_PROXY_TOKEN || '';
if(proxy) {
  assert.ok(proxy.protocol==='http:' && proxy.hostname==='127.0.0.1' && proxy.port && !proxy.username && !proxy.password && !proxy.search && !proxy.hash,'A loopback proxy is required');
  assert.ok(token.length>=24 && token.length<=512 && !/\s/.test(token),'A random proxy token is required');
}
const dataDir=fs.realpathSync(options['--data-dir']);assert.ok(isTemporary(dataDir));
const entry=path.resolve(options['--cli-entry']);const root=fs.mkdtempSync(path.join(os.tmpdir(),`workbench-${controllerId}-controller-`));
const projectDir=path.join(root,'project');fs.mkdirSync(projectDir);const audit=path.join(root,'tools.jsonl');
const binding={agentId:options['--agent'],providerId:options['--provider-id'],model:options['--model']};
const marker=`CONTROLLER_${randomUUID()}`;const contract={entry,dataDir,projectDir,audit,binding,title:`${controllerId} controller synthetic worker`,requestId:randomUUID(),prompt:`Reply exactly ${marker}. Do not use tools or read/write files.`};
const env={...process.env};for(const key of Object.keys(env)) if(/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || /^(DSH|CLAUDE|CODEX|ANTHROPIC|OPENAI|DEEPSEEK|GROK|AWS|GOOGLE)_/.test(key)) delete env[key];
Object.assign(env,{HOME:root,USERPROFILE:root,DSH_HOME:path.join(root,'.dsh'),CLAUDE_CONFIG_DIR:path.join(root,'.claude'),CODEX_HOME:path.join(root,'.codex'),WORKBENCH_DATA_DIR:dataDir,WORKBENCH_TEST_LOCAL_TOKEN:token,DSH_TOOLS_MODE:'native',DSH_PERMISSION_MODE:'read-only'});
delete env.ELECTRON_RUN_AS_NODE;if(options['--app']) env.WORKBENCH_APP_EXECUTABLE=path.resolve(options['--app']);
const run=(exe,args,timeout=35000)=>{const r=spawnSync(exe,args,{env,cwd:root,encoding:'utf8',timeout,maxBuffer:4*1024*1024});assert.equal(r.status,0,'Isolated CLI check failed');return r.stdout;};
function callWithArgs(name,args={}) {
  const file=path.join(root,randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(args),{mode:0o600});
  const value=JSON.parse(run(process.execPath,[entry,'call',name,'--args-file',file]));assert.equal(value.ok,true);return value;
}
const receipt={controller:controllerId,model:options['--controller-model'] || (controllerId==='codex' ? 'native default' : binding.model),workerBinding:binding,controllerModelsInvoked:false,proxyRequestEvidence:controllerId==='codex'?'native client model events':'recorded separately by proxy owner'};
const redact=text=>token ? text.replaceAll(token,'[LOCAL_TOKEN]') : text;
let success=false;let controller;
const stopController=()=>{if(controller?.pid && controller.exitCode===null) {try{process.kill(process.platform==='win32'?controller.pid:-controller.pid,'SIGTERM');}catch{}}};
try {
  receipt.stage='preflight';
  assert.equal(JSON.parse(run(process.execPath,[entry,'status'])).running,true,'Start the isolated backend before this test');
  const combinations=callWithArgs('workbench_list_agent_options').combinations;
  assert.ok(combinations.some(c=>Object.entries(binding).every(([k,v])=>c[k]===v)),'Use an actual available worker binding');
  const contractFile=path.join(root,'contract.json');fs.writeFileSync(contractFile,JSON.stringify(contract),{mode:0o600});
  const relayArgs=[fileURLToPath(import.meta.url),'--relay-contract',contractFile];
  let executable=controllerId==='claude-code'?'claude':controllerId, controllerArgs=[];
  receipt.stage='profile';
  if(controllerId==='dsh') {
  const defaultConfig=run('dsh',['--profile','headless','--dump-default-config']);const ids=[...defaultConfig.matchAll(/^- id: (.+)$/gm)].map(m=>m[1]);
  const disabled=new Set(['settings','credentials','session-title-llm','session-telemetry-otel','agent-instructions','skill-filesystem','plan-mode','code-runtime','llm-deepseek']);
  const patch=ids.filter(id=>id.startsWith('tool-') || disabled.has(id)).map(id=>({id,disabled:true}));
  patch.push({id:'tools',config:{mode:'native'}},{id:'agent-default-model',config:{provider:'controller-test',model:binding.model}},
    {id:'llm-pi-ai',config:{providers:{'controller-test':{apiKeyEnv:'WORKBENCH_TEST_LOCAL_TOKEN',api:'anthropic-messages',baseURL:proxy.href.replace(/\/$/,''),models:[{id:binding.model,contextWindow:200000}],defaultMaxTokens:4096,retryPolicy:{mode:'normal',maxRetries:0}}}}},
    {insert:[{id:'mcp-controller-test',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'agent-workbench',transport:'stdio',command:process.execPath,args:[fileURLToPath(import.meta.url),'--relay-contract',contractFile],failOnStartupError:true}}]});
  const patchFile=path.join(root,'dsh.json');fs.writeFileSync(patchFile,JSON.stringify(patch),{mode:0o600});
  controllerArgs=['--profile','headless','--patch',patchFile];
  } else if(controllerId==='claude-code') {
    Object.assign(env,{ANTHROPIC_AUTH_TOKEN:token,ANTHROPIC_BASE_URL:proxy.href.replace(/\/$/,''),ANTHROPIC_MODEL:binding.model,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
    const config=path.join(root,'mcp.json');fs.writeFileSync(config,JSON.stringify({mcpServers:{'agent-workbench':{type:'stdio',command:process.execPath,args:relayArgs}}}),{mode:0o600});
    controllerArgs=['--print','--output-format','stream-json','--verbose','--no-session-persistence','--model',binding.model,'--tools','','--setting-sources','','--strict-mcp-config','--mcp-config',config,'--permission-mode','dontAsk','--permission-prompts','none','--allowedTools',...[...allowed].map(name=>`mcp__agent-workbench__${name}`),'--'];
  } else {
    // Authentication stays in the existing native source; CLI overrides skip user MCP/plugins.
    env.CODEX_HOME=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
    controllerArgs=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json',
      '-c','approval_policy="never"','-c','features.shell_tool=false','-c','features.apps=false','-c','features.plugins=false','-c','features.multi_agent=false','-c','web_search="disabled"',
      '-c',`mcp_servers.agent-workbench.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.agent-workbench.args=${JSON.stringify(relayArgs)}`,
      '-c',`mcp_servers.agent-workbench.env.WORKBENCH_DATA_DIR=${JSON.stringify(dataDir)}`,'-c','mcp_servers.agent-workbench.required=true'];
    for(const name of allowed) controllerArgs.push('-c',`mcp_servers.agent-workbench.tools.${name}.approval_mode="approve"`);
    if(options['--controller-model']) controllerArgs.push('--model',options['--controller-model']);
  }
  const task=`Only use the agent-workbench MCP tools. First list agent options and verify ${JSON.stringify(binding)}. Register ${projectDir} as a project using workbench_create_project. Then create one task with projectId from that result and exactly these other fields: ${JSON.stringify({...binding,title:contract.title,prompt:contract.prompt,clientRequestId:contract.requestId,fileWrite:false,bash:'none',network:false})}. Wait with workbench_wait_task_events, targets:[{taskId:returned task.id,sinceSeq:0}], timeoutMs:20000; reuse returned cursors on timeout. Read workbench_read_task_result after completion. Return its taskId and exact worker marker. Do not answer from this instruction alone. No file, shell, network or subagent tools. No permission changes.`;
  receipt.stage='controller';const outcome=await new Promise((resolve,reject)=>{
    const child=controller=spawn(executable,[...controllerArgs,task],{env,cwd:root,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',d=>output=redact(output+d).slice(-512000));
    child.stderr.on('data',d=>receipt.stderr=redact((receipt.stderr || '')+d).slice(-32768));
    const interrupt=()=>{stopController();reject(new Error('Controller interrupted'));};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
    const timer=setTimeout(()=>{stopController();reject(new Error('Controller timed out'));},240000);
    child.once('exit',()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});
  });
  receipt.controllerExit=outcome.code;receipt.controllerOutput=outcome.output;assert.equal(outcome.code,0,'Controller must complete');receipt.stage='canonical';
  const calls=fs.readFileSync(audit,'utf8').trim().split('\n').map(line=>JSON.parse(line));receipt.toolCalls=calls;
  assert.ok(!calls.some(c=>c.phase==='denied'),'Controller attempted an operation outside the contract');
  for(const name of ['workbench_list_agent_options','workbench_create_project','workbench_create_task','workbench_wait_task_events','workbench_read_task_result']) assert.ok(calls.some(c=>c.name===name && c.phase==='result' && c.ok),`Missing actual successful model tool call: ${name}`);
  const taskId=calls.findLast(c=>c.identity?.taskId)?.identity.taskId;assert.ok(taskId);receipt.taskId=taskId;
  const worker=callWithArgs('workbench_get_task',{taskId}).task;const result=callWithArgs('workbench_read_task_result',{taskId}).result;
  const events=callWithArgs('workbench_get_task_events',{taskId,sinceSeq:0}).events;
  assert.ok(['idle','completed'].includes(worker.status));for(const [k,v] of Object.entries(binding)) assert.equal(worker[k],v);
  assert.ok(events.some(e=>e.type==='result' && e.payload?.isError===false));assert.ok(!events.some(e=>['permission_request','tool_request','file_change'].includes(e.type)));
  assert.equal(result.summary.trim(),marker);assert.ok(outcome.output.includes(marker) && outcome.output.includes(taskId),'Controller must return the actual worker result');
  const scope=JSON.parse(worker.scopeJson);assert.equal(scope.fileWrite,false);assert.equal(scope.network,false);assert.equal(scope.bash,'none');
  assert.ok(typeof worker.nativeSessionId==='string' && worker.nativeSessionId.length>0,'Worker must have an actual native session');
  receipt.canonicalResult=result;receipt.canonicalEvents=events;receipt.nativeSessionId=worker.nativeSessionId;receipt.controllerModelsInvoked=true;receipt.stage='complete';success=true;
} finally {
  stopController();if(controller?.exitCode===null) await Promise.race([new Promise(resolve=>controller.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
  if(controller?.pid && controller.exitCode===null) {try{process.kill(process.platform==='win32'?controller.pid:-controller.pid,'SIGKILL');}catch{}}
  if(fs.existsSync(audit)) {
    const calls=fs.readFileSync(audit,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));receipt.toolCalls ??=calls;
    receipt.taskId ??=calls.findLast(c=>c.identity?.taskId)?.identity.taskId;
    if(!success) {
      const projectId=calls.findLast(c=>c.identity?.projectId)?.identity.projectId;let owned=[];
      if(projectId) {try{owned=callWithArgs('workbench_list_tasks',{projectId}).tasks.map(t=>t.id);}catch{}}
      for(const taskId of new Set([...owned,...calls.map(c=>c.identity?.taskId).filter(Boolean)])) {try{callWithArgs('workbench_cancel_task',{taskId});}catch{}}
    }
  }
  receipt.success=success;const retained=!success || options['--keep-project']===true;
  if(retained) {receipt.tempDir=root;receipt.projectDir=projectDir;}
  if(success) delete receipt.stderr;
  if(retained) {
    const redactDirectory=directory=>{for(const item of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,item.name);if(item.isDirectory())redactDirectory(file);
      else if(item.isFile() && /\.(json|jsonl|ya?ml|log|txt)$/.test(item.name) && fs.statSync(file).size<32*1024*1024) {
        const text=fs.readFileSync(file,'utf8');if(token && text.includes(token))fs.writeFileSync(file,redact(text));
      }
    }};redactDirectory(root);
  }
  if(options['--output']) fs.writeFileSync(path.resolve(options['--output']),redact(JSON.stringify(receipt,null,2)),{mode:0o600});
  if(!retained) fs.rmSync(root,{recursive:true,force:true});
}
console.log(redact(JSON.stringify(receipt)));
