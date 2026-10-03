import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedSessionId, unwrapSendResult } from '../src/renderer/send';
import { projectWindowDrafts } from '../src/renderer/window-drafts';

test('window capture and hydration retain source metadata without credential fields', () => {
  const secret = 'fake-unsaved-api-key-for-window-test';
  const source = {
    providerId: 'workbench-local:fixture', name: 'Local fixture', baseUrl: 'https://example.com/v1',
    model: 'fixture-model', authMode: 'auth_token', apiKey: secret, authToken: secret,
    unexpected: { token: secret },
  };
  const model = {
    id: 'profile-fixture', name: 'Fixture model', providerId: source.providerId, model: source.model,
    agents: ['claude-code', 'zcode', 'invalid-agent'], reasoningLevel: 'max', apiKey: secret,
    sourceFingerprint: secret,
  };
  const restored = projectWindowDrafts({
    'models.sourceDraft': source, 'newTask.models.sourceDraft': source,
    'models.draft': model, 'newTask.models.draft': model, 'app.input': 'unsent message',
  });
  const expectedSource = {
    providerId: source.providerId, name: source.name, baseUrl: source.baseUrl,
    model: source.model, authMode: source.authMode,
  };
  assert.deepEqual(restored['models.sourceDraft'], expectedSource);
  assert.deepEqual(restored['newTask.models.sourceDraft'], expectedSource);
  assert.deepEqual(restored['models.draft'], {
    id: model.id, name: model.name, providerId: model.providerId, model: model.model,
    agents: ['claude-code', 'zcode'], reasoningLevel: 'max',
  });
  assert.equal(restored['app.input'], 'unsent message');
  const encoded = JSON.stringify(restored);
  assert.equal(encoded.includes(secret), false);
  assert.deepEqual(projectWindowDrafts(JSON.parse(encoded)), restored, 'a recreated renderer preserves only safe form fields');
});

test('malformed or cleared source drafts do not survive window hydration', () => {
  assert.deepEqual(projectWindowDrafts({
    'models.sourceDraft': { name: 'Missing source fields', apiKey: 'fake-key' },
    'newTask.models.sourceDraft': null,
    'models.draft': { agents: [] },
  }), { 'models.sourceDraft': null, 'newTask.models.sourceDraft': null, 'models.draft': null });
  assert.deepEqual(projectWindowDrafts(null), {});
});

test('renderer sends to the selected subtask when one is open', () => {
  assert.equal(selectedSessionId('sub-42', 'main-1'), 'sub-42');
  assert.equal(selectedSessionId(null, 'main-1'), 'main-1');
});

test('renderer unwraps nested IPC business failures', () => {
  assert.deepEqual(unwrapSendResult({ ok: true, data: { ok: false, needsProvider: true, error: '需要供应商' } }), {
    ok: false, needsProvider: true, error: '需要供应商',
  });
  assert.deepEqual(unwrapSendResult({ ok: true, data: { ok: true } }), { ok: true });
});

import {taskLane,taskLabel,noticeLabel} from '../src/renderer/board-model';
test('看板区分实际运行、授权和恢复，空闲不冒充验收完成',()=>{
 assert.equal(taskLane({status:'resuming'}),'paused');
 assert.equal(taskLane({status:'waiting_permission'}),'permission');
 assert.equal(taskLane({status:'running'}),'running');
 assert.equal(taskLabel({status:'idle',summary:'报告'}),'本轮已结束');
 assert.equal(taskLabel({status:'idle'}),'等待指令');
});
test('只提醒关键事件，空回合自动重试不提示完成',()=>{
 assert.equal(noticeLabel({type:'text_delta'}),null);
 assert.equal(noticeLabel({type:'result',payload:{numTurns:0,text:''}}),null);
 assert.equal(noticeLabel({type:'result',payload:{numTurns:1,text:'ok'}}),'本轮完成 · 待验收');
 assert.equal(noticeLabel({type:'result',payload:{isError:true}}),'执行出错');
});
