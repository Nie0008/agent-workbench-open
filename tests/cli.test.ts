import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';

test('one command creates a project and task through MCP, then prints the full result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-'));
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-control-token');
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      calls.push(method);
      const result: Record<string, any> = {
        'projects.list': { ok:true, projects:[] },
        'agents.options': { ok:true, defaultTaskCombo:{ agentId:'claude-code', providerId:'local', model:'model-one' } },
        'projects.create': { ok:true, project:{ id:'project-1', rootPath:dir } },
        'task.create': { ok:true, task:{ id:'task-1' } },
        'tasks.wait': { ok:true, reason:'events', events:[{ seq:2, type:'result' }], cursors:[{ taskId:'task-1', sinceSeq:2 }] },
        'task.events': { ok:true, events:[{ seq:2, type:'result', payload:{ text:'CLI_FULL_RESULT', isError:false } }] },
      };
      if (method === 'task.create') {
        assert.equal(params.agentId, 'claude-code');
        assert.equal(params.providerId, 'local');
        assert.equal(params.model, 'model-one');
        assert.equal(params.fileWrite, false);
        assert.equal(params.prompt, 'check this project');
        assert.ok(params.clientRequestId);
      }
      if (method === 'task.events') assert.equal(params.sinceSeq, 1);
      res.writeHead(200, { 'content-type':'application/json' });
      res.end(JSON.stringify(result[method] ?? { ok:false, error:'unexpected method' }));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ port:address.port, token:'fixture-control-token' }));
    const child = spawn(process.execPath, [path.join(process.cwd(), 'bin/agent-workbench.mjs'),
      'run', '--project', dir, '--prompt', 'check this project'], {
      cwd:process.cwd(), env:{ ...process.env, WORKBENCH_DATA_DIR:dir }, stdio:['ignore','pipe','pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    const code = await new Promise<number|null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'CLI_FULL_RESULT');
    assert.deepEqual(calls, ['projects.list','agents.options','projects.create','task.create','tasks.wait','task.events']);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
