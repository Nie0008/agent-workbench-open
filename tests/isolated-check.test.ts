import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedCheckUnavailableReason, makeSnapshot, removeSnapshot, runIsolatedContainer } from '../src/main/isolatedCheck';
import { TaskService } from '../src/main/taskService';

test('snapshot uses the native temp directory, has a stable digest and cleans up only its own root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-snapshot-test-'));
  const snapshots: string[] = [];
  try {
    await fs.writeFile(path.join(root, 'check.sh'), '#!/bin/sh\nexit 0\n');
    const a = await makeSnapshot(root); snapshots.push(a.directory);
    const b = await makeSnapshot(root); snapshots.push(b.directory);
    assert.equal(path.dirname(a.directory), os.tmpdir());
    assert.equal(a.digest, b.digest);
    await fs.mkdir(path.join(root, 'empty'));
    const c = await makeSnapshot(root); snapshots.push(c.directory);
    assert.notEqual(c.digest, a.digest, 'adding an empty directory must invalidate the result');
    await removeSnapshot(path.join(c.directory, 'workspace'));
    assert.ok(await fs.stat(path.join(c.directory, 'workspace')), 'cleanup rejects a snapshot child');
    await removeSnapshot(root);
    assert.ok(await fs.stat(root), 'cleanup rejects unrelated temporary projects');
    await removeSnapshot(c.directory);
    await assert.rejects(fs.stat(c.directory), { code: 'ENOENT' });
  } finally {
    for (const directory of snapshots) await removeSnapshot(directory);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('snapshot preserves effective permissions and chmod changes digest and script behavior', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-snapshot-mode-'));
  const snapshots: string[] = [];
  try {
    const script = path.join(root, 'check.sh');
    await fs.writeFile(script, '#!/bin/sh\nexit 0\n');
    // 0777 checks that the process umask cannot silently change copied modes.
    await fs.chmod(script, 0o777);
    const a = await makeSnapshot(root); snapshots.push(a.directory);
    const executable = path.join(a.directory, 'workspace/check.sh');
    assert.equal((await fs.stat(executable)).mode & 0o777, 0o777);
    assert.equal(spawnSync(executable).status, 0);
    await fs.chmod(script, 0o644);
    const b = await makeSnapshot(root); snapshots.push(b.directory);
    assert.notEqual(b.digest, a.digest);
    const blocked = path.join(b.directory, 'workspace/check.sh');
    assert.equal((await fs.stat(blocked)).mode & 0o777, 0o644);
    assert.equal((spawnSync(blocked).error as NodeJS.ErrnoException | undefined)?.code, 'EACCES');
    await fs.chmod(script, 0o777);
    const c = await makeSnapshot(root); snapshots.push(c.directory);
    assert.equal(c.digest, a.digest, 'restoring identical permissions restores the digest');
  } finally {
    for (const directory of snapshots) await removeSnapshot(directory);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Windows isolated checks return an explicit error before snapshot, cache or Docker access', async () => {
  assert.match(isolatedCheckUnavailableReason('win32')!, /Windows.*暂不支持.*检查未运行/);
  assert.equal(isolatedCheckUnavailableReason('darwin'), undefined);
  assert.equal(isolatedCheckUnavailableReason('linux'), undefined);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    assert.throws(() => TaskService.prototype.createMainSession.call({} as TaskService, {
      projectId: 'unused', title: 'unused', scope: { isolatedChecks: { image: `sha256:${'a'.repeat(64)}`, commands: ['true'] } },
    }), /Windows.*暂不支持/);
    // No store: any access past the platform guard fails this test.
    const result = await TaskService.prototype.runIsolatedCheck.call({} as TaskService, 'unused', 'true');
    assert.equal(result.ok, false);
    assert.match(result.error!, /Windows.*暂不支持/);
    assert.equal(result.cached, undefined);
    await assert.rejects(runIsolatedContainer('unused', 'true', 'missing', 'unused', new AbortController().signal), /Windows.*暂不支持/);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
