// One installed command serves both humans and external controllers. Task tools
// stay in the existing MCP entry; setup never exports credentials to clients.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { workbenchDataDir } from './paths';
import { findExecutable } from './configDiscovery';

const here = path.dirname(fileURLToPath(import.meta.url));
const controlFile = path.join(workbenchDataDir(), 'control.json');
const args = process.argv.slice(2);
const command = args.shift() ?? '--help';
function output(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

async function rpc(method: string, params: unknown = {}, timeout = 25000): Promise<any> {
  const c = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || typeof c.token !== 'string') throw new Error('控制通道文件无效');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = http.request({host:'127.0.0.1',port:c.port,path:'/v1/rpc',method:'POST',agent:false,
      headers:{authorization:`Bearer ${c.token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout}, res => {
      let data=''; res.on('data',d=>{data+=d;if(data.length>8*1024*1024)req.destroy(new Error('响应过大'));});
      res.on('end',()=>{try { if(res.statusCode!==200)throw new Error(`控制通道 HTTP ${res.statusCode}`);resolve(JSON.parse(data)); } catch(e){reject(e);} });
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('控制通道超时')));req.end(body);
  });
}
async function checked(method: string, params: unknown = {}) {
  const value = await rpc(method,params);
  if(value.ok!==true)throw new Error(value.error ?? '调用失败');
  return value;
}

async function ensureRunning() {
  try { await checked('app.info');return; } catch { /* stale control file or first launch */ }
  const root = path.resolve(here,'../..');
  const candidates = process.platform==='darwin'
    ? [path.resolve(here,'../../../../MacOS/Electron'),path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')]
    : [path.resolve(here,'../../../../electron.exe'),path.join(root,'node_modules/electron/dist/electron.exe')];
  const executable = process.env.WORKBENCH_APP_EXECUTABLE || candidates.find(f=>fs.existsSync(f));
  if(!executable)throw new Error('找不到 Workbench 应用，请重新安装或设置 WORKBENCH_APP_EXECUTABLE');
  const env: NodeJS.ProcessEnv = {...process.env,WORKBENCH_START_HIDDEN:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  // A packaged runtime loads resources/app itself; source checkouts need their package root.
  const appArgs = fs.existsSync(path.join(root,'node_modules/electron')) ? [root] : [];
  const child=spawn(executable,appArgs,{env,cwd:os.homedir(),detached:true,stdio:'ignore'});
  let launchError: Error | undefined;child.on('error',e=>{launchError=e;});child.unref();
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    if(launchError)throw launchError;
    try { await rpc('app.info',{},500).then(r=>{if(!r.ok)throw new Error(r.error);});return; } catch { /* app initializes its store */ }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error(`后台启动超时；检查 ${path.join(workbenchDataDir(),'main.log')}`);
}

async function callTool(name: string) {
  if(!/^\w+$/.test(name))throw new Error('需要工具名称');
  const index=args.indexOf('--args-file');
  let input='{}';
  if(index>=0){if(!args[index+1])throw new Error('缺少 JSON 参数文件');input=fs.readFileSync(args[index+1],'utf8');}
  else if(!process.stdin.isTTY){input=fs.readFileSync(0,'utf8') || '{}';}
  if(Buffer.byteLength(input)>1024*1024)throw new Error('参数超过 1 MiB');
  const value=JSON.parse(input);
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('工具参数必须是 JSON 对象');
  await ensureRunning();
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(here,'mcp/entry.js')],
      {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','inherit']});
    let buffer='',done=false;
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error('工具调用超时')),30000);
    child.on('error',finish);child.on('exit',()=>{if(!done)finish(new Error('工具入口提前退出'));});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>8*1024*1024){finish(new Error('响应过大'));return;}
      const end=buffer.indexOf('\n');if(end<0)return;
      try {
        const reply=JSON.parse(buffer.slice(0,end));
        if(reply.error)throw new Error(reply.error.message);
        const result=JSON.parse(reply.result.content.find((c:any)=>c.type==='text').text);
        output(result);if(reply.result.isError)process.exitCode=1;finish();
      }catch(e){finish(e as Error);}
    });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:value}})+'\n');
  });
}

function cliLaunch() {
  const wrapper=findExecutable('workbench',{extraPaths:[path.join(os.homedir(),'.local/bin')]});
  // The bundled runtime can run CLI JS without an additional Node installation.
  return wrapper && process.platform !== 'win32' ? {command:wrapper,args:['mcp'],env:{}}
    : {command:process.execPath,args:[process.env.WORKBENCH_CLI_ENTRY || path.join(here,'cli.js'),'mcp'],env:{ELECTRON_RUN_AS_NODE:'1'}};
}
function backup(file: string) {
  if(!fs.existsSync(file))return null;
  const target=`${file}.workbench-backup-${Date.now()}`;
  fs.copyFileSync(file,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);return target;
}
function connect(client: string) {
  const launch=cliLaunch();
  if(client==='dsh'){
    const patchPath=path.join(workbenchDataDir(),'controllers','dsh.json');
    fs.mkdirSync(path.dirname(patchPath),{recursive:true});const backupPath=backup(patchPath);
    fs.writeFileSync(patchPath,JSON.stringify([{insert:[{id:'mcp-workbench',name:'@deepseek-ai/dsh-mcp-client',
      config:{serverName:'agent-workbench',transport:'stdio',...launch,failOnStartupError:true}}]}],null,2)+'\n',{mode:0o600});
    output({ok:true,patchPath,backupPath,command:['dsh','--profile','headless','--patch',patchPath]});return;
  }
  if(!['codex','claude-code'].includes(client))throw new Error('主控支持 dsh、codex、claude-code；其他客户端使用 workbench mcp 或 call');
  const executable=findExecutable(client==='codex'?'codex':'claude',{extraPaths:[path.join(os.homedir(),'.local/bin')]});
  if(!executable)throw new Error(`${client} 未安装；Workbench 不会代为安装客户端`);
  const config=client==='codex'?path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'config.toml')
    :path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(),'.claude.json');
  const backupPath=backup(config);
  const clientArgs=['mcp','add',...(client==='claude-code'?['--transport','stdio','--scope','user']:[])];
  for(const [key,value] of Object.entries(launch.env))clientArgs.push('--env',`${key}=${value}`);
  clientArgs.push('agent-workbench','--',launch.command,...launch.args);
  const registration=client==='claude-code'
    ? ['mcp','add-json','--scope','user','agent-workbench',JSON.stringify({type:'stdio',...launch})] : clientArgs;
  let clientCommand=executable, invocation=registration;
  const env={...process.env};
  if(process.platform==='win32' && /\.(cmd|bat)$/i.test(executable)){
    const pkg=client==='codex'?'@openai/codex':'@anthropic-ai/claude-code';
    const folder=path.join(path.dirname(executable),'node_modules',pkg);
    const meta=JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8'));
    const bin=typeof meta.bin==='string'?meta.bin:Object.values(meta.bin)[0];
    const entry=path.resolve(folder,String(bin));
    if(!entry.startsWith(folder+path.sep) || !fs.statSync(entry).isFile())throw new Error('客户端 npm 入口无效');
    clientCommand=process.execPath;invocation=[entry,...registration];env.ELECTRON_RUN_AS_NODE='1';
  }
  const result=spawnSync(clientCommand,invocation,{env,encoding:'utf8',timeout:15000,windowsHide:true});
  if(result.status!==0)throw new Error(`${client} 接入失败；已有备份 ${backupPath ?? '原配置不存在'}。${result.error?.message ?? result.stderr.trim()}`);
  output({ok:true,client,backupPath,command:launch.command,args:launch.args});
}

async function main() {
  switch(command){
    case '--help':case 'help':
      process.stdout.write('Agent Workbench\n  setup [--noninteractive]  扫描并询问导入\n  scan [--json]            只读扫描 Agent / 模型配置\n  connect dsh|codex|claude-code  接入指定主控\n  start | status          启动后台 / 查询状态\n  mcp                     标准 stdio MCP\n  call TOOL [--args-file FILE]  调用同一工具（也接受 stdin JSON）\n');return;
    case 'status':
      try{output({...await checked('app.info'),running:true,dataDir:workbenchDataDir()});}catch{output({ok:true,running:false,dataDir:workbenchDataDir()});}return;
    case 'connect':connect(args[0]);return;
    case 'call':await callTool(args.shift() ?? '');return;
    case 'start':await ensureRunning();output({ok:true,running:true});return;
    case 'mcp':await ensureRunning();await import('./mcp/entry');return;
    case 'scan':case 'setup':{
      await ensureRunning();const scan=await checked('config.scan');
      if(command==='scan'){output(scan);return;}
      process.stdout.write('检测结果（不显示密钥）：\n');
      for(const agent of scan.agents)process.stdout.write(`  ${agent.name}：${agent.executable?'CLI 已安装':agent.configPath?'发现配置，CLI 未找到':'未找到 CLI 或配置'}\n`);
      for(const model of scan.models)process.stdout.write(`  ${model.name} (${model.model})：${model.importable?'可导入为执行模型':'主控模型记录；尚无执行绑定'}\n`);
      for(const warning of scan.warnings)process.stdout.write(`  ${warning}\n`);
      let confirmed=false;
      if(!args.includes('--noninteractive') && process.stdin.isTTY){
        const rl=createInterface({input:process.stdin,output:process.stdout});
        try{confirmed=/^(y|yes|是)$/i.test((await rl.question('是否导入这些配置？密钥留在原来源，现有默认项保持不变 [y/N] ')).trim());}finally{rl.close();}
      }
      if(confirmed){const imported=await checked('config.import',{confirmed:true,fingerprint:scan.fingerprint});process.stdout.write(`已导入 ${imported.added} 个执行模型，并保存检测到的主控配置记录。\n`);}
      else process.stdout.write('未导入。需要时运行 workbench setup，或在模型管理中手动导入。\n');
      process.stdout.write('接入主控：workbench connect dsh | claude-code | codex\n通用接入：workbench mcp；Skill 位于安装包 skills/agent-workbench/SKILL.md\n');return;
    }
    default:throw new Error(`未知命令 ${command}；运行 workbench --help`);
  }
}
main().catch(error=>{process.stderr.write(`Workbench: ${error.message}\n`);process.exitCode=1;});
