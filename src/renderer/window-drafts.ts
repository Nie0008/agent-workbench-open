import type { ModelAgentId, ModelProfile } from '../shared/types';

export type ModelDraft = Omit<ModelProfile, 'id' | 'sourceFingerprint'> & { id?: string };
export interface SourceDraft {
  providerId?: string;
  name: string;
  baseUrl: string;
  model: string;
  authMode: 'api_key' | 'auth_token';
}

const modelAgentIds = new Set<ModelAgentId>(['claude-code', 'grok', 'dsh', 'zcode']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// Rebuild only the fields used by these forms. A restored object must never carry
// a credential field into the next window checkpoint or into a save request.
export function projectModelDraft(value: unknown): ModelDraft | null {
  if (!record(value) || typeof value.name !== 'string' || typeof value.model !== 'string'
    || typeof value.providerId !== 'string' || !Array.isArray(value.agents)) return null;
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    name: value.name,
    providerId: value.providerId,
    model: value.model,
    agents: value.agents.filter((id): id is ModelAgentId => typeof id === 'string' && modelAgentIds.has(id as ModelAgentId)),
    ...(typeof value.reasoningLevel === 'string' ? { reasoningLevel: value.reasoningLevel } : {}),
  };
}

export function projectSourceDraft(value: unknown): SourceDraft | null {
  if (!record(value) || typeof value.name !== 'string' || typeof value.baseUrl !== 'string'
    || typeof value.model !== 'string' || !['api_key', 'auth_token'].includes(String(value.authMode))) return null;
  return {
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    name: value.name,
    baseUrl: value.baseUrl,
    model: value.model,
    authMode: value.authMode as SourceDraft['authMode'],
  };
}

export function projectWindowDraft(key: string, value: unknown): unknown {
  if (key === 'models.draft' || key === 'newTask.models.draft') return projectModelDraft(value);
  if (key === 'models.sourceDraft' || key === 'newTask.models.sourceDraft') return projectSourceDraft(value);
  return value;
}

export function projectWindowDrafts(value: unknown): Record<string, unknown> {
  if (!record(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, draft]) => [key, projectWindowDraft(key, draft)]));
}
