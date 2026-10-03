import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {discoverConfiguration,findExecutable} from '../src/main/configDiscovery';

function fixture(run:(home:string,write:(name:string,value:string)=>string)=>void){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wb-discovery-'));
  const write=(name:string,value:string)=>{const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);return file;};
  try{run(home,write);}finally{fs.rmSync(home,{recursive:true,force:true});}
}

test('executable lookup respects PATH, explicit overrides, executable bits and directories without running files',{skip:process.platform==='win32'},()=>fixture((home,write)=>{
  const first=write('first/claude','THIS IS NOT EXECUTABLE CODE'),second=write('second/claude','SECOND');
  fs.chmodSync(first,0o755);fs.chmodSync(second,0o755);
  const env={PATH:`${path.dirname(first)}:${path.dirname(second)}`};
  assert.equal(findExecutable('claude',{env,platform:'darwin'}),first);
  assert.equal(findExecutable('claude',{env,platform:'darwin',extraPaths:[second]}),second);
  fs.chmodSync(first,0o644);
  assert.equal(findExecutable('claude',{env,platform:'darwin'}),second);
  fs.mkdirSync(path.join(home,'first','codex'));
  assert.equal(findExecutable('codex',{env,platform:'darwin'}),null);
  assert.equal(findExecutable('claude',{env:{PATH:''},platform:'darwin'}),null);
}));

test('Windows lookup accepts quoted semicolon PATH and case-insensitive PATHEXT without POSIX execute bits',()=>fixture((home,write)=>{
  const file=write('Windows Tools/CoDeX.CmD','DO NOT RUN');
  fs.chmodSync(file,0o600);
  const env={Path:`"${path.dirname(file)}";${path.join(home,'missing')}`,PathExt:'.EXE;.CMD'};
  assert.equal(findExecutable('codex',{env,platform:'win32'})?.toLowerCase(),file.toLowerCase());
  assert.equal(findExecutable('codex.cmd',{env,platform:'win32'})?.toLowerCase(),file.toLowerCase());
  const custom=write('Windows Tools/helper.CUSTOM','CUSTOM');
  assert.equal(findExecutable('helper',{env:{PATH:path.dirname(custom),PATHEXT:'.CUSTOM'},platform:'win32'}),custom);
  const text=write('Windows Tools/notes.txt','text');
  assert.equal(findExecutable(text,{env,platform:'win32'}),null);
}));

test('native discovery emits only explicit metadata, stable source references, and no configuration or environment secret values',()=>fixture((home,write)=>{
  const secret='DISCOVERY_SECRET_SENTINEL_NEVER_RETURN';
  const claude=write(process.platform==='win32'?'bin/claude.cmd':'bin/claude','DO NOT LAUNCH');fs.chmodSync(claude,0o755);
  write('.codex/config.toml',`model = "gpt-fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nwire_api = "responses"\nexperimental_bearer_token = "${secret}"\n[profiles.review]\nmodel = "gpt-review"\n`);
  write('.codex/auth.json',JSON.stringify({model:'AUTH_FILE_MUST_NOT_BE_SCANNED',OPENAI_API_KEY:secret}));
  write('.claude/settings.json',JSON.stringify({model:'claude-fixture',env:{ANTHROPIC_DEFAULT_HAIKU_MODEL:'haiku-fixture',ANTHROPIC_AUTH_TOKEN:secret},apiKeyHelper:`echo ${secret}`}));
  write('.grok/config.toml',`[model.fixture-grok]\napi = "anthropic-messages"\n[auth_provider.test]\ntoken = "${secret}"\n`);
  write('.dsh/cordis.patch.yml',`- id: agent-default-model\n  config:\n    provider: fixture\n    model: dsh-fixture\n- id: llm-pi-ai\n  config:\n    apiKey: ${secret}\n`);
  write('.dsh/profiles/quiet/cordis.patch.yml','- id: acp\n  config:\n    model: dsh-profile\n');
  write('.zcode/v2/provider_config.json',JSON.stringify({config:{defaultModelSelection:{modelId:'zcode-fixture'},modelConfigRules:{providerModelRules:[{modelId:'zcode-other'}]},providerConfigRules:{providerRules:[{config:{access:{apiKey:secret}}}]}}}));
  const env={PATH:path.dirname(claude),ANTHROPIC_AUTH_TOKEN:secret,OPENAI_API_KEY:secret};
  const found=discoverConfiguration({home,env,platform:process.platform});
  assert.equal(found.agents.length,5);
  const executable=found.agents.find(a=>a.id==='claude-code')?.executable;
  assert.ok(executable);
  assert.equal(path.relative(fs.realpathSync(claude),fs.realpathSync(executable)),'');
  assert.deepEqual(found.models.map(m=>m.model).sort(),['claude-fixture','dsh-fixture','dsh-profile','fixture-grok','gpt-fixture','gpt-review','haiku-fixture','zcode-fixture','zcode-other'].sort());
  assert.equal(found.models.find(m=>m.model==='gpt-fixture')?.protocol,'openai');
  assert.equal(found.models.find(m=>m.model==='fixture-grok')?.protocol,'anthropic');
  assert.ok(found.models.every(m=>!m.importable && m.reason && m.path.startsWith(home)));
  assert.equal(JSON.stringify(found).includes(secret),false);
  assert.equal(JSON.stringify(found).includes('AUTH_FILE_MUST_NOT_BE_SCANNED'),false);
  assert.deepEqual(found,discoverConfiguration({home,env,platform:process.platform}));
}));

