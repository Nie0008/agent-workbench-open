// ZCode Protocol app-server adapter. Credentials stay in the in-memory local
// bridge; its one-time bridge token is held in a 0600 temp config removed close.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent, PermissionOutcome } from '../../shared/types';
import type { AgentAdapter, AgentSessionHandle, AgentSessionOpts } from './types';

const PROVIDER = 'cc-glm';
function modelSelection(opts: AgentSessionOpts) {
  return { providerId: PROVIDER, modelId: opts.model,
    ...(opts.reasoningLevel ? { options: { reasoningLevel: opts.reasoningLevel } } : {}) };
}
const APP_SERVER = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const BUILTIN_CONFIG = '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
const MAX_LINE = 2 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;

type RpcMessage = Record<string, any>;
type RequestHandler = (method: string, params: any) => Promise<any>;
type NotifyHandler = (method: string, params: any) => void;

interface ProtocolConnection {
  request(method: string, params?: unknown): Promise<any>;
  close(): Promise<void>;
  setRequestHandler(handler: RequestHandler): void;
  setNotifyHandler(handler: NotifyHandler): void;
}
interface BridgeStats { requests: number; modelMatches: number; rejectedModels: number; failedRequests: number; received: number; unexpectedPath: string | null; }
interface Bridge { server: http.Server; url: string; token: string; snapshot(): BridgeStats; close(): Promise<void> }
interface RuntimeConfig { dataDir: string; storageDir: string; sessionDbPath: string; personalConfig: string; tempDir: string; }
interface SessionRuntime { config: RuntimeConfig; bridge: Bridge; connection: ProtocolConnection; close(): Promise<void> }
type RuntimeFactory = (opts: AgentSessionOpts) => Promise<SessionRuntime>;

function appServerPath(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [process.env.WORKBENCH_ZCODE_CLI, APP_SERVER,
    ...(resources ? [path.join(resources, 'glm', 'zcode.cjs')] : []),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')];
  const found = candidates.find((p) => !!p && fs.existsSync(p));
  if (!found) throw new Error('未找到 ZCode CLI app-server');
  return found;
}

function builtinConfigPath(cliPath: string): string {
  const candidates = [process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    path.resolve(path.dirname(cliPath), '../config/provider/zcode-builtin.json'), BUILTIN_CONFIG];
  const found = candidates.find((p) => !!p && fs.existsSync(p));
  if (!found) throw new Error('未找到 ZCode Built-in Provider Config');
  return found;
}

function credential(opts: AgentSessionOpts): { key: string; baseUrl: URL } {
  if (!opts.providerId) throw new Error('ZCode 需要绑定明确的 CC Switch 供应商');
  if (!opts.model || opts.env.ANTHROPIC_MODEL !== opts.model) throw new Error('ZCode 模型绑定不一致');
  const key = opts.env.ANTHROPIC_AUTH_TOKEN || opts.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('所选 CC Switch 供应商缺少 Anthropic API 凭据');
  let base: URL;
  try { base = new URL(opts.env.ANTHROPIC_BASE_URL ?? ''); } catch { throw new Error('ZCode 供应商端点无效'); }
  if (base.protocol !== 'https:' || !base.hostname || base.username || base.password || base.search || base.hash) {
    throw new Error('ZCode 仅允许有效的 HTTPS Anthropic 端点');
  }
  return { key, baseUrl: base };
}

function safeEnv(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== 'string') continue;
    if (/^(ANTHROPIC_|ZCODE_|DSH_)/i.test(k) || /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function buildAppServerEnvironment(
  source: Record<string, string | undefined>, config: RuntimeConfig, builtinConfig: string,
  isElectron = !!(process as NodeJS.Process & { versions?: { electron?: string } }).versions?.electron,
): Record<string, string> {
  const env = safeEnv(source);
  env.ZCODE_DATA_BASE_DIR = config.dataDir;
  env.ZCODE_STORAGE_DIR = config.storageDir;
  env.ZCODE_SESSION_DB_PATH = config.sessionDbPath;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.personalConfig;
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfig;
  if (isElectron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function redactSecrets(value: string, env: Record<string, string>): string {
  let result = value;
  for (const [key, secret] of Object.entries(env)) {
    if (secret && (/(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key) || key.startsWith('ANTHROPIC_'))) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result.slice(-900);
}

async function createRuntimeConfig(opts: AgentSessionOpts): Promise<RuntimeConfig> {
  const cliPath = appServerPath();
  const builtin = builtinConfigPath(cliPath);
  // Separate native databases per Workbench task; data survives app restarts
  // and never collides with the user's interactive ZCode profile.
  if (!opts.taskId) throw new Error('ZCode 隔离运行需要 Workbench taskId');
  const identity = `${path.resolve(opts.cwd)}\0${opts.taskId}`;
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const workbenchData = process.env.WORKBENCH_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/Agent Workbench');
  const root = path.join(workbenchData, 'zcode-glm', key);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700);
  const dataDir = path.join(root, 'data');
  const storageDir = path.join(root, 'storage');
  const configDir = path.join(storageDir, 'cli');
  const sessionDbPath = path.join(storageDir, 'session', 'db.sqlite');
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.dirname(sessionDbPath), { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700); await fsp.chmod(storageDir, 0o700); await fsp.chmod(configDir, 0o700);
  const modelId = `${PROVIDER}/${opts.model}${opts.reasoningLevel ? `$${opts.reasoningLevel}` : ''}`;
  await fsp.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ model: { main: modelId } }), { mode: 0o600 });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-zcode-'));
  await fsp.chmod(tempDir, 0o700);
  const personalConfig = path.join(tempDir, 'personal.json');
  await fsp.writeFile(personalConfig, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{ providerId: PROVIDER, providerName: 'CC Switch GLM', config: {
        group: 'standard-personal', access: { type: 'api-key', apiKey: 'temporary-local-bridge-token' },
        api: { type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:0' }, personalModelIds: [opts.model],
      } }] },
      modelConfigRules: { providerModelRules: [{ providerId: PROVIDER, modelId: opts.model, config: { properties: { contextWindow: 200000 } } }], manualProviderModelRules: [] },
      defaultModelSelection: modelSelection(opts),
    },
  }), { mode: 0o600 });
  await fsp.chmod(personalConfig, 0o600);
  // Keep paths outside the config file's secret-bearing temporary directory.
  void builtin;
  return { dataDir, storageDir, sessionDbPath, personalConfig, tempDir };
}

