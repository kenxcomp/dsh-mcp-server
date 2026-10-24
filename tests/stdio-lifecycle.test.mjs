import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, fixtureKey, repo, makeRuntimeRoot } from './helpers.mjs';

for (const disconnect of ['stdin EOF', 'stdout EPIPE']) {
test(`stdio carries only JSON-RPC and ${disconnect} stops the worker and removes its home`, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-mcp-disconnect-'));
  const runtimeRoot = await makeRuntimeRoot();
  const child = spawn(process.execPath, [join(repo, 'dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
      DSH_MCP_COMMAND: process.execPath, DSH_MCP_ARGS: JSON.stringify([fixture]),
      DSH_MCP_RUNTIME_ROOT: runtimeRoot,
      DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([workspace]), DEEPSEEK_API_KEY: fixtureKey },
  });
  t.after(async () => {
    child.kill('SIGKILL');
    await rm(workspace, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const frames = [];
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    frames.push(line);
    try {
      const frame = JSON.parse(line);
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    } catch { /* Assert all raw frames after the complete lifecycle below. */ }
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let nextId = 1;
  async function request(method, params) {
    const id = nextId++;
    let timer;
    try {
      const value = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No response to ${method}`)), 5000);
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      return await value;
    } finally { clearTimeout(timer); }
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' },
  });
  assert.equal(initialized.result.serverInfo.name, 'dsh-mcp-server');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const submitted = await request('tools/call', { name: 'dsh_submit_task', arguments: {
    workspace, objective: 'fixture:hang', allowed_paths: ['.fixture-runtime.json'],
  } });
  const task = submitted.result.structuredContent;
  const deadline = Date.now() + 5000;
  let status;
  while (Date.now() < deadline) {
    const response = await request('tools/call', {
      name: 'dsh_get_task', arguments: { task_id: task.task_id },
    });
    status = response.result.structuredContent.status;
    if (status === 'running') break;
    await delay(25);
  }
  assert.equal(status, 'running');
  const runtime = JSON.parse(await readFile(join(workspace, '.fixture-runtime.json'), 'utf8'));
  if (disconnect === 'stdin EOF') {
    child.stdin.end();
  } else {
    child.stdout.destroy();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call',
      params: { name: 'dsh_get_task', arguments: { task_id: task.task_id } } })}\n`);
  }
  let killTimer;
  const stopped = await Promise.race([
    exit,
    new Promise((_resolve, reject) => {
      killTimer = setTimeout(() => reject(new Error(`MCP server did not exit after ${disconnect}`)), 5000);
    }),
  ]).finally(() => clearTimeout(killTimer));
  assert.equal(stopped.code, 0, stderr);
  assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(runtime.home), { code: 'ENOENT' });
  assert.ok(frames.length >= 3);
  for (const line of frames) {
    const frame = JSON.parse(line);
    assert.equal(frame.jsonrpc, '2.0');
    assert.ok(!line.includes(fixtureKey));
  }
  assert.equal(stderr, '');
});
}
