import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ProviderInfo } from '../shared/types';

// A named binding keeps OAuth tasks separate from CC Switch tasks in storage.
export const GROK_SUPER_PROVIDER_ID = 'grok-super-oauth';
export const GROK_SUPER_MODEL = 'grok-4.7';

export const GROK_SUPER_PROVIDER: ProviderInfo = {
  providerId: GROK_SUPER_PROVIDER_ID,
  name: 'Grok Super 登录',
  baseUrl: '',
  model: GROK_SUPER_MODEL,
  isCurrent: false,
};

export function isGrokSuperBinding(agentId: string, providerId: string, model: string): boolean {
  return agentId === 'grok' && providerId === GROK_SUPER_PROVIDER_ID && model === GROK_SUPER_MODEL;
}

export const GROK_CONFIG_PROVIDER_PREFIX = 'grok-config:';

export function isGrokConfigProviderId(providerId: string): boolean {
  return providerId.startsWith(GROK_CONFIG_PROVIDER_PREFIX);
}

export function grokConfigModelFromId(providerId: string): string | null {
  const match = providerId.match(/^grok-config:([^:]+):[0-9a-f]{16}$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); }
  catch { return null; }
}

function modelTables(config: string): Map<string, string> {
  const tables = new Map<string, string>();
  let heading = '';
  let body: string[] = [];
  const flush = () => { if (heading) tables.set(heading, body.join('\n').trimEnd()); };
  for (const line of config.split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
    if (match) { flush(); heading = match[1].replace(/"([^"\\]*)"/g, '$1'); body = []; }
    else body.push(line);
  }
  flush();
  return tables;
}

function modelFingerprint(model: string, tables: Map<string, string>): string {
  const definition = tables.get(`model.${model}`) ?? '';
  const authName = definition.match(/^\s*auth_provider\s*=\s*["']([^"']+)["']/m)?.[1];
  const authDefinition = authName ? tables.get(`auth_provider.${authName}`) ?? '' : '';
  return crypto.createHash('sha256').update(JSON.stringify([model, definition, authDefinition]))
    .digest('hex').slice(0, 16);
}

export function grokSuperConfigAvailable(grokHome = path.join(os.homedir(), '.grok')): boolean {
  try {
    const tables = modelTables(fs.readFileSync(path.join(grokHome, 'config.toml'), 'utf8'));
    return !tables.has(`model.${GROK_SUPER_MODEL}`);
  } catch { return true; }
}

export function grokNativeEnv(grokHome = path.join(os.homedir(), '.grok')): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key === 'XAI_API_KEY' || key === 'GROK_DEPLOYMENT_KEY' || key === 'GROK_CLI_CHAT_PROXY_BASE_URL'
      || key.startsWith('ANTHROPIC_') || key.startsWith('ZHIPU_') || key === 'WORKBENCH_GLM_KEY') delete env[key];
  }
  env.GROK_HOME = grokHome;
  env.GROK_SUBAGENTS = '0';
  env.GROK_AGENT_DASHBOARD = '0';
  return env;
}

let cachedCatalog: { key: string; until: number; providers: ProviderInfo[] } | null = null;

// Grok's own catalog is the source for models added later through CC Switch or
// ~/.grok/config.toml. Per-model fingerprints keep existing sessions usable
// when an unrelated model is added, while rejecting endpoint/auth changes.
export function listGrokConfigProviders(options: {
  grokHome?: string;
  grokBinary?: string;
  listModels?: () => string;
  refresh?: boolean;
} = {}): ProviderInfo[] {
  const grokHome = options.grokHome ?? path.join(os.homedir(), '.grok');
  const grokBinary = options.grokBinary ?? path.join(grokHome, 'bin', 'grok');
  let config = '';
  try { config = fs.readFileSync(path.join(grokHome, 'config.toml'), 'utf8'); }
  catch { /* built-in models can run without a user config */ }
  const tables = modelTables(config);
  const key = `${grokHome}:${grokBinary}:${crypto.createHash('sha256').update(config).digest('hex')}`;
  if (!options.refresh && !options.listModels && cachedCatalog?.key === key && cachedCatalog.until > Date.now())
    return cachedCatalog.providers;
  let output: string;
  try {
    output = options.listModels?.() ?? execFileSync(grokBinary, ['models'], {
      cwd: os.tmpdir(), encoding: 'utf8', timeout: 8_000,
      env: grokNativeEnv(grokHome),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return []; }
  const modelIds = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(/^\s*[-*]\s+([A-Za-z0-9][A-Za-z0-9._:/-]*)/);
    if (match && (match[1] !== GROK_SUPER_MODEL || tables.has(`model.${GROK_SUPER_MODEL}`))) modelIds.add(match[1]);
  }
  const providers = [...modelIds].map((model): ProviderInfo => ({
    providerId: `${GROK_CONFIG_PROVIDER_PREFIX}${encodeURIComponent(model)}:${modelFingerprint(model, tables)}`,
    name: `Grok 配置 ${model}`,
    baseUrl: '',
    model,
    isCurrent: false,
  }));
  if (!options.listModels) cachedCatalog = { key, until: Date.now() + 30_000, providers };
  return providers;
}
