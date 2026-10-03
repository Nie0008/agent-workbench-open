#!/usr/bin/env python3
"""DSH/ZCode model entry; model-gated loopback bridge, no persistent provider secret."""
import argparse,hashlib,http.client,http.server,importlib.util,json,os,secrets,subprocess,sys,tempfile,threading,time
from pathlib import Path
from urllib.parse import urlsplit
spec=importlib.util.spec_from_file_location('grok_glm',Path(__file__).with_name('grok-glm.py'))
shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
if os.name == 'nt':
 import msvcrt
 fcntl=None
else:
 import fcntl
 msvcrt=None
NODE=None
DSH=None
ZCODE=Path('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')
BUILTIN=Path('/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json')

def acquire_run_lock(handle,windows=None):
 windows=os.name=='nt' if windows is None else windows
 if windows:
  handle.seek(0,os.SEEK_END)
  if handle.tell()==0:handle.write(b'0');handle.flush()
  handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
 else:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('tool',choices=['dsh','zcode']);p.add_argument('action',choices=['check','smoke','run','list','status'])
 p.add_argument('--cwd',type=Path,required=True);p.add_argument('--provider-id');p.add_argument('--prompt-file',type=Path)
 p.add_argument('--model',default=shared.MODEL)
 p.add_argument('--resume');p.add_argument('--timeout',type=int,default=300)
 p.add_argument('--workbench-task-id');p.add_argument('--workbench-event-file',type=Path);p.add_argument('--workbench-control-dir',type=Path)
 p.add_argument('--mode',choices=['plan','build','edit'],default='plan',help='ZCode permission mode; never auto-approve')
 a=p.parse_args();cwd=a.cwd.expanduser().resolve(strict=True)
 model=a.model
 if not model or any(c.isspace() for c in model):raise ValueError('Invalid model ID')
 if not cwd.is_dir():raise ValueError('cwd must be a directory')
 if a.action in ['list','status'] and a.tool!='dsh':raise ValueError('list/status are only supported for DSH')
 if not 10<=a.timeout<=14400:raise ValueError('timeout must be 10..14400 seconds')
 if a.action=='run' and not a.prompt_file:raise ValueError('run requires --prompt-file')
 if any([a.workbench_task_id,a.workbench_event_file,a.workbench_control_dir]):
  if a.tool!='dsh' or a.action!='run' or not all([a.workbench_task_id,a.workbench_event_file,a.workbench_control_dir]):
   raise ValueError('Workbench ACP options require DSH run and all three fields')
  if not all(c.isalnum() or c in '-_' for c in a.workbench_task_id):raise ValueError('Invalid Workbench task ID')
 node=NODE or shared.runtime_executable('node','WORKBENCH_NODE_PATH')
 dsh=DSH or shared.runtime_executable('dsh','WORKBENCH_DSH_PATH')
 zcode=Path(os.environ.get('WORKBENCH_ZCODE_CLI') or str(ZCODE))
 builtin=Path(os.environ.get('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE') or str(BUILTIN))
 required=[dsh] if a.tool=='dsh' else [node,zcode,builtin]
 if not all(x is not None and x.is_file() for x in required):raise ValueError('CLI installation or bundled provider config missing')
 binding_key=str(cwd)+(('\x00'+a.workbench_task_id) if a.workbench_task_id else '')
 state=Path.home()/'.local/share/agent-workbench'/('fixed-'+a.tool)/hashlib.sha256(binding_key.encode()).hexdigest()[:20]
 if a.action=='status':
  runs=[]
  for receipt in sorted(state.glob('run-*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:20]:
   try:
    item=json.loads(receipt.read_text());item['runReceipt']=str(receipt);runs.append(item)
   except (OSError,ValueError):continue
  print(json.dumps({'tool':'dsh','stateDir':str(state),'runs':runs},ensure_ascii=False));return 0
 pid,key,base=shared.anthropic_provider(Path.home()/'.cc-switch/cc-switch.db',a.provider_id)
 endpoint=urlsplit(base)
 if endpoint.scheme!='https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
  raise ValueError('CC Switch Anthropic 端点无效')
 state.mkdir(parents=True,exist_ok=True,mode=0o700)
 binding={'cwd':str(cwd),'providerId':pid,'model':model}
 bp=state/'binding.json'
 if bp.exists() and json.loads(bp.read_text())!=binding:raise ValueError('Existing project binding differs; refusing silent provider switch')
 bp.write_text(json.dumps(binding));bp.chmod(0o600)
 if a.action=='check':
  print(json.dumps({'tool':a.tool,'configurationChecked':True,'inferenceVerified':False,**binding}));return 0
 lock=None
 if a.tool=='dsh':
  lock=(state/'active.lock').open('a+b')
  try:acquire_run_lock(lock)
  except OSError:lock.close();raise ValueError('DSH project already has an active run; do not duplicate dispatch')
 prompt='Reply only: '+a.tool.upper()+'_GLM_OK. Do not use tools, read files, or modify anything.' if a.action=='smoke' else (a.prompt_file.read_text() if a.prompt_file else '')
 token=secrets.token_urlsafe(32);events=[]
 class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_POST(self):
   if self.headers.get('x-api-key')!=token and self.headers.get('Authorization')!='Bearer '+token:
    self.send_error(401);return
   if self.path.split('?')[0] not in ['/v1/messages','/messages']:
    self.send_error(404);return
   try:body=self.rfile.read(int(self.headers.get('Content-Length','0')));data=json.loads(body)
   except Exception:self.send_error(400);return
   event={'model':data.get('model')};events.append(event)
   if data.get('model')!=model:
    event['blocked']=True;self.send_error(400,'Unexpected model blocked');return
   connection=http.client.HTTPSConnection(endpoint.hostname,endpoint.port or 443,timeout=90)
   try:
    base_path=endpoint.path.rstrip('/')
    message_path=base_path+'/messages' if base_path.endswith('/v1') else base_path+'/v1/messages'
    connection.request('POST',message_path,body,{'Content-Type':'application/json','x-api-key':key,'Authorization':'Bearer '+key,'anthropic-version':'2023-06-01'})
    result=connection.getresponse();event['status']=result.status
    self.send_response(result.status);self.send_header('Content-Type',result.getheader('Content-Type','application/json'));self.send_header('Connection','close');self.end_headers()
    while True:
     chunk=result.read1(8192)
     if not chunk:break
     self.wfile.write(chunk);self.wfile.flush()
   except Exception as e:event['error']=type(e).__name__
   finally:connection.close();self.close_connection=True
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
 threading.Thread(target=server.serve_forever,daemon=True).start()
 url='http://127.0.0.1:'+str(server.server_port)
 env={k:v for k,v in os.environ.items() if not (k.startswith(('ANTHROPIC_','ZCODE_','DSH_')) or k in ['ZHIPU_API_KEY','XAI_API_KEY','CC_TEST_KEY','WORKBENCH_GLM_KEY'])}
 env['WORKBENCH_GLM_LOCAL_TOKEN']=token
 if node is not None:env['WORKBENCH_NODE_PATH']=str(node)
 start=time.time();proc=None;returncode=2;out='';err=''
 try:
  with tempfile.TemporaryDirectory(prefix='run-',dir=state) as temp:
   tmp=Path(temp)
   if a.tool=='dsh':
    patch=[{'id':'settings','disabled':True},{'id':'agent-default-model','config':{'provider':'cc-workbench','model':model}},{'id':'session-title-llm','disabled':True},{'id':'llm-pi-ai','config':{'providers':{'cc-workbench':{'apiKeyEnv':'WORKBENCH_GLM_LOCAL_TOKEN','api':'anthropic-messages','baseURL':url,'models':[{'id':model,'contextWindow':200000}],'defaultMaxTokens':2048 if a.action=='smoke' else 8192,'retryPolicy':{'mode':'normal','maxRetries':0}}}}}]
    patch.insert(0,{'id':'acp','config':{'provider':'cc-workbench','model':model}})
    f=tmp/'patch.json';f.write_text(json.dumps(patch))
    env['DSH_HOME']=str(state/'dsh-home')
    if a.workbench_event_file:
     a.workbench_event_file.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
     a.workbench_control_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
     env['WORKBENCH_DSH_EVENT_FILE']=str(a.workbench_event_file)
     env['WORKBENCH_DSH_CONTROL_DIR']=str(a.workbench_control_dir)
    prompt_path=tmp/'prompt.txt';prompt_path.write_text(prompt)
    run_id=secrets.token_hex(12)
    cmd=[sys.executable,str(Path(__file__).with_name('dsh_acp.py')),str(dsh),str(f),str(state),str(cwd),str(prompt_path),a.resume or '',a.action,run_id]
   else:
    data=state/'data';cli=data/'.zcode/cli';cli.mkdir(parents=True,exist_ok=True,mode=0o700)
    env['ZCODE_DATA_BASE_DIR']=str(data)
    personal={'schemaVersion':1,'config':{'providerConfigRules':{'providerRules':[{'providerId':'cc-workbench','providerName':'Workbench Model','config':{'group':'standard-personal','access':{'type':'api-key','apiKey':token},'api':{'type':'anthropic-messages','baseUrl':url},'personalModelIds':[model]}}]},'modelConfigRules':{'providerModelRules':[{'providerId':'cc-workbench','modelId':model,'config':{'properties':{'contextWindow':200000}}}],'manualProviderModelRules':[]},'defaultModelSelection':{'providerId':'cc-workbench','modelId':model}}}
    f=tmp/'personal.json';f.write_text(json.dumps(personal));f.chmod(0o600)
    (cli/'config.json').write_text(json.dumps({'model':{'main':'cc-workbench/'+model}}))
    env.update(ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=str(f),ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=str(builtin))
    cmd=[str(node),str(zcode),'-p',prompt,'--cwd',str(cwd),'--mode','plan' if a.action=='smoke' else a.mode,'--surface','terminal','--json']
    if a.resume:cmd+=['--resume',a.resume]
   proc=subprocess.Popen(cmd,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,**shared.spawn_options())
   try:out,err=proc.communicate(timeout=a.timeout);returncode=proc.returncode
   except subprocess.TimeoutExpired:
    shared.terminate_owned_process(proc)
    try:out,err=proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:shared.terminate_owned_process(proc,force=True);out,err=proc.communicate()
    returncode=124
 finally:
  if proc is not None and proc.poll() is None:
   shared.terminate_owned_process(proc)
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:shared.terminate_owned_process(proc,force=True);proc.wait()
  server.shutdown();server.server_close()
 # Provider secrets never enter child env/config/output; redact local token as well.
 out=out.replace(key,'[REDACTED]').replace(token,'[LOCAL_TOKEN]');err=err.replace(key,'[REDACTED]').replace(token,'[LOCAL_TOKEN]')
 verified=any(e.get('status')==200 for e in events) and all(e.get('model')==model and not e.get('error') and e.get('status')==200 for e in events)
 detail=None
 if a.tool=='dsh':
  try:detail=json.loads(out)
  except (ValueError,TypeError):pass
 success=returncode==0 and (verified or a.action=='list')
 if a.tool=='dsh':success=success and bool(detail and detail.get('success'))
 if a.action=='smoke':success=success and a.tool.upper()+'_GLM_OK' in out
 report={'tool':a.tool,'exitCode':returncode,'success':success,'inferenceVerified':verified,'model':model,'seconds':round(time.time()-start,1),'requests':events,'stdout':out,'stderr':err}
 if a.tool=='dsh':
  report.update(session=detail,stateDir=str(state))
  if 'run_id' in locals():report.update(runReceipt=str(state/('run-'+run_id+'.json')),eventFile=str(a.workbench_event_file or state/('events-'+run_id+'.jsonl')))
 if lock is not None:lock.close()
 print(json.dumps(report,ensure_ascii=False))
 return 0 if success else 1

if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:
  print(json.dumps({'success':False,'error':str(e) if type(e) is ValueError else type(e).__name__}));sys.exit(2)
