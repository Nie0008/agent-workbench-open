import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/main/store';
import { CredentialManager } from '../src/main/credentials';
import { TaskService } from '../src/main/taskService';

test('model catalog persists multiple models per credential for several agents without storing the token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-model-catalog-'));
  const ccPath = path.join(root, 'cc.db');
  const wbPath = path.join(root, 'wb.db');
  const token = 'CATALOG_TEST_SECRET_NEVER_STORE';
  const cc = new DatabaseSync(ccPath);
  cc.exec('CREATE TABLE providers(id TEXT PRIMARY KEY,app_type TEXT,name TEXT,settings_config TEXT,is_current INTEGER,sort_index INTEGER)');
  const writeSource = (baseUrl: string, key = token) => cc.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET settings_config=excluded.settings_config')
    .run('shared-source', 'claude', 'Shared source', JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: 'first-model', ANTHROPIC_AUTH_TOKEN: key,
    } }), 1, 0);
  writeSource('https://open.bigmodel.cn/api/anthropic');
  let store = new Store(wbPath);
  let service = new TaskService(store, new CredentialManager(ccPath, { ttlMs: 0 }), () => []);
  try {
    const project = service.createProject(root);
    const profile = service.saveModelProfile({ name: 'Second model', providerId: 'shared-source',
      model: 'second-model', agents: ['claude-code', 'grok', 'dsh', 'zcode'], reasoningLevel: 'max' });
    service.saveModelProfile({ name: 'Bracket model', providerId: 'shared-source',
      model: 'vision-exp[1M]', agents: ['claude-code'] });
    assert.ok(service.agentOptions().combinations.filter((c) => c.model === 'second-model').length === 4);
    const task = service.createMainSession({ projectId: project.id, title: 'Second model task',
      agentId: 'zcode', providerId: 'shared-source', model: 'second-model' });
    assert.equal((service as any).buildEnv(task).ANTHROPIC_MODEL, 'second-model');
    assert.equal(store.countOccurrences(token), 0);
    service.shutdown(); store.close();
    store = new Store(wbPath);
    service = new TaskService(store, new CredentialManager(ccPath, { ttlMs: 0 }), () => []);
    assert.equal(service.modelCatalog.find('shared-source', 'second-model')?.id, profile.id);
    assert.equal(service.resolveSessionProvider(task.id).ok, true);
    writeSource('https://open.bigmodel.cn/api/anthropic', 'ROTATED_TEST_SECRET');
    assert.equal((service as any).buildEnv(task).ANTHROPIC_AUTH_TOKEN, 'ROTATED_TEST_SECRET');
    writeSource('https://changed.example/api/anthropic');
    assert.equal(service.resolveSessionProvider(task.id).ok, false);
    assert.equal(service.agentOptions().combinations.some((c) => c.model === 'second-model'), false);
    assert.equal(store.countOccurrences(token), 0);
  } finally {
    service.shutdown(); store.close(); cc.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
