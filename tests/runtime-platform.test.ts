import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveClaudeExecutable,resolveNodeExecutable,resolvePythonExecutable,resolveRuntimeExecutable,pythonArguments,signalOwnedProcess} from '../src/main/adapters/types';

function fixture(run:(home:string,write:(name:string)=>string)=>void){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wb-runtime-platform-'));
  const write=(name:string)=>{const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'NOT A REAL RUNTIME');fs.chmodSync(file,0o755);return file;};
  try{run(home,write);}finally{fs.rmSync(home,{recursive:true,force:true});}
}

test('runtime executables use explicit overrides and PATH, with version-independent fallback bins',{skip:process.platform==='win32'},()=>fixture((home,write)=>{
  const node=write('custom/node'),python=write('custom/python3'),dsh=write('.local/node-arbitrary-platform/bin/dsh');
  const options={home,platform:'darwin' as const,env:{PATH:path.dirname(node)}};
  assert.equal(resolveNodeExecutable(options),node);
  assert.equal(resolvePythonExecutable(options),python);
  assert.equal(resolveRuntimeExecutable('dsh','WORKBENCH_DSH_PATH',options),dsh);
  const override=write('override/custom-node');
  assert.equal(resolveNodeExecutable({...options,env:{...options.env,WORKBENCH_NODE_PATH:override}}),override);
  assert.equal(resolveRuntimeExecutable('dsh','WORKBENCH_DSH_PATH',{...options,env:{PATH:'',WORKBENCH_DSH_PATH:path.join(home,'missing')}}),null);
}));

test('Windows Python launcher and CLI PATH are resolved without shell execution',()=>fixture((home,write)=>{
  const py=write('win/py.exe'),node=write('win/node.EXE'),dsh=write('win/dsh.cmd');
  const env={PATH:path.dirname(py),PATHEXT:'.EXE;.CMD'};
  const options={home,platform:'win32' as const,env};
  assert.equal(resolvePythonExecutable(options)?.toLowerCase(),py.toLowerCase());
  assert.deepEqual(pythonArguments(py),['-3']);
  assert.deepEqual(pythonArguments(path.join(home,'python.exe')),[]);
  assert.equal(resolveNodeExecutable(options)?.toLowerCase(),node.toLowerCase());
  assert.equal(resolveRuntimeExecutable('dsh','WORKBENCH_DSH_PATH',options)?.toLowerCase(),dsh.toLowerCase());
  write('win/claude.cmd');
  assert.equal(resolveClaudeExecutable(options),undefined,'Windows npm shim leaves SDK binary selection unset');
}));

test('missing standalone Claude CLI leaves SDK binary selection unset',()=>fixture(home=>{
  const options={home,platform:'darwin' as const,env:{PATH:'',WORKBENCH_CLAUDE_PATH:path.join(home,'missing')}};
  assert.equal(resolveClaudeExecutable(options),undefined);
}));

test('process cleanup targets only retained child PID and its tree on Windows, and owned process group on POSIX',()=>{
  const pid=process.pid+10000, calls:any[]=[];
  const spawn=((...args:any[])=>{calls.push(args);return {status:0};}) as any;
  signalOwnedProcess(pid,'SIGTERM',{platform:'win32',spawnSync:spawn});
  signalOwnedProcess(pid,'SIGKILL',{platform:'win32',spawnSync:spawn});
  assert.deepEqual(calls.map(c=>c.slice(0,2)),[
    ['taskkill.exe',['/PID',String(pid),'/T']],['taskkill.exe',['/PID',String(pid),'/T','/F']]
  ]);
  assert.ok(calls.every(c=>c[2].windowsHide && !c[2].shell));
  assert.throws(()=>signalOwnedProcess(process.pid,'SIGTERM',{platform:'win32',spawnSync:spawn}),/非子进程/);
  assert.throws(()=>signalOwnedProcess(-10,'SIGTERM',{platform:'win32',spawnSync:spawn}),/非子进程/);
  const groups:any[]=[];
  signalOwnedProcess(pid,'SIGTERM',{platform:'darwin',kill:((...args:any[])=>{groups.push(args);return true;}) as any});
  assert.deepEqual(groups,[[-pid,'SIGTERM']]);
});

test('Python runtime helpers preserve platform locking, owned PID cleanup and Node execution of a Windows DSH shim',()=>{
  // This runs Python locally with injected Windows API fixtures. It does not
  // claim execution on a Windows host or launch any model/agent executable.
  const python=resolvePythonExecutable();
  const script=String.raw`
import importlib.util, io, os, tempfile
from pathlib import Path
from unittest.mock import patch
root=Path.cwd()
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,root/'scripts'/file)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
runtime=load('fixture_runtime','grok-glm.py')
agents=load('fixture_agents','agent-glm.py')
assert 'start_new_session' in runtime.spawn_options(False)
assert 'creationflags' in runtime.spawn_options(True)
calls=[]
class Process:
 pid=os.getpid()+10000
 def poll(self):return None
with patch.object(runtime.subprocess,'run',side_effect=lambda *args,**kwargs:calls.append((args,kwargs))):
 runtime.terminate_owned_process(Process(),windows=True)
 runtime.terminate_owned_process(Process(),force=True,windows=True)
assert calls[0][0][0]==['taskkill.exe','/PID',str(Process.pid),'/T']
assert calls[1][0][0]==['taskkill.exe','/PID',str(Process.pid),'/T','/F']
assert not any('shell' in kwargs for _,kwargs in calls)
locked=[]
class WindowsLock:
 LK_NBLCK=2
 def locking(self,fd,mode,count):locked.append((mode,count))
with tempfile.TemporaryFile('a+b') as handle,patch.object(agents,'msvcrt',WindowsLock()):
 agents.acquire_run_lock(handle,windows=True)
 handle.seek(0);assert handle.read()==b'0'
assert locked==[(2,1)]
if agents.fcntl is not None:
 with tempfile.TemporaryFile('a+b') as handle:agents.acquire_run_lock(handle,windows=False)
with tempfile.TemporaryDirectory() as temp:
 folder=Path(temp);binary=folder/'dsh.cmd';binary.touch()
 js=folder/'node_modules/@deepseek-ai/dsh/lib/bin.js';js.parent.mkdir(parents=True);js.touch()
 node=folder/'node.exe';node.touch()
 assert runtime.cli_command(binary,node)==[str(node),str(js.resolve())]
 with patch.dict(runtime.os.environ,{'WORKBENCH_NODE_PATH':str(node)}):
  assert runtime.runtime_executable('node','WORKBENCH_NODE_PATH')==node
print('PLATFORM_HELPERS_OK')
`;
  const output=execFileSync(python,[...pythonArguments(python),'-c',script],{cwd:process.cwd(),encoding:'utf8',timeout:10000});
  assert.equal(output.trim(),'PLATFORM_HELPERS_OK');
});