test('config directory overrides, DSH tilde expansion and blank home overrides follow native locations',()=>fixture((home,write)=>{
  write('.codex/config.toml','model = "wrong-default"');
  write('custom-codex/config.toml','model = "custom-codex"');
  write('custom-claude/settings.json','{"model":"custom-claude"}');
  write('custom-dsh/cordis.patch.yml','- id: agent-default-model\n  config:\n    model: custom-dsh');
  const env={PATH:'',CODEX_HOME:path.join(home,'custom-codex'),CLAUDE_CONFIG_DIR:path.join(home,'custom-claude'),DSH_HOME:'~/custom-dsh'};
  const found=discoverConfiguration({home,env,platform:'linux'});
  assert.deepEqual(found.models.map(m=>m.model).sort(),['custom-codex','custom-claude','custom-dsh'].sort());
  assert.equal(found.agents.find(a=>a.id==='dsh')?.configPath,path.join(home,'custom-dsh/cordis.patch.yml'));
  assert.ok(discoverConfiguration({home,env:{PATH:'',CODEX_HOME:'  '},platform:'linux'}).models.some(m=>m.model==='wrong-default'));
}));

test('oversize, malformed and authentication symlink configurations do not block other agents or expose raw parser errors',()=>fixture((home,write)=>{
  const secret='BAD_JSON_SECRET_SENTINEL';
  write('.codex/config.toml',`model = "${'x'.repeat(1024*1024)}"`);
  write('.claude/settings.json',`{"env":{"ANTHROPIC_AUTH_TOKEN":"${secret}"},BAD_SECRET_SYNTAX`);
  write('.grok/config.toml','[model.still-found]\napi = "openai"');
  write('.zcode/v2/auth.json','{"config":{"defaultModelSelection":{"modelId":"must-not-read"}}}');
  fs.symlinkSync('auth.json',path.join(home,'.zcode/v2/provider_config.json'));
  const found=discoverConfiguration({home,env:{PATH:''},platform:'linux'});
  assert.deepEqual(found.models.map(m=>m.model),['still-found']);
  assert.equal(found.warnings.length,3);
  assert.ok(found.warnings.some(w=>w.includes('1 MiB')));
  assert.ok(found.warnings.some(w=>w.includes('JSON')));
  assert.ok(found.warnings.some(w=>w.includes('认证文件')));
  assert.equal(JSON.stringify(found).includes(secret),false);
}));

test('uninterpreted TOML multiline content cannot masquerade as model metadata',()=>fixture((home,write)=>{
  write('.codex/config.toml','model = "real-model"\nnotes = """\nmodel = "fake-model"\n[profiles.fake]\nmodel = "fake-profile"\n"""\n[profiles.real]\nmodel = "real-profile"\n');
  const found=discoverConfiguration({home,env:{PATH:''},platform:'linux'});
  assert.deepEqual(found.models.map(m=>m.model),['real-model','real-profile']);
}));

test('a valid config without an explicit model is not a parse failure and unrelated environment secrets are never accessed',()=>fixture((home,write)=>{
  write('.codex/config.toml','approval_policy = "on-request"\nsandbox_mode = "read-only"\n');
  const env: NodeJS.ProcessEnv={PATH:''};
  Object.defineProperty(env,'OPENAI_API_KEY',{enumerable:true,get:()=>{throw new Error('Secret was accessed');}});
  const found=discoverConfiguration({home,env,platform:'linux'});
  assert.deepEqual(found.models,[]);
  assert.deepEqual(found.warnings,[]);
}));
