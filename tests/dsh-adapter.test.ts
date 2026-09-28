import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DshSession } from '../src/main/adapters/dsh';
import type { AdapterEvent, PermissionOutcome } from '../src/shared/types';

async function waitFor(predicate: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for DSH adapter event');
}

const fake = `import json,os,sys,time
args=sys.argv
def value(flag): return args[args.index(flag)+1]
event=value('--workbench-event-file')
control=value('--workbench-control-dir')
resume='--resume' in args
model=value('--model')
with open(event,'w') as f:
 f.write(json.dumps({'type':'session_opened','sessionId':'native-dsh-123','resumed':resume})+'\\n')
 f.write(json.dumps({'method':'session/update','params':{'update':{'sessionUpdate':'tool_call','toolCallId':'tool-1','title':'Read','rawInput':{'path':'test.txt'}}}})+'\\n')
 f.write(json.dumps({'type':'permission_request','requestId':'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','request':{'toolCall':{'toolCallId':'tool-1'}}})+'\\n')
 f.flush()
reply=os.path.join(control,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json')
for _ in range(100):
 if os.path.exists(reply):break
 time.sleep(.02)
if not os.path.exists(reply):sys.exit(4)
decision=json.load(open(reply))['decision']
text=('continued' if resume else 'first')+':'+decision
with open(event,'a') as f:
 f.write(json.dumps({'method':'session/update','params':{'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}})+'\\n')
 f.flush()
report={'success':True,'model':model,'requests':[{'model':model,'status':200}], 'session':{'success':True,'sessionId':'native-dsh-123','text':text}}
print(json.dumps(report))
`;

test('DSH ACP events, Workbench permission, native resume and process cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dsh-adapter-test-'));
  const script = path.join(root, 'fake.py');
  fs.writeFileSync(script, fake);
  const events: AdapterEvent[] = [];
  const ends: string[] = [];
  const prompts: string[] = [];
  const session = new DshSession({
    taskId: 'task-test', providerId: 'provider-test', cwd: root, model: 'glm-5.3-flash', env: {},
    onEvent: (event) => events.push(event), onEnd: (reason) => ends.push(reason),
    canUseTool: async (name, input): Promise<PermissionOutcome> => {
      prompts.push(`${name}:${JSON.stringify(input)}`);
      return { behavior: 'allow' };
    },
  }, script, '/usr/bin/python3');
  try {
    await session.send('first message');
    await waitFor(() => ends.length === 1);
    assert.equal(session.nativeSessionId(), 'native-dsh-123');
    assert.equal(prompts[0], 'Read:{"path":"test.txt"}');
    assert.ok(events.some((event) => event.kind === 'result' && event.text === 'first:allow' && !event.isError));
    await session.send('continue');
    await waitFor(() => ends.length === 2);
    assert.ok(events.some((event) => event.kind === 'result' && event.text === 'continued:allow' && !event.isError));
    assert.deepEqual(ends, ['done', 'done']);
    await session.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DSH missing model binding fails before spawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dsh-reject-'));
  const session = new DshSession({ cwd: root, model: '', providerId: 'p', env: {},
    onEvent: () => {}, onEnd: () => {} }, path.join(root, 'missing.py'));
  try { await assert.rejects(session.send('hi'), /未绑定模型/); }
  finally { await session.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('DSH passes a configured second model through to the launcher', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dsh-second-model-'));
  const script = path.join(root, 'fake.py');
  fs.writeFileSync(script, fake);
  const events: AdapterEvent[] = [];
  const ends: string[] = [];
  const session = new DshSession({ taskId: 'second-model-task', providerId: 'source', cwd: root,
    model: 'second-model', env: {}, onEvent: (event) => events.push(event),
    onEnd: (reason) => ends.push(reason), canUseTool: async () => ({ behavior: 'allow' }) }, script, '/usr/bin/python3');
  try {
    await session.send('go');
    await waitFor(() => ends.length === 1);
    assert.deepEqual(ends, ['done']);
    assert.ok(events.some((event) => event.kind === 'system' && event.model === 'second-model'));
  } finally { await session.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
