// Configuration discovery never launches a CLI, reads authentication files, or
// imports credentials. Only explicitly selected model metadata leaves this module.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type AgentRole = 'controller' | 'executor';
export interface DiscoveredAgent {
  id: string; name: string; executable: string | null; configPath: string | null; roles: AgentRole[];
}
export interface DiscoveredModel {
  id: string; name: string; model: string; source: string; path: string;
  protocol: 'anthropic' | 'openai' | 'unknown'; importable: boolean; reason?: string;
}
export interface ConfigurationDiscovery { agents: DiscoveredAgent[]; models: DiscoveredModel[]; warnings: string[]; }
export interface DiscoveryOptions { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; }
export interface ExecutableOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; extraPaths?: string[]; }

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_DIRECTORIES = 32;
const credentialFile = /^(?:auth\.json|credentials(?:\.json)?|\.credentials\.json|\.env)$/i;
function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env[key]?.trim() ?? '';
  const found = Object.keys(env).find(k => k.toLowerCase() === key.toLowerCase());
  return (found ? env[found] : '')?.trim() ?? '';
}
function join(dir: string, name: string, platform: NodeJS.Platform): string {
  // Also permits temporary POSIX fixture directories for Windows PATH tests.
  return platform === 'win32' && /\\|^[A-Za-z]:/.test(dir) ? path.win32.join(dir, name) : path.join(dir, name);
}
function unquote(value: string): string { return value.startsWith('"') && value.endsWith('"') ? value.slice(1,-1) : value; }
function executableFile(candidate: string, platform: NodeJS.Platform): string | null {
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return candidate;
  } catch { return null; }
}

/** Explicit extra paths (directories or complete files) take precedence over PATH.
 * Empty PATH components do not implicitly search the working directory. */
export function findExecutable(command: string, options: ExecutableOptions = {}): string | null {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  command = command.trim();
  if (!command || command.includes('\0')) return null;
  const windows = platform === 'win32';
  const extensions = windows ? (envValue(env,'PATHEXT',platform) || '.COM;.EXE;.BAT;.CMD').split(';')
    .map(e=>e.trim()).filter(e=>/^\.[A-Za-z0-9]+$/.test(e)) : [''];
  const ext = windows ? path.win32.extname(command) : '';
  if (windows && ext && !extensions.some(e=>e.toLowerCase()===ext.toLowerCase())) return null;
  const names = windows && !ext ? extensions.map(e=>command+e) : [command];
  const check = (candidate: string): string | null => {
    const exact = executableFile(candidate,platform);
    if (exact || !windows) return exact;
    const parts = /\\|^[A-Za-z]:/.test(candidate) ? path.win32 : path;
    try {
      const wanted = parts.basename(candidate).toLowerCase();
      const actual = fs.readdirSync(parts.dirname(candidate)).slice(0,1000).find(n=>n.toLowerCase()===wanted);
      return actual ? executableFile(parts.join(parts.dirname(candidate),actual),platform) : null;
    } catch { return null; }
  };
  if (/[\\/]/.test(command)) { for (const name of names) { const found=check(name); if(found)return found; } return null; }
  for (const extra of options.extraPaths ?? []) {
    if (!extra) continue;
    try {
      if (fs.statSync(extra).isFile()) {
        const extraExt=path.win32.extname(extra);
        if (!windows || extensions.some(e=>e.toLowerCase()===extraExt.toLowerCase())) { const found=check(extra); if(found)return found; }
        continue;
      }
    } catch { /* a missing directory may still be a PATH candidate */ }
    for (const name of names) { const found=check(join(extra,name,platform)); if(found)return found; }
  }
  for (const dir of envValue(env,'PATH',platform).split(windows ? ';' : ':').map(unquote).filter(Boolean)) {
    for (const name of names) { const found=check(join(dir,name,platform)); if(found)return found; }
  }
  return null;
}

function existsFile(file: string): boolean { try { return fs.statSync(file).isFile(); } catch { return false; } }
function directories(dir: string, warnings?: string[]): string[] {
  try {
    const all=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name));
    if(all.length>MAX_DIRECTORIES)warnings?.push(`${dir}: 只扫描前 ${MAX_DIRECTORIES} 个目录`);
    return all.slice(0,MAX_DIRECTORIES).map(e=>path.join(dir,e.name));
  } catch { return []; }
}
function configurationText(file: string, warnings: string[]): string | null {
  let fd: number | undefined;
  try {
    if (!fs.existsSync(file)) return null;
    if (credentialFile.test(path.basename(fs.realpathSync(file)))) { warnings.push(`${file}: 跳过认证文件`); return null; }
    if (!fs.statSync(file).isFile()) { warnings.push(`${file}: 配置不是普通文件`); return null; }
    fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size>MAX_CONFIG_BYTES) { warnings.push(`${file}: 配置超过 1 MiB，已跳过`); return null; }
    const buffer=Buffer.alloc(MAX_CONFIG_BYTES+1);
    let offset=0, read=0;
    do { read=fs.readSync(fd,buffer,offset,buffer.length-offset,null);offset+=read; } while(read && offset<buffer.length);
    if(offset>MAX_CONFIG_BYTES){warnings.push(`${file}: 配置超过 1 MiB，已跳过`);return null;}
    return buffer.toString('utf8',0,offset);
  } catch { warnings.push(`${file}: 无法读取配置`); return null; }
  finally { if(fd!==undefined)fs.closeSync(fd); }
}
function metadataString(value: unknown): string | null {
  return typeof value==='string' && value.trim() && value.length<=200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}
