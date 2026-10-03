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

test('Workbench-owned key is encrypted at rest, reusable, and never falls back after deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-local-key-'));
  const store = new Store(path.join(root, 'wb.db'));
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) => Buffer.from(value.toString().slice(7), 'base64').toString(),
  };
  const credentials = new CredentialManager(path.join(root, 'no-cc-switch.db'), { store, vault, ttlMs: 0 });
  const service = new TaskService(store, credentials, () => []);
  try {
    const key = 'LOCAL_KEY_ONLY_IN_MEMORY';
    const source = service.saveCredentialSource({ name: 'Own API', baseUrl: 'https://example.invalid/v1',
      model: 'model-one', apiKey: key });
    assert.ok(source.providerId.startsWith('workbench-local:'));
    assert.equal(store.countOccurrences(key), 0);
    assert.ok(!JSON.stringify(service.agentOptions()).includes(key));
    assert.ok(service.agentOptions().combinations.some((item) =>
      item.providerId === source.providerId && item.model === 'model-one' && item.agentId === 'claude-code'));
    const project = service.createProject(root);
    const task = service.createMainSession({ projectId: project.id, title: 'Own key', agentId: 'claude-code',
      providerId: source.providerId, model: 'model-one' });
    assert.equal((service as any).buildEnv(task).ANTHROPIC_API_KEY, key);
    const previous = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = 'UNRELATED_INHERITED_KEY';
    try { assert.equal((service as any).buildEnv(task).ANTHROPIC_AUTH_TOKEN, undefined); }
    finally { if (previous === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = previous; }
    service.saveCredentialSource({ ...source, apiKey: 'ROTATED_LOCAL_KEY' });
    assert.equal((service as any).buildEnv(task).ANTHROPIC_API_KEY, 'ROTATED_LOCAL_KEY');
    service.saveCredentialSource({ ...source, apiKey: '', authMode: 'auth_token' });
    assert.equal((service as any).buildEnv(task).ANTHROPIC_AUTH_TOKEN, 'ROTATED_LOCAL_KEY');
    assert.throws(() => service.saveCredentialSource({ ...source, baseUrl: 'https://changed.invalid/v1' }),
      /不能更换 API 地址/);
    service.deleteCredentialSource(source.providerId);
    assert.equal(service.resolveSessionProvider(task.id).ok, false);
    assert.equal(store.countOccurrences(key), 0);
    store.setKV('credentialSources.v1', '{damaged');
    assert.throws(() => service.saveCredentialSource({ name:'Another', baseUrl:'https://example.invalid/v1',
      model:'model-two', apiKey:'FAKE_NEW_KEY' }), /记录损坏/);
    assert.equal(store.getKV('credentialSources.v1'), '{damaged');
  } finally { service.shutdown(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('CC Switch configuration is copied into Workbench without exposing the key or rebinding old tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-import-cc-'));
  const ccPath = path.join(root, 'cc.db');
  const cc = new DatabaseSync(ccPath);
  cc.exec('CREATE TABLE providers(id TEXT PRIMARY KEY,app_type TEXT,name TEXT,settings_config TEXT,is_current INTEGER,sort_index INTEGER)');
  const write = (key: string) => cc.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET settings_config=excluded.settings_config')
    .run('cc-one', 'claude', 'Fixture CC', JSON.stringify({ env: {
      ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_MODEL:'glm-5.3-flash',
      ANTHROPIC_AUTH_TOKEN:key, ANTHROPIC_DEFAULT_OPUS_MODEL:'glm-5.3-flash', API_TIMEOUT_MS:'600000',
    } }), 1, 0);
  write('IMPORT_FIXTURE_SECRET');
  const store = new Store(path.join(root, 'workbench.db'));
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) => Buffer.from(value.toString().slice(7), 'base64').toString(),
  };
  const service = new TaskService(store, new CredentialManager(ccPath, { store, vault, ttlMs:0 }), () => []);
  try {
    const project = service.createProject(root);
    service.saveModelProfile({ name:'Other model', providerId:'cc-one', model:'other-model', agents:['claude-code','dsh'] });
    service.setDefaultTaskCombo('claude-code','cc-one','other-model');
    store.setKV('defaultProviderId','cc-one');
    const oldTask = service.createMainSession({ projectId:project.id, title:'Old', agentId:'claude-code', providerId:'cc-one', model:'other-model' });
    const imported = service.importCcSwitchCredential('cc-one');
    assert.ok(!JSON.stringify(imported).includes('IMPORT_FIXTURE_SECRET'));
    assert.equal(imported.profilesCopied, 2);
    assert.equal(imported.defaultChanged, true);
    assert.equal(imported.existingTasksStillBound, 1);
    assert.equal(store.getKV('defaultProviderId'), imported.source.providerId);
    assert.equal(service.agentOptions().defaultTaskCombo?.providerId, imported.source.providerId);
    assert.equal(service.getSession(oldTask.id)?.providerId, 'cc-one');
    const newTask = service.createMainSession({ projectId:project.id, title:'New', agentId:'claude-code' });
    assert.equal(newTask.providerId, imported.source.providerId);
    assert.equal(newTask.model, 'other-model');
    const env = (service as any).buildEnv(newTask);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'IMPORT_FIXTURE_SECRET');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3-flash');
    assert.equal(env.API_TIMEOUT_MS, '600000');
    assert.equal(store.countOccurrences('IMPORT_FIXTURE_SECRET'), 0);
    write('ROTATED_IMPORT_SECRET');
    const again = service.importCcSwitchCredential('cc-one');
    assert.equal(again.source.providerId, imported.source.providerId);
    assert.equal(again.profilesCopied, 0);
    assert.equal((service as any).buildEnv(newTask).ANTHROPIC_AUTH_TOKEN, 'ROTATED_IMPORT_SECRET');
    cc.close(); fs.renameSync(ccPath, `${ccPath}.gone`);
    assert.equal(service.resolveSessionProvider(newTask.id).ok, true);
    assert.equal(service.resolveSessionProvider(oldTask.id).ok, false);
  } finally { service.shutdown(); store.close(); try { cc.close(); } catch {} fs.rmSync(root, { recursive:true, force:true }); }
});

