import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const repo = dirname(dirname(fileURLToPath(import.meta.url)));
export const fixture = join(repo, 'tests/fixtures/acp-agent.mjs');
export const fixtureKey = 'sk-fixture-only-never-a-real-credential';
export const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

export async function setup(t, overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-mcp-tests-'));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const env = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
    DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([root]),
    DSH_MCP_COMMAND: process.execPath,
    DSH_MCP_ARGS: JSON.stringify([fixture]),
    DEEPSEEK_API_KEY: fixtureKey,
    UNRELATED_SECRET_TOKEN: 'must-not-reach-worker',
    DSH_PERMISSION_MODE: 'danger-full-access',
    ...overrides,
  };
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(repo, 'dist/index.js')], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const errors = [];
  client.onerror = error => errors.push(error);
  t.after(async () => {
    await client.close();
    await rm(base, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { client, transport, root, outside, base, env, errors, stderr: () => stderr };
}

export async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

export function data(result) {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

export async function submit(context, objective, extra = {}) {
  return data(await call(context.client, 'dsh_submit_task', {
    workspace: context.root, objective, allowed_paths: ['result.txt', '.fixture-runtime.json'], ...extra,
  }));
}

export async function waitTask(context, id, predicate = task => terminal.has(task.status), timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    task = data(await call(context.client, 'dsh_get_task', { task_id: id }));
    if (predicate(task)) return task;
    await delay(25);
  }
  assert.fail(`Task did not reach expected state: ${JSON.stringify(task)}`);
}

export function assertError(result, pattern) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content.map(item => item.text ?? '').join(''), pattern);
}
