import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CredentialManager } from '../src/main/credentials';
import { Store } from '../src/main/store';
import { TaskService } from '../src/main/taskService';
import { grokSuperConfigAvailable, listGrokConfigProviders } from '../src/main/grok-models';
import type { ProviderInfo } from '../src/shared/types';

test('Workbench catalog shares configured models across local agents and rejects unconfigured routes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-external-registration-'));
  const cc = path.join(root, 'cc.db');
  const db = new DatabaseSync(cc);
  db.exec('CREATE TABLE providers(id TEXT PRIMARY KEY,app_type TEXT,name TEXT,settings_config TEXT,is_current INTEGER,sort_index INTEGER)');
  const insert = db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)');
  insert.run('good', 'claude', 'Zhipu', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_MODEL: 'glm-5.3-flash', ANTHROPIC_AUTH_TOKEN: 'FAKE_KEY' } }), 1, 0);
  insert.run('wrong', 'claude', 'Other', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.invalid/api', ANTHROPIC_MODEL: 'glm-5.3-flash', ANTHROPIC_AUTH_TOKEN: 'FAKE_KEY' } }), 0, 1);
  db.close();
  const store = new Store(path.join(root, 'wb.db'));
  const configured: ProviderInfo = { providerId: 'grok-config:grok-4.6:0123456789abcdef',
    name: 'Grok 配置 grok-4.6', baseUrl: '', model: 'grok-4.6', isCurrent: false };
  let configuredProviders = [configured];
  const service = new TaskService(store, new CredentialManager(cc, { ttlMs: 0 }), () => configuredProviders);
  service.importModelProfiles(); // Explicit synthetic setup.
  try {
    const project = service.createProject(root);
    const ids = service.adapters().map((adapter) => adapter.id);
    for (const agentId of ['claude-code', 'grok', 'dsh', 'zcode']) assert.ok(ids.includes(agentId), `${agentId} missing`);
    for (const agentId of ['grok', 'dsh', 'zcode']) {
      const session = service.createMainSession({ projectId: project.id, title: agentId, agentId, providerId: 'good' });
      assert.equal((service as any).adapterFor(session).id, agentId);
      assert.equal(session.providerId, 'good');
      assert.equal(session.model, 'glm-5.3-flash');
      if (agentId === 'grok') assert.throws(() => service.createMainSession({ projectId: project.id, title: 'wrong', agentId, providerId: 'wrong' }), /组合无效/);
      assert.throws(() => service.createMainSession({ projectId: project.id, title: 'wrong model', agentId, providerId: 'good', model: 'other' }), /组合无效/);
    }
    const second = service.saveModelProfile({ name: 'Second model', providerId: 'good', model: 'other',
      agents: ['claude-code', 'grok', 'dsh', 'zcode'] });
    assert.equal(service.modelCatalog.find('good', 'other')?.id, second.id);
    for (const agentId of ['claude-code', 'grok', 'dsh', 'zcode']) {
      const other = service.createMainSession({ projectId: project.id, title: `configured ${agentId}`,
        agentId, providerId: 'good', model: 'other' });
      assert.equal(other.model, 'other');
      assert.equal(service.resolveSessionProvider(other.id).ok, true);
    }
    const native = service.createMainSession({ projectId: project.id, title: 'Grok Super',
      agentId: 'grok', providerId: 'grok-super-oauth', model: 'grok-4.7' });
    assert.equal(native.providerId, 'grok-super-oauth');
    assert.equal(native.model, 'grok-4.7');
    assert.equal(service.resolveSessionProvider(native.id).ok, true);
    assert.equal((service as any).buildEnv(native).GROK_HOME, path.join(os.homedir(), '.grok'));
    assert.throws(() => service.createMainSession({ projectId: project.id, title: 'bad native',
      agentId: 'grok', providerId: 'grok-super-oauth', model: 'glm-5.3-flash' }), /组合无效/);
    assert.throws(() => service.createMainSession({ projectId: project.id, title: 'bad agent',
      agentId: 'dsh', providerId: 'grok-super-oauth', model: 'grok-4.7' }), /不可用|组合无效/);
    const combos = service.agentOptions().combinations;
    assert.ok(combos.some((combo) => combo.agentId === 'grok' && combo.providerId === 'grok-super-oauth' && combo.model === 'grok-4.7'));
    assert.ok(combos.some((combo) => combo.agentId === 'grok' && combo.providerId === configured.providerId && combo.model === configured.model));
    assert.equal(combos.some((combo) => combo.agentId === 'dsh' && combo.providerId === 'grok-super-oauth'), false);
    assert.equal(combos.some((combo) => combo.agentId === 'dsh' && combo.providerId === configured.providerId), false);
    const custom = service.createMainSession({ projectId: project.id, title: 'configured model',
      agentId: 'grok', providerId: configured.providerId, model: configured.model });
    assert.equal(service.resolveSessionProvider(custom.id).ok, true);
    service.setDefaultTaskCombo('grok', configured.providerId, configured.model);
    assert.deepEqual(service.agentOptions().defaultTaskCombo,
      { agentId: 'grok', profileId: service.modelCatalog.find(configured.providerId, configured.model)?.id,
        providerId: configured.providerId, model: configured.model });
    const defaulted = service.createMainSession({ projectId: project.id, title: 'uses saved Grok default', agentId: 'grok' });
    assert.equal(defaulted.providerId, configured.providerId);
    assert.equal(defaulted.model, configured.model);
    service.createMainSession({ projectId: project.id, title: 'one-time GLM', agentId: 'grok', providerId: 'good' });
    const stillDefaulted = service.createMainSession({ projectId: project.id, title: 'saved default persists', agentId: 'grok' });
    assert.equal(stillDefaulted.providerId, configured.providerId);
    configuredProviders = [{ ...configured, providerId: 'grok-config:grok-4.6:fedcba9876543210' }];
    assert.equal(service.resolveSessionProvider(custom.id).ok, false);
    assert.throws(() => service.createMainSession({ projectId: project.id, title: 'stale default', agentId: 'grok' }), /不可用/);
    assert.throws(() => service.createMainSession({ projectId: project.id, title: 'unknown', agentId: 'unknown', providerId: 'good' }), /未接入/);
  } finally {
    service.shutdown();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Grok catalog keeps an existing model binding when another model is added', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-grok-catalog-'));
  const file = path.join(root, 'config.toml');
  const catalog = () => listGrokConfigProviders({ grokHome: root,
    listModels: () => 'Available models:\n  * grok-4.7 (default)\n  - glm-5.3-flash\n  - grok-4.6\n' });
  try {
    fs.writeFileSync(file, '[auth_provider.glm]\ncommand = "token-helper"\n[model."glm-5.3-flash"]\nmodel = "glm-5.3-flash"\nbase_url = "https://a.invalid"\nauth_provider = "glm"\n');
    const first = catalog();
    assert.deepEqual(first.map((p) => p.model), ['glm-5.3-flash', 'grok-4.6']);
    assert.equal(grokSuperConfigAvailable(root), true);
    fs.appendFileSync(file, '[model."new-model"]\nmodel = "new-model"\n');
    assert.equal(catalog()[0].providerId, first[0].providerId);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('https://a.invalid', 'https://b.invalid'));
    assert.notEqual(catalog()[0].providerId, first[0].providerId);
    fs.appendFileSync(file, '[model."grok-4.7"]\nmodel = "other"\n');
    assert.equal(grokSuperConfigAvailable(root), false);
    assert.ok(catalog().some((p) => p.model === 'grok-4.7'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
