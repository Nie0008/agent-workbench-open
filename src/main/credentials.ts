// 凭据管理：仅在后端定向读取 CC Switch 本地库，永不打印/入库/入日志/进 renderer。
// 只提取白名单 env 字段；对外仅暴露非敏感信息（名称、base_url、模型 ID）。
import { DatabaseSync } from 'node:sqlite';
import type { ProviderInfo } from '../shared/types';

const CC_SWITCH_DB = `${process.env.HOME}/.cc-switch/cc-switch.db`;

const NON_SENSITIVE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'API_TIMEOUT_MS',
] as const;

const SECRET_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

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
  constructor(private ccSwitchDb: string = CC_SWITCH_DB, opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 30_000;
  }

  // 组装子进程 env：普通变量 + 凭据。结果只给 spawn，不落日志。
  buildSessionEnv(providerId: string, extra?: Record<string, string>): Record<string, string> | null {
    const env = this.resolve(providerId);
    if (!env || Object.keys(env.secret).length === 0) return null;
    return { ...process.env, ...env.base, ...env.secret, ...(extra ?? {}) } as Record<string, string>;
  }

  resolve(providerId: string): ResolvedEnv | null {
    const hit = this.cache.get(providerId);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.env;
    const env = readProviderEnv(this.ccSwitchDb, providerId);
    this.cache.set(providerId, { at: now, env });
    return env;
  }

  // 仅非敏感字段：供应商列表（供设置页/组合选择展示）
  listProviderInfos(): ProviderInfo[] {
    let db: DatabaseSync;
    try { db = new DatabaseSync(this.ccSwitchDb, { readOnly: true }); } catch { return []; }
    try {
      const rows: any[] = db.prepare("SELECT id,name,settings_config,is_current FROM providers WHERE app_type='claude' ORDER BY sort_index").all();
      const out: ProviderInfo[] = [];
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
      return out;
    } finally { db.close(); }
  }
}