test('native reference import preserves encrypted local sources, defaults and existing task bindings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-native-local-compat-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://native.example.invalid', ANTHROPIC_MODEL: 'native-model',
    ANTHROPIC_API_KEY: 'NATIVE_REFERENCE_FIXTURE_KEY',
  } }));
  const store = new Store(path.join(root, 'workbench.db'));
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) => Buffer.from(value.toString().slice(7), 'base64').toString(),
  };
  const credentials = new CredentialManager(path.join(root, 'missing-cc.db'), { store, vault, ttlMs: 0 });
  const service = new TaskService(store, credentials, () => []);
  try {
    assert.equal(service.modelCatalog.list().length, 0, 'discovery does not import implicitly');
    const source = service.saveCredentialSource({ name: 'Local source', baseUrl: 'https://local.example.invalid',
      model: 'local-model', apiKey: 'LOCAL_PRESERVATION_FIXTURE_KEY' });
    assert.deepEqual(service.modelCatalog.list().map(p => p.providerId), [source.providerId],
      'saving a local key imports only that selected source');
    service.setDefaultTaskCombo('claude-code', source.providerId, 'local-model');
    const project = service.createProject(root);
    const existing = service.createMainSession({ projectId: project.id, title: 'Existing local task', agentId: 'claude-code' });
    const savedVault = store.getKV('credentialSources.v1');
    const savedDefault = store.getKV('defaultTaskCombo');
    // Configuration discovery has independent parser tests; isolate this import
    // transaction from unrelated native configuration on the test machine.
    service.scanConfiguration = () => ({ agents: [], warnings: [], fingerprint: 'fixture-scan', models: [
      { id: 'provider:native:claude:native-model', name: 'Native', model: 'native-model', source: 'fixture',
        path: settings, protocol: 'anthropic' as const, importable: true },
    ] });
    assert.throws(() => service.importConfiguration(false, 'fixture-scan'), /明确确认/);
    assert.throws(() => service.importConfiguration(true, 'stale-scan'), /已变化/);
    const imported = service.importConfiguration(true, 'fixture-scan');
    assert.equal(imported.added, 1);
    assert.equal(store.getKV('credentialSources.v1'), savedVault);
    assert.equal(store.getKV('defaultProviderId'), source.providerId);
    assert.equal(store.getKV('defaultTaskCombo'), savedDefault);
    assert.equal(service.getSession(existing.id)?.providerId, source.providerId);
    assert.equal((service as any).buildEnv(existing).ANTHROPIC_API_KEY, 'LOCAL_PRESERVATION_FIXTURE_KEY');
    assert.throws(() => service.importCcSwitchCredential('native:claude'), /CC Switch/);
    assert.throws(() => service.saveModelProfile({ name: 'Invalid native route', providerId: 'native:claude',
      model: 'other-native-model', agents: ['dsh'] }), /仅供 Claude Code/);
    const native = service.createMainSession({ projectId: project.id, title: 'Native task', agentId: 'claude-code',
      providerId: 'native:claude', model: 'native-model' });
    assert.equal((service as any).buildEnv(native).ANTHROPIC_API_KEY, 'NATIVE_REFERENCE_FIXTURE_KEY');
    assert.equal(store.countOccurrences('NATIVE_REFERENCE_FIXTURE_KEY'), 0);
    assert.equal(store.countOccurrences('LOCAL_PRESERVATION_FIXTURE_KEY'), 0);
    fs.rmSync(settings);
    assert.equal(service.resolveSessionProvider(native.id).ok, false, 'missing native credentials never fall back to the local key');
    assert.equal(service.resolveSessionProvider(existing.id).ok, true);
  } finally {
    service.shutdown(); store.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
