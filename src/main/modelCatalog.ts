import * as crypto from 'node:crypto';
import type { ProviderInfo, ModelProfile, ModelAgentId } from '../shared/types';
import type { Store } from './store';
import type { CredentialManager } from './credentials';
import { GROK_SUPER_PROVIDER, GROK_SUPER_PROVIDER_ID, isGrokConfigProviderId } from './grok-models';

export const MODEL_CATALOG_KEY = 'modelCatalog.v1';
export const AGENT_IDS = ['claude-code', 'grok', 'dsh', 'zcode'] as const;
// The catalog contains routing metadata only. Local API keys are stored separately
// as OS-encrypted ciphertext; CC Switch and Grok credentials stay in their sources.

export interface ModelProfileInput extends Omit<ModelProfile, 'id' | 'sourceFingerprint'> { id?: string }

function fingerprint(source: ProviderInfo): string {
  return crypto.createHash('sha256').update(source.baseUrl).digest('hex');
}

function validate(input: ModelProfileInput): ModelProfileInput {
  const name = String(input.name ?? '').trim();
  const providerId = String(input.providerId ?? '').trim();
  const model = String(input.model ?? '').trim();
  const agents = [...new Set(input.agents ?? [])];
  const reasoningLevel = String(input.reasoningLevel ?? '').trim();
  if (!name || name.length > 100) throw new Error('模型名称需为 1–100 个字符');
  if (!providerId || providerId.length > 200) throw new Error('请选择凭据来源');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+@\[\]-]{0,127}$/.test(model)) throw new Error('模型 ID 格式无效');
  if (!agents.length || agents.some((id) => !AGENT_IDS.includes(id))) throw new Error('请选择至少一个可用 Agent');
  if (reasoningLevel && !/^[a-z0-9_-]{1,30}$/i.test(reasoningLevel)) throw new Error('思考级别格式无效');
  if ((providerId === GROK_SUPER_PROVIDER_ID || isGrokConfigProviderId(providerId)) && agents.some((id) => id !== 'grok'))
    throw new Error('Grok 登录或 Grok 配置仅能供 Grok Build 使用');
  if (providerId === 'native:claude' && agents.some(id => id !== 'claude-code'))
    throw new Error('Claude Code 原生凭据当前仅供 Claude Code 执行器使用');
  return { name, providerId, model, agents, ...(reasoningLevel ? { reasoningLevel } : {}) };
}

export class ModelCatalog {
  constructor(private store: Store, private credentials: CredentialManager,
    private grokProviders: () => ProviderInfo[]) {}

  private read(): ModelProfile[] | null {
    const raw = this.store.getKV(MODEL_CATALOG_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('模型目录损坏：需要数组');
    return value as ModelProfile[];
  }

  list(): ModelProfile[] {
    // Discovery is read-only. A fresh installation imports only after consent.
    return this.read() ?? [];
  }

  importAvailable(sourceIds?: string[]): { added: number; profiles: ModelProfile[] } {
    const profiles = this.list();
    const sources = [...this.credentials.listProviderInfos(), GROK_SUPER_PROVIDER, ...this.grokProviders()];
    let added = 0;
    for (const source of sources) {
      if (sourceIds && !sourceIds.includes(source.providerId)) continue;
      if (!source.model || profiles.some((p) => p.providerId === source.providerId && p.model === source.model)) continue;
      const native = source.providerId === GROK_SUPER_PROVIDER_ID || isGrokConfigProviderId(source.providerId);
      const zhipu = source.baseUrl.replace(/\/$/, '') === 'https://open.bigmodel.cn/api/anthropic';
      profiles.push({ id: crypto.randomUUID(), name: source.name, providerId: source.providerId,
        model: source.model, agents: native ? ['grok'] : source.providerId === 'native:claude' ? ['claude-code'] : zhipu ? [...AGENT_IDS] : ['claude-code', 'dsh', 'zcode'],
        sourceFingerprint: fingerprint(source),
        ...(source.model === 'glm-5.3-flash' && !native ? { reasoningLevel: 'max' } : {}) });
      added++;
    }
    if (added) this.store.setKV(MODEL_CATALOG_KEY, JSON.stringify(profiles));
    return { added, profiles };
  }

  save(input: ModelProfileInput): ModelProfile {
    const item = validate(input);
    const profiles = this.list();
    const source = this.sourceInfo(item.providerId);
    if (!source) throw new Error('凭据来源已不可用；请检查 Workbench 本地凭据、CC Switch 或 Grok 配置');
    if (item.providerId === GROK_SUPER_PROVIDER_ID && item.model !== GROK_SUPER_PROVIDER.model
      && !this.grokProviders().some((provider) => provider.model === item.model))
      throw new Error('Grok Build 尚未列出该模型，请先确认本机 Super 登录可用');
    if (isGrokConfigProviderId(item.providerId) && item.model !== source.model)
      throw new Error('Grok 配置模型必须与其来源模型一致');
    if (item.agents.includes('grok') && item.providerId !== GROK_SUPER_PROVIDER_ID
      && !isGrokConfigProviderId(item.providerId)
      && source.baseUrl.replace(/\/$/, '') !== 'https://open.bigmodel.cn/api/anthropic')
      throw new Error('此 Anthropic 端点尚不能供 Grok Build 使用');
    const duplicate = profiles.find((p) => p.providerId === item.providerId && p.model === item.model && p.id !== input.id);
    if (duplicate) throw new Error('同一凭据来源和模型 ID 已存在');
    const index = profiles.findIndex((p) => p.id === input.id);
    if (input.id && index < 0) throw new Error('模型配置已不存在，请刷新');
    const profile: ModelProfile = { ...item, id: input.id ?? crypto.randomUUID(), sourceFingerprint: fingerprint(source) };
    if (index >= 0) profiles[index] = profile; else profiles.push(profile);
    this.store.setKV(MODEL_CATALOG_KEY, JSON.stringify(profiles));
    return profile;
  }

  remove(id: string): void {
    const profiles = this.list();
    const next = profiles.filter((p) => p.id !== id);
    if (next.length === profiles.length) throw new Error('模型配置已不存在');
    this.store.setKV(MODEL_CATALOG_KEY, JSON.stringify(next));
  }

  find(providerId: string, model: string): ModelProfile | undefined {
    return this.list().find((p) => p.providerId === providerId && p.model === model);
  }

  sourceInfo(providerId: string): ProviderInfo | undefined {
    if (providerId === GROK_SUPER_PROVIDER_ID) return GROK_SUPER_PROVIDER;
    if (isGrokConfigProviderId(providerId)) return this.grokProviders().find((p) => p.providerId === providerId);
    return this.credentials.listProviderInfos().find((p) => p.providerId === providerId);
  }

  availableProfiles(sources = this.sourceOptions()): ModelProfile[] {
    const sourceMap = new Map(sources.map((source) => [source.providerId, source]));
    return this.list().filter((profile) => {
      const source = sourceMap.get(profile.providerId);
      return !!source && (profile.sourceFingerprint === undefined || profile.sourceFingerprint === fingerprint(source));
    });
  }

  sourceOptions(): ProviderInfo[] {
    return [...this.credentials.listProviderInfos(), GROK_SUPER_PROVIDER, ...this.grokProviders()];
  }
}
