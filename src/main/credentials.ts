// 凭据只在主进程解密或从 CC Switch 读取；renderer 只收到来源元数据。
import { DatabaseSync } from 'node:sqlite';
import * as crypto from 'node:crypto';
import type { ProviderInfo } from '../shared/types';
import type { Store } from './store';

const CC_SWITCH_DB = `${process.env.HOME}/.cc-switch/cc-switch.db`;

const NON_SENSITIVE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'API_TIMEOUT_MS',
] as const;

const SECRET_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
const LOCAL_PREFIX = 'workbench-local:';
const LOCAL_KEY = 'credentialSources.v1';

interface Vault {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface LocalSource { providerId: string; name: string; baseUrl: string; model: string; encryptedKey: string; authMode: 'api_key' | 'auth_token'; baseEnv?: Record<string, string>; importedFromCcSwitchId?: string }
export interface LocalSourceInput { providerId?: string; name: string; baseUrl: string; model: string; apiKey?: string; authMode?: 'api_key' | 'auth_token' }

interface ResolvedEnv {
  base: Record<string, string>;   // 非敏感
  secret: Record<string, string>; // 敏感：仅进入子进程 env
}

function readProviderEnv(dbPath: string, providerId: string): ResolvedEnv | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row: any = db.prepare("SELECT settings_config FROM providers WHERE id=? AND app_type='claude'").get(providerId);
    if (!row) return null;
    const sc = JSON.parse(row.settings_config);
    const envs: any[] = [];
    if (sc && typeof sc === 'object') {
      if (sc.env && typeof sc.env === 'object') envs.push(sc.env);
      if (sc.settings && typeof sc.settings === 'object' && sc.settings.env && typeof sc.settings.env === 'object') envs.push(sc.settings.env);
    }
    const base: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const env of envs) {
      for (const k of NON_SENSITIVE_ENV_KEYS) {
        if (typeof env[k] === 'string' && env[k]) base[k] = env[k];
      }
      for (const k of SECRET_ENV_KEYS) {
        if (typeof env[k] === 'string' && env[k]) secret[k] = env[k];
      }
    }
    return { base, secret };
  } finally {
    db.close();
  }
}

export class CredentialManager {
  private cache = new Map<string, { at: number; env: ResolvedEnv | null }>();
  private ttlMs: number;

  // ccSwitchDb 可注入（测试用临时库）；ttlMs=0 供测试即时感知凭据轮换/删除
  constructor(private ccSwitchDb: string = CC_SWITCH_DB,
              opts?: { ttlMs?: number; store?: Store; vault?: Vault }) {
    this.ttlMs = opts?.ttlMs ?? 30_000;
    this.store = opts?.store;
    this.vault = opts?.vault;
  }
  private store?: Store;
  private vault?: Vault;

  private localSources(): LocalSource[] {
    const raw = this.store?.getKV(LOCAL_KEY);
    if (!raw) return [];
    try {
      const rows = JSON.parse(raw);
      if (Array.isArray(rows)) return rows;
    } catch { /* invalid record */ }
    throw new Error('本地凭据记录损坏，已停止写入以保护现有 key');
  }