async function createBridge(opts: AgentSessionOpts, personalConfig: string): Promise<Bridge> {
  const { key, baseUrl } = credential(opts);
  const token = crypto.randomBytes(32).toString('base64url');
  const stats: BridgeStats = { requests: 0, modelMatches: 0, rejectedModels: 0, failedRequests: 0, received: 0, unexpectedPath: null };
  const server = http.createServer((req, res) => {
    stats.received++;
    const requestPath = (req.url ?? '').split('?')[0];
    if (!['/v1/messages', '/messages'].includes(requestPath)) { stats.unexpectedPath = requestPath.slice(0, 120); res.writeHead(404).end(); return; }
    if (req.headers['x-api-key'] !== token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    stats.requests++;
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let model: unknown;
      try { model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model; } catch { stats.failedRequests++; res.writeHead(400).end(); return; }
      if (model !== opts.model) { stats.rejectedModels++; res.writeHead(400).end('Configured model is blocked'); return; }
      stats.modelMatches++;
      const basePath = baseUrl.pathname.replace(/\/$/, '');
      const upstreamPath = `${basePath}${basePath.endsWith('/v1') ? '/messages' : (req.url ?? '/v1/messages')}`;
      const upstream = https.request({
        hostname: baseUrl.hostname, port: baseUrl.port || 443, method: 'POST', path: upstreamPath,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          accept: req.headers.accept ?? 'application/json',
          'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01',
          'x-api-key': key, authorization: `Bearer ${key}`,
        },
      }, (up) => {
        if ((up.statusCode ?? 502) < 200 || (up.statusCode ?? 502) >= 300) stats.failedRequests++;
        res.writeHead(up.statusCode ?? 502, { 'content-type': up.headers['content-type'] ?? 'application/json', connection: 'close' });
        up.pipe(res);
      });
      upstream.setTimeout(90000, () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', () => { stats.failedRequests++; if (!res.headersSent) res.writeHead(502); res.end('upstream request failed'); });
      upstream.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ZCode local model bridge failed to bind');
  const url = `http://127.0.0.1:${address.port}`;
  const config = JSON.parse(await fsp.readFile(personalConfig, 'utf8'));
  const provider = config.config.providerConfigRules.providerRules.find((p: any) => p.providerId === PROVIDER);
  provider.config.access.apiKey = token;
  provider.config.api.baseUrl = url;
  await fsp.writeFile(personalConfig, JSON.stringify(config), { mode: 0o600 });
  await fsp.chmod(personalConfig, 0o600);
  return { server, url, token, snapshot: () => ({ ...stats }), close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

class JsonLineConnection implements ProtocolConnection {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<string | number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stdout = '';
  private stderr = '';
  private readonly envForRedaction: Record<string, string>;
  private requestHandler: RequestHandler = async () => ({});
  private notifyHandler: NotifyHandler = () => {};
  private closed = false;

  constructor(opts: AgentSessionOpts, config: RuntimeConfig, cli: string) {
    this.envForRedaction = opts.env;
    const env = buildAppServerEnvironment({ ...process.env, ...opts.env }, config, builtinConfigPath(cli));
    this.child = spawn(process.execPath, [cli, 'app-server', '--cwd', opts.cwd, '--surface', 'terminal'], {
      cwd: opts.cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: Buffer | string) => { this.stderr = (this.stderr + chunk.toString()).slice(-MAX_OUTPUT); });
    this.child.stdout?.on('data', (chunk: string) => this.read(chunk));
    this.child.once('error', (e) => this.failAll(new Error(`ZCode app-server could not start: ${e.message}`)));
    this.child.once('close', (code, signal) => {
      this.closed = true;
      this.failAll(new Error(redactSecrets(`ZCode app-server exited (${code ?? signal ?? 'unknown'}): ${this.stderr.slice(-600)}`, this.envForRedaction)));
    });
  }

  setRequestHandler(handler: RequestHandler) { this.requestHandler = handler; }
  setNotifyHandler(handler: NotifyHandler) { this.notifyHandler = handler; }

  private read(chunk: string) {
    this.stdout += chunk;
    if (this.stdout.length > MAX_LINE && !this.stdout.includes('\n')) { this.failAll(new Error('ZCode protocol line exceeded limit')); this.kill(); return; }
    while (true) {
      const n = this.stdout.indexOf('\n');
      if (n < 0) break;
      const line = this.stdout.slice(0, n).trim(); this.stdout = this.stdout.slice(n + 1);
      if (!line) continue;
      if (line.length > MAX_LINE) { this.failAll(new Error('ZCode protocol line exceeded limit')); this.kill(); return; }
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { this.failAll(new Error('ZCode app-server sent invalid JSON')); this.kill(); return; }
      void this.dispatch(message);
    }
  }

  private async dispatch(message: RpcMessage) {
    if (message.id !== undefined && message.method) {
      try { this.write({ id: message.id, result: await this.requestHandler(message.method, message.params ?? {}) }); }
      catch (e: any) { this.write({ id: message.id, error: { code: -32000, message: String(e?.message ?? 'request denied').slice(0, 500) } }); }
      return;
    }
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(message.id);
      if (message.error) p.reject(new Error(String(message.error.message ?? 'ZCode protocol error').slice(0, 800)));
      else p.resolve(message.result);
      return;
    }
    if (message.method) this.notifyHandler(message.method, message.params ?? {});
  }

  private write(message: RpcMessage) {
    if (this.closed || !this.child.stdin?.writable) throw new Error('ZCode app-server is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // TaskService owns the 900-second execution budget. Its clock pauses
      // while Workbench waits for a permission decision, so allow a long
      // native turn while keeping setup/control RPCs bounded and responsive.
      const timeoutMs = method === 'session/send' ? 4 * 60 * 60 * 1000 : 15_000;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ZCode protocol request timed out: ${method}`)); }, timeoutMs);
      timer.unref(); this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  private failAll(error: Error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  private kill() { if (this.child.pid) { try { process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, 'SIGTERM'); } catch { /* exited */ } } }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin?.end();
    this.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.kill(); resolve(); }, 5000); timer.unref();
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function appServerFactory(opts: AgentSessionOpts, config: RuntimeConfig): Promise<ProtocolConnection> {
  const cli = appServerPath();
  return new JsonLineConnection(opts, config, cli);
}

async function defaultRuntimeFactory(opts: AgentSessionOpts): Promise<SessionRuntime> {
  const config = await createRuntimeConfig(opts);
  let bridge: Bridge | null = null;
  let connection: ProtocolConnection | null = null;
  try {
    bridge = await createBridge(opts, config.personalConfig);
    connection = await appServerFactory(opts, config);
    return {
      config, bridge, connection,
      close: async () => {
        try { await connection?.close(); } finally {
          await bridge?.close();
          await fsp.rm(config.tempDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try { await connection?.close(); } finally {
      await bridge?.close();
      await fsp.rm(config.tempDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export class ZCodeSession implements AgentSessionHandle {
  private nativeId: string | null;
  private connection: ProtocolConnection | null = null;
  private bridge: Bridge | null = null;
  private config: RuntimeConfig | null = null;
  private runtime: SessionRuntime | null = null;
  private run: Promise<void> | null = null;
  private abortTurn: AbortController | null = null;
  private disposed = false;
  private turnFinished = true;
  private turnWaiter: (() => void) | null = null;
  private ended = true;
  private turnError: Error | null = null;
  private requestSeq = 0;
  private readonly runtimeFactory: RuntimeFactory;
  private readonly toolCalls = new Set<string>();
  private lastResponse = '';
  private assistantMessageEmitted = false;

  constructor(private opts: AgentSessionOpts, runtimeFactory: RuntimeFactory = defaultRuntimeFactory) {
    this.nativeId = opts.resumeNativeSessionId ?? null;
    this.runtimeFactory = runtimeFactory;
  }

  nativeSessionId() { return this.nativeId; }

  private emit(e: AdapterEvent) { if (!this.disposed) this.opts.onEvent(e); }

  async send(text: string): Promise<void> {
    if (this.disposed) throw new Error('ZCode runtime 已关闭');
    if (!this.ended) throw new Error('ZCode 会话仍在运行');
    this.turnFinished = false; this.turnError = null; this.lastResponse = ''; this.assistantMessageEmitted = false; this.toolCalls.clear();
    this.ended = false;
    this.abortTurn = new AbortController();
    const abort = this.abortTurn;
    this.run = this.runTurn(text, abort).finally(() => {
      if (this.abortTurn === abort) this.abortTurn = null;
      this.ended = true;
      this.run = null;
    });
    // Do not hold the IPC/control request open for the model turn. runTurn
    // owns reporting via onEvent/onEnd; a subsequent send is rejected until
    // it settles.
    await Promise.resolve();
  }

  private async ensureConnection(): Promise<void> {
    if (this.connection) return;
    const runtime = await this.runtimeFactory(this.opts);
    this.runtime = runtime; this.config = runtime.config; this.bridge = runtime.bridge; this.connection = runtime.connection;
    const connection = runtime.connection;
    connection.setRequestHandler((method, params) => this.handleServerRequest(method, params));
    connection.setNotifyHandler((method, params) => this.handleNotify(method, params));
    const selection = modelSelection(this.opts);
    if (this.nativeId) {
      await connection.request('session/resume', { sessionId: this.nativeId, workspace: this.workspace() });
      await connection.request('session/setModel', { sessionId: this.nativeId, model: selection });
      if (this.opts.reasoningLevel) await connection.request('session/setThoughtLevel', { sessionId: this.nativeId, thoughtLevel: this.opts.reasoningLevel });
    } else {
      const result = await connection.request('session/create', {
        workspace: this.workspace(), mode: 'build', model: selection,
        ...(this.opts.reasoningLevel ? { thoughtLevel: this.opts.reasoningLevel } : {}), persistence: 'immediate',
        ...(this.opts.allowedTools ? { toolAllowlist: this.opts.allowedTools } : {}),
        ...(this.opts.disallowedTools ? { toolDenylist: this.opts.disallowedTools } : {}),
      });
      this.nativeId = result?.session?.sessionId ?? result?.snapshot?.session?.sessionId ?? null;
      if (!this.nativeId) throw new Error('ZCode session/create returned no sessionId');
    }
    await connection.request('session/setMode', { sessionId: this.nativeId, mode: 'build' });
    await connection.request('session/subscribe', { sessionId: this.nativeId, deliveryKind: 'desktop-continuous', includeSnapshot: false });
    const snapshot = await connection.request('session/read', { sessionId: this.nativeId, deliveryKind: 'desktop-continuous' });
    const current = snapshot?.settings?.model?.current;
    if (current?.providerId !== PROVIDER || current?.modelId !== this.opts.model
      || (this.opts.reasoningLevel && current?.options?.reasoningLevel !== this.opts.reasoningLevel)) {
      throw new Error('ZCode app-server 未激活所选模型配置');
    }
    this.emit({ kind: 'system', nativeSessionId: this.nativeId, model: this.opts.model });
  }

  private workspace() {
    const workspacePath = path.resolve(this.opts.cwd);
    return { workspacePath, workspaceKey: workspacePath };
  }

  private async handleServerRequest(method: string, params: any): Promise<any> {
    if (method === 'session/requestRuntimePreferences') return {
      nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1',
    };
    if (method === 'interaction/requestPermission') {
      const callId = String(params.toolCallId ?? params.requestId ?? `zcode-${++this.requestSeq}`);
      const toolName = String(params.toolName ?? 'unknown');
      const input = params.input ?? {};
      this.emitToolUse(callId, toolName, input);
      let outcome: PermissionOutcome = { behavior: 'deny', message: 'Workbench permission handler unavailable' };
      try { if (this.opts.canUseTool) outcome = await this.opts.canUseTool(toolName, input); }
      catch (e: any) { outcome = { behavior: 'deny', message: String(e?.message ?? 'permission handler failed') }; }
      const decision = outcome.behavior === 'allow' ? 'allow' : 'deny';
      if (decision === 'deny') this.emit({ kind: 'tool_result', toolUseId: callId, name: toolName, isError: true, content: outcome.message ?? 'Denied by Workbench' });
      return { decision, reason: outcome.message ?? (decision === 'allow' ? 'Allowed by Workbench' : 'Denied by Workbench') };
    }
    if (method === 'interaction/requestUserInput') return { action: 'decline' };
    if (method === 'interaction/requestProviderRuntimeHeaders') return { headers: {} };
    throw new Error(`Unsupported ZCode host request: ${method}`);
  }

  private emitToolUse(id: string, name: string, input: unknown) {
    if (this.toolCalls.has(id)) return;
    this.toolCalls.add(id);
    this.emit({ kind: 'tool_use', toolUseId: id, name, input });
  }

  private handleNotify(method: string, params: any) {
    if (method === 'startup/storageState') {
      if (params.phase === 'failed') this.turnError = new Error(`ZCode storage startup failed: ${params.errorCode ?? 'unknown'}`);
      return;
    }
    if (method !== 'session/event') return;
    const type = params.type;
    const p = params.payload ?? {};
    switch (type) {
      case 'part.delta':
        if (p.field !== 'reasoning' && p.field !== 'input' && typeof p.delta === 'string') {
          this.lastResponse += p.delta;
          this.emit({ kind: 'text_delta', text: p.delta });
        }
        break;
      case 'tool.updated':
        if (p.kind === 'scheduled') this.emitToolUse(String(p.toolCallId), String(p.toolName ?? 'tool'), p.input ?? {});
        else if (p.kind === 'result') this.emit({ kind: 'tool_result', toolUseId: String(p.toolCallId), name: p.toolName, isError: !p.result?.success, content: String(p.result?.output ?? p.result?.content ?? '') });
        else if (p.kind === 'error') this.emit({ kind: 'tool_result', toolUseId: String(p.toolCallId), name: p.toolName, isError: true, content: String(p.error?.message ?? 'Tool failed') });
        break;
      case 'permission.requested':
        this.emitToolUse(String(p.toolCallId), String(p.toolName ?? 'tool'), p.input ?? {});
        break;
      case 'turn.completed': {
        if (p.resultType && p.resultType !== 'success') this.turnError = new Error(`ZCode turn ended with ${String(p.resultType).slice(0, 100)}`);
        const response = typeof p.response === 'string' ? p.response : this.lastResponse;
        if (response && !this.assistantMessageEmitted) { this.emit({ kind: 'assistant_message', text: response }); this.assistantMessageEmitted = true; }
        this.lastResponse = response;
        this.emitUsage(p.usage);
        this.turnFinished = true;
        this.turnWaiter?.(); this.turnWaiter = null;
        break;
      }
      case 'turn.failed': {
        const message = String(p.error?.message ?? p.error?.data?.message ?? 'ZCode turn failed').slice(0, 1000);
        this.turnError = new Error(message);
        this.turnFinished = true;
        this.turnWaiter?.(); this.turnWaiter = null;
        break;
      }
      default: break;
    }
  }

  private emitUsage(raw: any) {
    const u = raw && typeof raw === 'object' ? raw : {};
    const usage: Record<string, number> = {};
    if (typeof u.inputTokens === 'number') usage.input_tokens = u.inputTokens;
    if (typeof u.outputTokens === 'number') usage.output_tokens = u.outputTokens;
    if (typeof u.cacheReadTokens === 'number') usage.cache_read_tokens = u.cacheReadTokens;
    if (typeof u.cacheWriteTokens === 'number') usage.cache_creation_tokens = u.cacheWriteTokens;
    if (Object.keys(usage).length) this.emit({ kind: 'usage', usage, costUSD: null });
  }

  private awaitTurnCompletion(signal: AbortSignal): Promise<void> {
    if (this.turnFinished) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.turnWaiter === onComplete) this.turnWaiter = null;
        error ? reject(error) : resolve();
      };
      const onComplete = () => finish();
      const onAbort = () => finish(new Error('ZCode turn interrupted'));
      const timer = setTimeout(() => finish(new Error('ZCode app-server turn timed out')), 4 * 60 * 60 * 1000);
      timer.unref();
      this.turnWaiter = onComplete;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      // A terminal event can arrive between the initial check and waiter setup.
      if (this.turnFinished) finish();
    });
  }

  private async runTurn(text: string, abort: AbortController): Promise<void> {
    try {
      await this.ensureConnection();
      if (abort.signal.aborted) { this.opts.onEnd('interrupted'); return; }
      const before = this.bridge?.snapshot();
      // session/send accepts an explicit modelSelection; repeat the fixed
      // provider/model/effort on every turn so resume or session defaults can
      // never route a prompt through ZCode's default model.
      const result = await this.connection!.request('session/send', {
        sessionId: this.nativeId, content: text, modelSelection: modelSelection(this.opts),
      });
      // app-server acknowledges session/send with prompt_started; actual model
      // completion arrives asynchronously as session/event turn.completed/failed.
      await this.awaitTurnCompletion(abort.signal);
      if (abort.signal.aborted || this.disposed) { this.opts.onEnd('interrupted'); return; }
      if (this.turnError) throw this.turnError;
      const after = this.bridge?.snapshot();
      if (!before || !after || after.requests <= before.requests
        || after.modelMatches - before.modelMatches < after.requests - before.requests
        || after.rejectedModels !== before.rejectedModels || after.failedRequests !== before.failedRequests) {
        const stats = before && after
          ? `requests=${after.requests - before.requests},glmModel=${after.modelMatches - before.modelMatches},rejectedModel=${after.rejectedModels - before.rejectedModels},upstreamFailures=${after.failedRequests - before.failedRequests},bridgeReceived=${after.received - before.received}${after.unexpectedPath ? `,unexpectedPath=${after.unexpectedPath}` : ''}`
          : 'bridgeStats=unavailable';
        throw new Error(`ZCode 本轮没有得到所选模型 ${this.opts.model} 的上游成功响应，结果不记为模型已验证 (${stats})`);
      }
      const response = typeof result?.response === 'string' ? result.response : this.lastResponse;
      if (response && !this.lastResponse) this.emit({ kind: 'text_delta', text: response });
      if (response && !this.assistantMessageEmitted) { this.emit({ kind: 'assistant_message', text: response }); this.assistantMessageEmitted = true; }
      this.emit({ kind: 'result', isError: false, numTurns: 1, text: response });
      this.turnFinished = true;
      this.opts.onEnd('done');
    } catch (e: any) {
      if (abort.signal.aborted || this.disposed) this.opts.onEnd('interrupted');
      else {
        const message = redactSecrets(String(e?.message ?? e), this.opts.env).replace(/(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,})/g, '[REDACTED]');
        this.emit({ kind: 'error', message });
        this.opts.onEnd('error', message);
      }
    }
  }

  async interrupt(): Promise<void> {
    this.abortTurn?.abort();
    if (this.nativeId && this.connection) {
      try { await this.connection.request('session/stop', { sessionId: this.nativeId }); } catch { /* runtime may already be gone */ }
    }
    await this.run;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortTurn?.abort();
    if (this.nativeId && this.connection && !this.ended) {
      try { await this.connection.request('session/stop', { sessionId: this.nativeId }); } catch { /* runtime may already be gone */ }
    }
    await this.run;
    // ZCode's session/close deletes its persisted session rows; stop this
    // dedicated app-server process instead so native resume remains possible.
    try { await this.connection?.close(); } finally {
      await this.runtime?.close();
      if (!this.runtime && this.config) await fsp.rm(this.config.tempDir, { recursive: true, force: true });
      this.connection = null; this.bridge = null; this.config = null;
      this.runtime = null;
    }
  }
}

export class ZCodeAdapter implements AgentAdapter {
  readonly id = 'zcode';
  readonly displayName = 'ZCode';
  start(opts: AgentSessionOpts): AgentSessionHandle { return new ZCodeSession(opts); }
}
