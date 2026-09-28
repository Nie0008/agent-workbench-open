#!/usr/bin/env python3
"""Stable, project-isolated Grok/GLM entry. Secrets are injected only into child env."""
import argparse, hashlib, json, os, sqlite3, subprocess, sys
from pathlib import Path

MODEL = 'glm-5.3-flash'
BASE = 'https://open.bigmodel.cn/api/coding/paas/v4'

def anthropic_provider(db, selected=None):
    if selected and selected.startswith('workbench-local:'):
        key=os.environ.get('ANTHROPIC_AUTH_TOKEN') or os.environ.get('ANTHROPIC_API_KEY')
        base=os.environ.get('ANTHROPIC_BASE_URL','').rstrip('/')
        if not key or not base.startswith('https://'):
            raise ValueError('Workbench 本地凭据不可用')
        return selected,key,base
    with sqlite3.connect('file:'+str(db)+'?mode=ro', uri=True) as conn:
        rows = conn.execute("SELECT id,settings_config FROM providers WHERE app_type='claude'").fetchall()
    matches=[]
    for pid, raw in rows:
        if selected and pid != selected: continue
        data=json.loads(raw)
        env={**data.get('env',{}),**data.get('settings',{}).get('env',{})}
        base=env.get('ANTHROPIC_BASE_URL','').rstrip('/')
        if not base.startswith('https://'): continue
        key=env.get('ANTHROPIC_AUTH_TOKEN') or env.get('ANTHROPIC_API_KEY')
        if key: matches.append((pid,key,base))
    if len(matches)!=1:
        raise ValueError('CC Switch 中需有唯一匹配的 Anthropic 凭据；多个时指定 --provider-id。不回退其他凭据。')
    return matches[0]

def provider(db, selected=None):
    pid,key,base=anthropic_provider(db,selected)
    if base!='https://open.bigmodel.cn/api/anthropic':
        raise ValueError('Grok 自定义模型入口仅支持智谱 Anthropic 凭据')
    return pid,key

def prepare(cwd, db, state_root, selected=None, task_id=None, model=MODEL):
    pid,key=provider(db,selected)
    scope=str(cwd) if not task_id else str(cwd)+'\\0'+task_id
    home=state_root/hashlib.sha256(scope.encode()).hexdigest()[:20]
    home.mkdir(parents=True,exist_ok=True,mode=0o700)
    binding=home/'binding.json'
    expected={'cwd':str(cwd),'providerId':pid,'model':model}
    if binding.exists() and json.loads(binding.read_text()) != expected:
        raise ValueError('该工作目录已绑定另一供应商，拒绝静默切换。')
    binding.write_text(json.dumps(expected,ensure_ascii=False));binding.chmod(0o600)
    model_literal=json.dumps(model)
    config=f'''[cli]
auto_update = false
[features]
telemetry = false
feedback = false
[models]
default = {model_literal}
[model.{model_literal}]
model = {model_literal}
base_url = "https://open.bigmodel.cn/api/coding/paas/v4"
api_backend = "chat_completions"
env_key = "WORKBENCH_GLM_KEY"
context_window = 200000
max_completion_tokens = 32768
'''
    (home/'config.toml').write_text(config);(home/'config.toml').chmod(0o600)
    env={k:v for k,v in os.environ.items() if not (k.startswith('GROK_') or k in ['XAI_API_KEY','ZHIPU_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','WORKBENCH_GLM_KEY'])}
    env.update(GROK_HOME=str(home),WORKBENCH_GLM_KEY=key,GROK_TELEMETRY_ENABLED='0',GROK_MEMORY='0',GROK_AGENT_DASHBOARD='0')
    return home,env,expected

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['check','run','smoke','acp'])
    p.add_argument('--cwd',required=True,type=Path)
    p.add_argument('--provider-id')
    p.add_argument('--model',default=MODEL)
    p.add_argument('--workbench-task-id')
    p.add_argument('--prompt-file',type=Path)
    p.add_argument('--resume',help='Exact Grok native session ID created under this entry')
    p.add_argument('--max-turns',type=int,default=20)
    p.add_argument('--tools',default='',help='Explicit allowed tool list; default no tools, no automatic approval')
    a=p.parse_args();cwd=a.cwd.expanduser().resolve(strict=True)
    if not cwd.is_dir(): raise ValueError('cwd must be a directory')
    binary=Path.home()/'.grok/bin/grok'
    if not binary.is_file(): raise ValueError('Grok CLI not installed')
    if a.max_turns<1 or a.max_turns>400: raise ValueError('max-turns must be 1..400')
    if a.action=='run' and not a.prompt_file: raise ValueError('run requires --prompt-file')
    if not a.model or any(c.isspace() for c in a.model): raise ValueError('Invalid model ID')
    home,env,binding=prepare(cwd,Path.home()/'.cc-switch/cc-switch.db',Path.home()/'.local/share/agent-workbench/grok-glm',a.provider_id,a.workbench_task_id if a.action=='acp' else None,a.model)
    check=subprocess.run([str(binary),'models'],env=env,cwd=cwd,capture_output=True,text=True,timeout=30)
    if check.returncode or a.model not in check.stdout:
        raise ValueError('Grok 未加载指定模型目录；请检查隔离配置或 CLI 版本。尚未发起任务。')
    if a.action=='check':
        print(json.dumps({'configurationLoaded':True,**binding,'grokHome':str(home),'inferenceVerified':False},ensure_ascii=False),flush=True)
        return 0
    if a.action=='acp':
        # Keep stdio reserved for ACP JSON-RPC. The launcher has already resolved the
        # exact CC Switch provider and prepared the isolated GLM-only GROK_HOME.
        # Route explicit delegation through Workbench MCP so child tasks are visible
        # and governed by TaskService rather than hidden Grok subagent sessions.
        env['GROK_SUBAGENTS']='0'
        os.execve(str(binary),[str(binary),'agent','--no-leader','--model',a.model,'stdio'],env)
    print(json.dumps({'configurationLoaded':True,**binding,'grokHome':str(home),'inferenceVerified':False},ensure_ascii=False),flush=True)
    prompt='Reply only: GLM_ENTRY_OK. Do not use any tools.' if a.action=='smoke' else a.prompt_file.read_text()
    cmd=[str(binary),'-p',prompt,'--model',a.model,'--cwd',str(cwd),'--output-format','streaming-json','--max-turns',str(1 if a.action=='smoke' else a.max_turns),'--tools','' if a.action=='smoke' else a.tools,'--disable-web-search']
    if a.resume: cmd+=['--resume',a.resume]
    # No --always-approve: authorization remains with Grok.
    return subprocess.run(cmd,env=env,cwd=cwd).returncode

if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,OSError,sqlite3.Error,subprocess.TimeoutExpired,json.JSONDecodeError) as e:
        # Do not print raw provider configuration, environment, or credential-bearing subprocess output.
        print('Grok GLM entry failed: '+(str(e) if isinstance(e,ValueError) and not isinstance(e,json.JSONDecodeError) else type(e).__name__),file=sys.stderr)
        sys.exit(2)
