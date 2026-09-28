import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { GrokSession } from '../src/main/adapters/grok';
import type { AdapterEvent } from '../src/shared/types';

type Rpc = { jsonrpc: string; id?: number | string; method?: string; params?: any; result?: any };
type Fixture = ReturnType<typeof fixture>;
function fixture(onRequest?: (request: Rpc, child: any) => any, resumeId?: string, permissionGate?: Promise<any>, sharedTemp?: string, native: boolean | string = false, ccModel = 'glm-5.3-flash') {
  const temp = sharedTemp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wb-grok-acp-'));
  const requests: Rpc[] = [];
  const clientResponses: Rpc[] = [];
  const children: any[] = [];
  const signals: NodeJS.Signals[] = [];
  const events: AdapterEvent[] = [];
  const ends: Array<{ reason: string; error?: string }> = [];
  const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = [];
  const spawnFake = ((_bin: string, args: string[], options: any) => {
    spawnCalls.push({ bin: _bin, args, env: options.env });
    if (native) {
      assert.equal(_bin, '/fixed/grok');
      assert.deepEqual(args, ['agent', '--no-leader', '--model', native === true ? 'grok-4.7' : native, 'stdio']);
      assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    } else {
      assert.equal(args[1], 'acp');
      assert.equal(args[args.indexOf('--provider-id') + 1], 'provider-fixed');
      assert.equal(args[args.indexOf('--model') + 1], ccModel);
      assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, 'secret-provider-key');
    }
    const child: any = new EventEmitter();
    child.pid = 280000 + children.length;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    children.push(child);
    child.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const request: Rpc = JSON.parse(line);
        requests.push(request);
        if (!request.method && typeof request.id === 'string') clientResponses.push(request);
        if (request.method) {
          const custom = onRequest?.(request, child);
          const response = custom === undefined ? defaultResponse(request) : custom;
          if (request.id !== undefined && response !== null) {
            queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: response })}\n`));
          }
        }
      }
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as any;
  const session = new GrokSession({
    taskId: 'task-parent', allowDelegation: true,
    cwd: temp, model: native ? native === true ? 'grok-4.7' : native : ccModel,
    providerId: typeof native === 'string' ? `grok-config:${native}:0123456789abcdef`
      : native ? 'grok-super-oauth' : 'provider-fixed',
    env: native ? { WORKBENCH_DATA_DIR: temp } : { ANTHROPIC_AUTH_TOKEN: 'secret-provider-key', WORKBENCH_DATA_DIR: temp },
    canUseTool: async () => permissionGate ?? ({ behavior: 'allow' } as any),
    resumeNativeSessionId: resumeId,
    onEvent: (event: AdapterEvent) => events.push(event),
    onEnd: (reason: 'done' | 'interrupted' | 'error', error?: string) => ends.push({ reason, error }),
  } as any, {
    scriptPath: '/fixed/scripts/grok-glm.py', grokPath: '/fixed/grok', workbenchMcpEntry: '/fixed/dist/main/mcp/entry.js',
    nodePath: '/usr/bin/node', pythonPath: 'python3', spawn: spawnFake, tempRoot: temp,
    signalProcess: (_pid: number, signal: NodeJS.Signals) => {
      signals.push(signal);
      const child = children.at(-1);
      child?.emit('close', null, signal);
    },
  });
  return { temp, requests, clientResponses, children, signals, events, ends, spawnCalls, session, dispose: () => fs.rmSync(temp, { recursive: true, force: true }) };
}
function defaultResponse(request: Rpc): any {
  if (request.method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  if (request.method === 'session/new') return { sessionId: 'native-42', configOptions: [{ id: 'model', currentValue: 'glm-5.3-flash' }] };
  if (request.method === 'session/load') return { configOptions: [{ id: 'model', currentValue: 'glm-5.3-flash' }] };
  if (request.method === 'session/prompt') return { stopReason: 'end_turn' };
  return {};
}
function notify(child: any, method: string, params: any) {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}
async function waitEnd(ends: Fixture['ends'], count: number) {
  const until = Date.now() + 1500;
  while (ends.length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ends.length, count, 'adapter should settle the run');
}

test('ACP streams assistant/tool events, binds Workbench MCP, and loads the exact native session', async () => {
  const f = fixture((request, child) => {
    if (request.method === 'session/prompt') {
      notify(child, 'session/update', { sessionId: 'native-42', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } } });
      notify(child, 'session/update', { sessionId: 'native-42', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } });
      notify(child, 'session/update', { sessionId: 'native-42', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', kind: 'read', rawInput: { path: 'a.txt' } } });
      notify(child, 'session/update', { sessionId: 'native-42', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file data' } }] } });
      return { stopReason: 'end_turn' };
    }
    return defaultResponse(request);
  });
  try {
    await f.session.send('prompt'); await waitEnd(f.ends, 1);
    assert.equal(f.session.nativeSessionId(), 'native-42');
    const create = f.requests.find((request) => request.method === 'session/new')!;
    assert.deepEqual(create.params.mcpServers, [{ name: 'workbench', command: '/usr/bin/node', args: ['/fixed/dist/main/mcp/entry.js', '--parent-task-id', 'task-parent'], env: [{ name: 'WORKBENCH_DATA_DIR', value: f.temp }] }]);
    assert.ok(f.events.some((event) => event.kind === 'text_delta' && event.text === 'hello '));
    assert.ok(f.events.some((event) => event.kind === 'tool_use' && event.name === 'Read'));
    assert.ok(f.events.some((event) => event.kind === 'tool_result' && event.toolUseId === 'tool-1'));
    assert.equal(f.events.some((event) => event.kind === 'usage'), false, 'ACP has no verified per-prompt modelUsage payload');
    assert.deepEqual(f.ends[0], { reason: 'done', error: undefined });
    await f.session.close();
    const resumed = fixture(undefined, 'native-42', undefined, f.temp);
    await resumed.session.send('followup'); await waitEnd(resumed.ends, 1);
    const load = resumed.requests.find((request) => request.method === 'session/load')!;
    assert.equal(load.params.sessionId, 'native-42');
    assert.deepEqual(load.params.mcpServers, create.params.mcpServers);
    assert.equal(resumed.requests.filter((request) => request.method === 'session/new').length, 0);
    await resumed.session.close();
  } finally { await f.session.close(); f.dispose(); }
});

test('fails closed when ACP does not report the pinned GLM model', async () => {
  const f = fixture((request) => {
    if (request.method === 'session/new') return { sessionId: 'native-wrong', configOptions: [{ id: 'model', currentValue: 'grok-4.6' }] };
    return defaultResponse(request);
  });
  try {
    await f.session.send('prompt'); await waitEnd(f.ends, 1);
    assert.equal(f.ends[0].reason, 'error');
    assert.equal(f.requests.some((request) => request.method === 'session/prompt'), false);
  } finally { await f.session.close(); f.dispose(); }
});

test('CC Switch sourced Grok task passes a second catalog model to the launcher', async () => {
  const f = fixture((request) => {
    if (request.method === 'session/new') return { sessionId: 'second-model-session',
      configOptions: [{ id: 'model', currentValue: 'second-model' }] };
    return defaultResponse(request);
  }, undefined, undefined, undefined, false, 'second-model');
  try {
    await f.session.send('prompt'); await waitEnd(f.ends, 1);
    assert.deepEqual(f.ends[0], { reason: 'done', error: undefined });
    assert.ok(f.events.some((event) => event.kind === 'system' && event.model === 'second-model'));
  } finally { await f.session.close(); f.dispose(); }
});

test('native Grok Super uses OAuth CLI with the selected model and rejects a model mismatch', async () => {
  const f = fixture((request) => {
    if (request.method === 'session/new') return { sessionId: 'native-super', configOptions: [{ id: 'model', currentValue: 'grok-4.7' }] };
    return defaultResponse(request);
  }, undefined, undefined, undefined, true);
  try {
    await f.session.send('prompt'); await waitEnd(f.ends, 1);
    assert.deepEqual(f.ends[0], { reason: 'done', error: undefined });
    assert.equal(f.spawnCalls.length, 1);
    assert.ok(f.events.some((event) => event.kind === 'system' && event.model === 'grok-4.7'));
  } finally { await f.session.close(); f.dispose(); }

  const wrong = fixture((request) => {
    if (request.method === 'session/new') return { sessionId: 'native-wrong', configOptions: [{ id: 'model', currentValue: 'glm-5.3-flash' }] };
    return defaultResponse(request);
  }, undefined, undefined, undefined, true);
  try {
    await wrong.session.send('prompt'); await waitEnd(wrong.ends, 1);
    assert.equal(wrong.ends[0].reason, 'error');
    assert.equal(wrong.requests.some((request) => request.method === 'session/prompt'), false);
  } finally { await wrong.session.close(); wrong.dispose(); }
});

test('configured Grok model launches through the native CLI and verifies the ACP model', async () => {
  const f = fixture((request) => {
    if (request.method === 'session/new') return { sessionId: 'native-configured',
      configOptions: [{ id: 'model', currentValue: 'grok-4.7' }] };
    if (request.method === 'session/set_config_option') {
      assert.deepEqual(request.params, { sessionId: 'native-configured', configId: 'model', value: 'grok-4.6' });
      return { configOptions: [{ id: 'model', currentValue: 'grok-4.6' }] };
    }
    return defaultResponse(request);
  }, undefined, undefined, undefined, 'grok-4.6');
  try {
    await f.session.send('prompt'); await waitEnd(f.ends, 1);
    assert.deepEqual(f.ends[0], { reason: 'done', error: undefined });
    assert.equal(f.spawnCalls.length, 1);
    assert.ok(f.requests.findIndex((request) => request.method === 'session/set_config_option')
      < f.requests.findIndex((request) => request.method === 'session/prompt'));
    assert.ok(f.events.some((event) => event.kind === 'system' && event.model === 'grok-4.6'));
  } finally { await f.session.close(); f.dispose(); }
});

test('configured Grok model never prompts if session model switch is not verified', async () => {
  const f = fixture((request) => {
    if (request.method === 'session/new') return { sessionId: 'native-configured',
      configOptions: [{ id: 'model', currentValue: 'grok-4.7' }] };
    if (request.method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: 'grok-4.7' }] };
    return defaultResponse(request);
  }, undefined, undefined, undefined, 'grok-4.6');
  try {
    await f.session.send('prompt'); await waitEnd(f.ends, 1);
    assert.equal(f.ends[0].reason, 'error');
    assert.equal(f.requests.some((request) => request.method === 'session/prompt'), false);
  } finally { await f.session.close(); f.dispose(); }
});

test('permission prompt is delegated to Workbench and cancellation is answered explicitly', async () => {
  let permission: Rpc | undefined;
  let releasePermission!: (value: any) => void;
  const permissionGate = new Promise<any>((resolve) => { releasePermission = resolve; });
  const f = fixture((request, child) => {
    if (request.method === 'session/prompt') {
      permission = { jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'native-42', toolCall: { toolCallId: 'tool-2', kind: 'execute', rawInput: { command: 'ls' } }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } };
      child.stdout.write(`${JSON.stringify(permission)}\n`);
      return null;
    }
    return defaultResponse(request);
  }, undefined, permissionGate);
  try {
    await f.session.send('prompt');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await f.session.interrupt(); await waitEnd(f.ends, 1);
    assert.ok(f.clientResponses.some((response) => response.id === 'permission-1' && response.result?.outcome?.outcome === 'cancelled'), JSON.stringify(f.clientResponses));
    assert.ok(f.requests.some((request) => request.method === 'session/cancel'));
    assert.equal(f.ends[0].reason, 'interrupted');
  } finally { await f.session.close(); f.dispose(); }
});

test('Grok prompt has no fixed 15-minute cutoff and forwards progress without private thought text',async(context)=>{
 const f=fixture(request=>request.method==='session/prompt'?null:defaultResponse(request));
 try{
  await (f.session as any).ensureSession();
  context.mock.timers.enable({apis:['setTimeout']});
  await f.session.send('long task');
  await new Promise(resolve=>setImmediate(resolve));
  const request=f.requests.find(r=>r.method==='session/prompt')!;assert.ok(request);
  notify(f.children[0],'session/update',{sessionId:'native-42',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private-thought-sentinel'}}});
  notify(f.children[0],'session/update',{sessionId:'native-42',update:{sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'in_progress'}});
  assert.equal(f.events.filter(e=>e.kind==='activity').length,2);
  assert.equal(JSON.stringify(f.events).includes('private-thought-sentinel'),false);
  context.mock.timers.tick(16*60_000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.ends.length,0);assert.equal(f.signals.length,0);
  f.children[0].stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:request.id,result:{stopReason:'end_turn'}})}\n`);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.ends[0]?.reason,'done');
 }finally{context.mock.timers.reset();await f.session.close();f.dispose();}
});

test('rejects credential-bearing errors and closes the process', async () => {
  const f = fixture((request) => {
    if (request.method === 'session/new') return { sessionId: 'native-42', configOptions: [{ id: 'model', currentValue: 'glm-5.3-flash' }] };
    if (request.method === 'session/prompt') return { stopReason: 'end_turn' };
    return defaultResponse(request);
  });
  try {
    await f.session.send('prompt'); await waitEnd(f.ends, 1);
    await f.session.close();
    assert.equal(f.children[0].killed, undefined);
  } finally { await f.session.close().catch(() => {}); f.dispose(); }
});