  saveLocalSource(input: LocalSourceInput, imported?: { sourceId: string; baseEnv: Record<string, string> }): ProviderInfo {
    if (!this.store || !this.vault?.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API key');
    const name = String(input.name ?? '').trim();
    const model = String(input.model ?? '').trim();
    const key = String(input.apiKey ?? '').trim();
    const authMode = input.authMode ?? 'api_key';
    if (authMode !== 'api_key' && authMode !== 'auth_token') throw new Error('凭据类型无效');
    let url: URL;
    try { url = new URL(String(input.baseUrl ?? '')); } catch { throw new Error('请输入有效的 HTTPS API 地址'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash)
      throw new Error('API 地址必须是无账号、参数和片段的 HTTPS 地址');
    if (!name || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:/+@\[\]-]{0,127}$/.test(model))
      throw new Error('请输入有效的来源名称和模型 ID');
    if (key && (key.length > 4096 || /[\x00-\x1f\x7f]/.test(key))) throw new Error('API key 格式无效');
    const rows = this.localSources();
    const index = rows.findIndex((row) => row.providerId === input.providerId);
    if (input.providerId && (!input.providerId.startsWith(LOCAL_PREFIX) || index < 0)) throw new Error('本地凭据来源不存在');
    if (index >= 0 && rows[index].baseUrl !== url.toString().replace(/\/$/, ''))
      throw new Error('已绑定来源不能更换 API 地址；请新增凭据来源');
    if (!key && index < 0) throw new Error('新增来源需要 API key');
    const providerId = input.providerId ?? `${LOCAL_PREFIX}${crypto.randomUUID()}`;
    let encryptedKey = index >= 0 ? rows[index].encryptedKey : '';
    if (key) {
      try { encryptedKey = this.vault.encryptString(key).toString('base64'); }
      catch { throw new Error('API key 加密失败，未保存'); }
    }
    const source: LocalSource = { providerId, name, baseUrl: url.toString().replace(/\/$/, ''), model, encryptedKey, authMode,
      ...(imported ? { importedFromCcSwitchId: imported.sourceId, baseEnv: imported.baseEnv }
        : index >= 0 ? { importedFromCcSwitchId: rows[index].importedFromCcSwitchId, baseEnv: rows[index].baseEnv } : {}) };
    if (index >= 0) rows[index] = source; else rows.push(source);
    this.store.setKV(LOCAL_KEY, JSON.stringify(rows));
    this.cache.delete(providerId);
    return { providerId, name, baseUrl: source.baseUrl, model, authMode,
      importedFromCcSwitchId: source.importedFromCcSwitchId, isCurrent: false };
  }

  importCcSwitchSource(providerId: string): ProviderInfo {
    const original = this.listProviderInfos().find((item) => item.providerId === providerId && !item.providerId.startsWith(LOCAL_PREFIX));
    const env = original && readProviderEnv(this.ccSwitchDb, providerId);
    if (!original || !env?.base.ANTHROPIC_BASE_URL || !env.base.ANTHROPIC_MODEL)
      throw new Error('CC Switch 来源不可用或缺少 API 地址、模型 ID');
    const authMode = env.secret.ANTHROPIC_AUTH_TOKEN ? 'auth_token' : 'api_key';
    const apiKey = env.secret.ANTHROPIC_AUTH_TOKEN || env.secret.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('CC Switch 来源缺少 API key');
    const existing = this.localSources().find((item) => item.importedFromCcSwitchId === providerId);
    return this.saveLocalSource({ providerId: existing?.providerId, name: original.name,
      baseUrl: env.base.ANTHROPIC_BASE_URL, model: env.base.ANTHROPIC_MODEL, apiKey, authMode },
      { sourceId: providerId, baseEnv: env.base });
  }

  deleteLocalSource(providerId: string): void {
    if (!this.store || !providerId.startsWith(LOCAL_PREFIX)) throw new Error('本地凭据来源不存在');
    const rows = this.localSources();
    const next = rows.filter((row) => row.providerId !== providerId);
    if (next.length === rows.length) throw new Error('本地凭据来源不存在');
    this.store.setKV(LOCAL_KEY, JSON.stringify(next));
    this.cache.delete(providerId);
  }

  // 组装子进程 env：普通变量 + 凭据。结果只给 spawn，不落日志。
  buildSessionEnv(providerId: string, extra?: Record<string, string>): Record<string, string> | null {
    const env = this.resolve(providerId);
    if (!env || Object.keys(env.secret).length === 0) return null;
    const inherited = { ...process.env } as Record<string, string>;
    for (const key of SECRET_ENV_KEYS) delete inherited[key];
    return { ...inherited, ...env.base, ...env.secret, ...(extra ?? {}) };
  }

  resolve(providerId: string): ResolvedEnv | null {
    const hit = this.cache.get(providerId);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.env;
    let env: ResolvedEnv | null;
    if (providerId.startsWith(LOCAL_PREFIX)) {
      const row = this.localSources().find((item) => item.providerId === providerId);
      try {
        const key = row && this.vault?.isEncryptionAvailable()
          ? this.vault.decryptString(Buffer.from(row.encryptedKey, 'base64')) : '';
        env = row && key ? { base: { ...row.baseEnv, ANTHROPIC_BASE_URL: row.baseUrl, ANTHROPIC_MODEL: row.model },
          secret: { [row.authMode === 'auth_token' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: key } } : null;
      } catch { env = null; }
    } else env = readProviderEnv(this.ccSwitchDb, providerId);
    this.cache.set(providerId, { at: now, env });
    return env;
  }

  // 仅非敏感字段：供应商列表（供设置页/组合选择展示）
  listProviderInfos(): ProviderInfo[] {
    let db: DatabaseSync | null = null;
    const out: ProviderInfo[] = [];
    try { db = new DatabaseSync(this.ccSwitchDb, { readOnly: true }); } catch { /* optional source */ }
    try {
      const rows: any[] = db?.prepare("SELECT id,name,settings_config,is_current FROM providers WHERE app_type='claude' ORDER BY sort_index").all() ?? [];
      for (const r of rows) {
        try {
          const env = readProviderEnv(this.ccSwitchDb, r.id);
          if (!env || Object.keys(env.secret).length === 0) continue; // 无凭据的供应商不显示为可用
          out.push({
            providerId: r.id,
            name: r.name,
            baseUrl: env.base['ANTHROPIC_BASE_URL'] ?? '',
            model: env.base['ANTHROPIC_MODEL'] ?? '',
            isCurrent: !!r.is_current,
          });
        } catch { /* 跳过解析失败的供应商，不输出其内容 */ }
      }
    } catch { /* CC Switch 缺失或库不可读时，本地来源仍可使用 */ }
    finally { db?.close(); }
    try {
      for (const row of this.localSources()) {
        if (this.resolve(row.providerId)) out.push({ providerId: row.providerId, name: row.name,
          baseUrl: row.baseUrl, model: row.model, authMode: row.authMode ?? 'api_key',
          importedFromCcSwitchId: row.importedFromCcSwitchId, isCurrent: false });
      }
    } catch { /* malformed local sources cannot be used or overwritten */ }
    return out;
  }
}
