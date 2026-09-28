import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedSessionId, unwrapSendResult } from '../src/renderer/send';

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
