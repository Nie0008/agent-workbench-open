#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/main/mcp/entry.js');
const cliEntry = path.join(root, 'dist/main/cli.js');
const runtimeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const usage = `Usage:
  agent-workbench agents
  agent-workbench mcp
  agent-workbench run --project DIR --prompt TEXT [--agent ID] [--provider ID --model ID] [--title TEXT] [--write] [--detach] [--request-id ID]
  agent-workbench run --project DIR --prompt-file FILE [same options]
  agent-workbench result TASK_ID`;

function ensureBuilt() {
  if (fs.existsSync(entry) && fs.existsSync(cliEntry)) return;
  if (root.endsWith('.app/Contents/Resources/app')) throw new Error('Packaged MCP entry is missing');
  try { execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'ignore' }); }
  catch { throw new Error('Build failed. Run npm ci and npm run build to inspect the error.'); }
}

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!name.startsWith('--')) throw new Error(`Unknown argument: ${name}`);
    if (name === '--write' || name === '--detach') { options[name] = true; continue; }
    if (!['--project','--prompt','--prompt-file','--agent','--provider','--model','--title','--request-id'].includes(name)
      || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${name}`);
    if (name in options) throw new Error(`Duplicate option: ${name}`);
    options[name] = args[++i];
  }
  return options;
}

async function connect() {
  ensureBuilt();
  const child = spawn(process.execPath, [entry], { env: runtimeEnv, stdio: ['pipe','pipe','ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (waiting) { pending.delete(message.id); clearTimeout(waiting.timer); waiting.resolve(message); }
  });
  child.on('exit', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('MCP server exited')); }
    pending.clear();
  });
  child.on('error', (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  });
  function request(method, params, timeoutMs = 30_000) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out; check the task before retrying')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  let init;
  try { init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'agent-workbench-cli', version: '1' } }); }
  catch (error) { lines.close(); child.kill(); throw error; }
  if (init.error) { lines.close(); child.kill(); throw new Error('MCP initialization failed'); }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  return {
    async call(name, args = {}) {
      const reply = await request('tools/call', { name, arguments: args }, 35_000);
      if (reply.error) throw new Error(reply.error.message ?? 'MCP request failed');
      let result;
      try { result = JSON.parse(reply.result?.content?.[0]?.text ?? '{}'); }
      catch { throw new Error('Invalid Workbench response'); }
      if (reply.result?.isError || result.ok === false) throw new Error(result.error ?? 'Workbench request failed');
      return result;
    },
    close() { lines.close(); child.stdin.end(); child.kill(); },
  };
}

async function ensureRunning(client) {
  try { return await client.call('workbench_list_projects'); }
  catch (error) {
    if (!String(error.message).includes('未运行')) throw error;
  }
  if (!fs.existsSync(cliEntry)) throw new Error('Workbench startup command is missing; rebuild or reinstall the application');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, 'start'], { env: runtimeEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Workbench startup timed out')); }, 25_000);
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || 'Workbench startup failed')); });
  });
  return client.call('workbench_list_projects');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(usage); return; }
  if (command === 'mcp') {
    if (args.length) throw new Error(usage);
    ensureBuilt();
    await new Promise((resolve, reject) => {
      // The shared installed entry starts the hidden background service on demand.
      const child = spawn(process.execPath, [cliEntry, 'mcp'], { env: runtimeEnv, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => { process.exitCode = code ?? 1; resolve(); });
    });
    return;
  }
  if (!['agents','run','result'].includes(command)) throw new Error(usage);
  const client = await connect();
  try {
    if (command === 'agents') {
      await ensureRunning(client);
      const options = await client.call('workbench_list_agent_options');
      console.log(JSON.stringify({ combinations: options.combinations, defaultTaskCombo: options.defaultTaskCombo }, null, 2));
      return;
    }
    if (command === 'result') {
      if (args.length !== 1) throw new Error(usage);
      await ensureRunning(client);
      console.log(JSON.stringify((await client.call('workbench_read_task_result', { taskId: args[0] })).result, null, 2));
      return;
    }
    const options = parseOptions(args);
    if (!options['--project'] || !!options['--prompt'] === !!options['--prompt-file']) throw new Error(usage);
    if (!!options['--provider'] !== !!options['--model']) throw new Error('--provider and --model must be specified together');
    const projectRoot = fs.realpathSync(options['--project']);
    if (!fs.statSync(projectRoot).isDirectory()) throw new Error('--project must be a directory');
    const prompt = options['--prompt-file'] ? fs.readFileSync(options['--prompt-file'], 'utf8') : options['--prompt'];
    if (!prompt.trim() || prompt.length > 100_000) throw new Error('Prompt must contain 1–100000 characters');
    const known = await ensureRunning(client);
    const selected = options['--agent'] ? null : (await client.call('workbench_list_agent_options')).defaultTaskCombo;
    const existing = known.projects.find((item) => item.rootPath === projectRoot);
    const project = existing ?? (await client.call('workbench_create_project', { rootPath: projectRoot })).project;
    const requestId = options['--request-id'] ?? randomUUID();
    console.error(`requestId=${requestId}`);
    const created = await client.call('workbench_create_task', {
      projectId: project.id, title: options['--title'] ?? 'CLI task', prompt,
      agentId: options['--agent'] ?? selected?.agentId ?? 'claude-code', fileWrite: options['--write'] === true,
      clientRequestId: requestId,
      ...(options['--provider'] ? { providerId: options['--provider'], model: options['--model'] }
        : selected ? { providerId: selected.providerId, model: selected.model } : {}),
    });
    const taskId = created.task.id;
    console.error(`taskId=${taskId}`);
    if (options['--detach']) { console.log(taskId); return; }
    let cursor = 0;
    while (true) {
      const update = await client.call('workbench_wait_task_events', { targets: [{ taskId, sinceSeq: cursor }], timeoutMs: 20_000 });
      if (update.reason === 'shutdown' || update.reason === 'aborted') throw new Error(`Workbench wait ended: ${update.reason}`);
      cursor = update.cursors?.[0]?.sinceSeq ?? cursor;
      const completed = update.events?.find((event) => event.type === 'result');
      if (completed) {
        const details = await client.call('workbench_get_task_events', { taskId, sinceSeq: completed.seq - 1 });
        const result = details.events.find((event) => event.type === 'result' && event.seq === completed.seq);
        if (result) {
          console.log(result.payload.text ?? '');
          if (result.payload.isError) process.exitCode = 1;
          return;
        }
      }
      if (update.events?.some((event) => event.type === 'permission_request' || event.type === 'conflict')) {
        console.error(`Task ${taskId} needs attention in Workbench. Run agent-workbench result ${taskId} later.`);
        process.exitCode = 2;
        return;
      }
      const stopped = update.events?.find((event) => event.type === 'session'
        && ['failed','stopped','canceled','interrupted','timeout','completed'].includes(event.payload?.status));
      if (stopped) throw new Error(`Task ${taskId} ended: ${stopped.payload.status}. Run agent-workbench result ${taskId} for details.`);
      if (update.reason === 'timeout') {
        const task = (await client.call('workbench_get_task', { taskId })).task;
        if (task.status === 'idle' || task.status === 'completed')
          throw new Error(`Task ${taskId} ended without a result. Run agent-workbench result ${taskId} for details.`);
      }
    }
  } finally { client.close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