function protocol(value: unknown): DiscoveredModel['protocol'] {
  if(typeof value!=='string')return 'unknown';
  if(/^(anthropic|anthropic-messages)$/i.test(value))return 'anthropic';
  if(/^(openai|openai-completions|openai-responses|chat|responses)$/i.test(value))return 'openai';
  return 'unknown';
}
// A conservative metadata projection, not a general TOML interpreter. Unknown
// keys are skipped, including secret/header/auth definitions and commands.
function tomlMetadata(text: string): Map<string,Map<string,string>> {
  const tables=new Map<string,Map<string,string>>([['',new Map()]]);
  let table='', multiline='', sawSyntax=false;
  for(const raw of text.split(/\r?\n/)) {
    const line=raw.trim();
    if(multiline){if(line.includes(multiline))multiline='';continue;}
    if(!line || line.startsWith('#'))continue;
    const triple=line.match(/=\s*("""|''')/);
    if(triple){sawSyntax=true;if(!line.slice((triple.index??0)+triple[0].length).includes(triple[1]))multiline=triple[1];continue;}
    if(line.startsWith('[')) {
      const heading=line.match(/^\[([A-Za-z0-9_.-]+(?:\."[^"\\]+")?)\]\s*(?:#.*)?$/);
      if(!heading){table='ignored';continue;}
      sawSyntax=true;
      table=heading[1].replace(/"([^"\\]+)"/g,'$1');
      if(!tables.has(table))tables.set(table,new Map());
      continue;
    }
    const key=line.match(/^(model|model_provider|wire_api|api)\s*=\s*(.*)$/);
    if(/^[A-Za-z0-9_.-]+\s*=/.test(line))sawSyntax=true;
    if(!key)continue;
    const literal=key[2].match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/)?.[1];
    if(!literal)throw new Error('Invalid model metadata');
    const value=literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1,-1);
    const safe=metadataString(value);if(safe)tables.get(table)?.set(key[1],safe);
  }
  if(multiline)throw new Error('Unterminated configuration string');
  if(!sawSyntax && text.trim() && !text.trim().startsWith('#'))throw new Error('Invalid configuration');
  return tables;
}

export function discoverConfiguration(options: DiscoveryOptions = {}): ConfigurationDiscovery {
  const env=options.env ?? process.env, platform=options.platform ?? process.platform;
  const home=(options.home ?? (platform==='win32' ? envValue(env,'USERPROFILE',platform) : envValue(env,'HOME',platform))) || os.homedir();
  const warnings: string[]=[], models: DiscoveredModel[]=[];
  const expanded=(value:string,fallback:string)=>{ const dir=value.trim() || fallback; return dir==='~' ? home : /^~[\\/]/.test(dir) ? join(home,dir.slice(2),platform) : dir; };
  const codexHome=expanded(envValue(env,'CODEX_HOME',platform),join(home,'.codex',platform));
  const claudeHome=expanded(envValue(env,'CLAUDE_CONFIG_DIR',platform),join(home,'.claude',platform));
  const dshHome=expanded(envValue(env,'DSH_HOME',platform),join(home,'.dsh',platform));
  const grokHome=expanded(envValue(env,'GROK_HOME',platform),join(home,'.grok',platform));
  const zcodeBase=expanded(envValue(env,'ZCODE_DATA_BASE_DIR',platform),home);
  const commonBins=[join(home,'.local/bin',platform),join(home,'.npm-global/bin',platform),join(home,'.volta/bin',platform),
    ...directories(join(home,'.local',platform)).filter(d=>path.basename(d).startsWith('node-')).map(d=>join(d,'bin',platform)),
    ...directories(join(home,'.nvm/versions/node',platform)).map(d=>join(d,'bin',platform))];
  if(platform==='win32') { const appdata=envValue(env,'APPDATA',platform);if(appdata)commonBins.push(join(appdata,'npm',platform)); }
  else commonBins.push('/opt/homebrew/bin','/usr/local/bin','/usr/bin');
  const configs={codex:join(codexHome,'config.toml',platform),'claude-code':join(claudeHome,'settings.json',platform),
    dsh:join(dshHome,'cordis.patch.yml',platform),grok:join(grokHome,'config.toml',platform),
    zcode:expanded(envValue(env,'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',platform),join(zcodeBase,'.zcode/v2/provider_config.json',platform))};
  const specs: {id:keyof typeof configs;name:string;command:string;roles:AgentRole[];extra:string[]}[]=[
    {id:'codex',name:'Codex',command:'codex',roles:['controller'],extra:platform==='darwin'?['/Applications/Codex.app/Contents/Resources/codex']:[]},
    {id:'claude-code',name:'Claude Code',command:'claude',roles:['controller','executor'],extra:[envValue(env,'WORKBENCH_CLAUDE_PATH',platform)]},
    {id:'dsh',name:'DSH',command:'dsh',roles:['controller','executor'],extra:[]},
    {id:'grok',name:'Grok Build',command:'grok',roles:['executor'],extra:[join(grokHome,'bin/grok',platform)]},
    {id:'zcode',name:'ZCode',command:'zcode',roles:['executor'],extra:[envValue(env,'WORKBENCH_ZCODE_CLI',platform),...(platform==='darwin'?['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs']:[])]},
  ];
  const agents=specs.map(s=>({id:s.id,name:s.name,roles:s.roles,
    executable:findExecutable(s.command,{env,platform,extraPaths:s.extra}) ?? findExecutable(s.command,{env:{PATH:'',PATHEXT:envValue(env,'PATHEXT',platform)},platform,extraPaths:commonBins}),configPath:existsFile(configs[s.id]) ? configs[s.id] : null}));
  const add=(agent:string,file:string,model:unknown,wire:unknown='unknown',suffix='')=>{
    const selected=metadataString(model);if(!selected)return;
    const source=`${agent}${suffix ? `:${suffix}` : ''}`;
    const id=`discovery:${agent}:${createHash('sha256').update(JSON.stringify([source,file,selected])).digest('hex').slice(0,20)}`;
    if(models.some(m=>m.id===id))return;
    models.push({id,name:selected,model:selected,source,path:file,protocol:protocol(wire),importable:false,
      reason:agent==='codex' ? 'Codex 原生认证及模型来源尚未接入工作台执行器' : agent==='grok'
        ? '需验证 Grok 原生模型绑定后才能执行' : '仅发现原生配置；需绑定兼容的供应商凭据后才能执行'});
  };
  const readJson=(file:string,consume:(data:any)=>void)=>{
    const text=configurationText(file,warnings);if(text===null)return;
    try { const data=JSON.parse(text);if(!data || typeof data!=='object' || Array.isArray(data))throw new Error();consume(data); }
    catch { warnings.push(`${file}: 配置 JSON 格式无效`); }
  };
  for(const agent of ['codex','grok'] as const){
    const file=configs[agent], text=configurationText(file,warnings);if(text===null)continue;
    try {
      const tables=tomlMetadata(text);
      if(agent==='codex')for(const [section,values]of tables){
        if(section && !/^profiles\.[A-Za-z0-9_.-]+$/.test(section))continue;
        const provider=values.get('model_provider') ?? tables.get('')?.get('model_provider') ?? 'openai';
        add(agent,file,values.get('model'),tables.get(`model_providers.${provider}`)?.get('wire_api') ?? (provider==='openai'?'responses':'unknown'),section);
      } else for(const [section,values]of tables)if(section.startsWith('model.'))add(agent,file,section.slice(6),values.get('api'));
    } catch { warnings.push(`${file}: 配置 TOML 模型字段无法解析`); }
  }
  readJson(configs['claude-code'],data=>{
    add('claude-code',configs['claude-code'],data.model,'anthropic');
    for(const key of ['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL'])
      add('claude-code',configs['claude-code'],data.env?.[key],'anthropic');
  });
  // DSH patch composition depends on profile bundles. Recognize only simple
  // explicit acp/agent-default-model overrides; aliases/tags/inline YAML stay unexecuted.
  const dshFiles=[configs.dsh,...directories(join(dshHome,'profiles',platform),warnings).map(d=>join(d,'cordis.patch.yml',platform))];
  for(const file of dshFiles){
    const text=configurationText(file,warnings);if(text===null)continue;
    let active=false,found=false;
    for(const line of text.split(/\r?\n/)){
      const entry=line.match(/^\s*-\s+id:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*(?:#.*)?$/);
      if(entry){active=['acp','agent-default-model'].includes(entry[1]);continue;}
      if(!active)continue;
      const model=line.match(/^\s+model:\s*(?:"([^"\\]*)"|'([^']*)'|([^\s#{}\[\]&*!]+))\s*(?:#.*)?$/);
      if(model){add('dsh',file,model[1]??model[2]??model[3]);found=true;}
    }
    if(!found && text.trim())warnings.push(`${file}: DSH 配置需组合 profile，本次未解析出明确模型`);
  }
  readJson(configs.zcode,data=>{
    const config=data.config ?? data;
    const selection=config.defaultModelSelection;
    add('zcode',configs.zcode,selection?.modelId,'unknown');
    for(const rule of Array.isArray(config.modelConfigRules?.providerModelRules) ? config.modelConfigRules.providerModelRules.slice(0,200) : [])
      add('zcode',configs.zcode,rule?.modelId,'unknown');
  });
  return {agents,models,warnings};
}
