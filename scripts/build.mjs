// esbuild 构建：main / preload(cjs) / renderer；SDK 与原生模块保持 external
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testMode = process.argv.includes('--test');

const common = { bundle: true, sourcemap: 'inline', logLevel: 'silent', target: 'node24' };

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'dist/main'), { recursive: true });

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src/main/main.ts'), path.join(root, 'src/main/mcp/entry.ts')],
  outdir: path.join(root, 'dist/main'),
  format: 'esm',
  platform: 'node',
  external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod', 'node:*'],
  outbase: 'src/main',
  banner: {
    js: `import __fsDef from 'node:fs';
process.on('uncaughtException', (e) => {
  try { __fsDef.appendFileSync('/tmp/wb-main-errors.log', '[uncaughtException] ' + (e && e.stack || String(e)) + '\\n'); } catch {}
  process.exit(2);
});
process.on('unhandledRejection', (e) => {
  try { __fsDef.appendFileSync('/tmp/wb-main-errors.log', '[unhandledRejection] ' + (e && (e.stack || e.message) || String(e)) + '\\n'); } catch {}
});
if (process.env.WORKBENCH_TRACE_FS === '1') {
  const __origRS = __fsDef.readdirSync.bind(__fsDef);
  let __n = 0;
  const __wrap = (fn) => function (...a) {
    if (++__n > 300) {
      try { __fsDef.appendFileSync('/tmp/wb-fstrace.log', 'DEPTH ' + __n + '\\n' + new Error().stack + '\\n---\\n'); } catch {}
      if (__n > 360) process.abort();
    }
    return fn.apply(this, a);
  };
  Object.defineProperty(__fsDef, 'readdirSync', { value: __wrap(__fsDef.readdirSync), writable: true, configurable: true });
  Object.defineProperty(__fsDef, 'readdir', { value: __wrap(__fsDef.readdir), writable: true, configurable: true });
}`,
  },
});

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(root, 'dist/preload/preload.cjs'),
  format: 'cjs',
  platform: 'node',
  external: ['electron'],
});

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src/renderer/app.tsx')],
  outfile: path.join(root, 'dist/renderer/app.js'),
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});

fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(root, 'dist/renderer/index.html'));
fs.copyFileSync(path.join(root, 'src/renderer/styles.css'), path.join(root, 'dist/renderer/styles.css'));

if (testMode) {
  const testFiles = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.ts'));
  await esbuild.build({
    ...common,
    entryPoints: testFiles.map((f) => path.join(root, 'tests', f)),
    outdir: path.join(root, 'dist-test'),
    format: 'esm',
    platform: 'node',
    external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod', 'node:*'],
  });
}

console.log('build ok', testMode ? '(含测试)' : '');
