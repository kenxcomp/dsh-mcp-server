import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { call, data, assertError, fixture, fixtureKey, repo, waitTask, makeRuntimeRoot } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';

async function setup(t, capped = false) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-task-workspace-'));
  const runtimeRoot = await makeRuntimeRoot();
  const serverDirectory = join(base, 'server');
  const left = join(base, 'left');
  const right = join(base, 'right');
  await Promise.all([serverDirectory, left, right].map(path => mkdir(path)));
  const launcher = join(serverDirectory, 'fixture-launcher.mjs');
  await writeFile(launcher, `
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    await writeFile(join(process.cwd(), '.process-cwd.txt'), process.cwd());
    await import(${JSON.stringify(pathToFileURL(fixture).href)});
  `);
  const env = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
    DSH_MCP_COMMAND: process.execPath, DSH_MCP_ARGS: JSON.stringify([launcher]),
    DEEPSEEK_API_KEY: fixtureKey,
    DSH_MCP_RUNTIME_ROOT: runtimeRoot,
  };
  if (capped) env.DSH_MCP_WORKSPACE_ROOTS = JSON.stringify([left]);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(repo, 'dist/index.js')], cwd: serverDirectory, env, stderr: 'pipe' });
  const client = new Client({ name: 'task-workspace-test', version: '1' });
  t.after(async () => {
    await client.close();
    await rm(base, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { client, base, serverDirectory, left, right };
}

function taskArguments(workspace) {
  return { workspace, objective: 'fixture:normal',
    allowed_paths: ['result.txt', '.fixture-runtime.json', '.process-cwd.txt'] };
}

test('each task explicitly chooses its canonical workspace and actual worker cwd without a server-wide root', async t => {
  const context = await setup(t);
  const alias = join(context.base, 'left-alias');
  await symlink(context.left, alias, 'dir');
  for (const requested of [alias, context.right]) {
    const canonical = await realpath(requested);
    const started = data(await call(context.client, 'dsh_submit_task', taskArguments(requested)));
    assert.equal(started.workspace, canonical);
    const finished = await waitTask(context, started.task_id);
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(finished.workspace, canonical);
    assert.equal(await readFile(join(canonical, '.process-cwd.txt'), 'utf8'), canonical);
    assert.equal(await readFile(join(canonical, 'result.txt'), 'utf8'), 'fixture verified\n');
  }
  await assert.rejects(access(join(context.serverDirectory, '.process-cwd.txt')), { code: 'ENOENT' });
  await assert.rejects(access(join(context.serverDirectory, 'result.txt')), { code: 'ENOENT' });
});

test('a task cannot inherit the server directory or authorize a missing, relative or filesystem-root workspace', async t => {
  const context = await setup(t);
  const { workspace: _workspace, ...missing } = taskArguments(context.left);
  assertError(await call(context.client, 'dsh_submit_task', missing), /workspace|validation|Invalid/i);
  for (const requested of ['.', join(context.base, 'missing'), parse(context.base).root]) {
    assertError(await call(context.client, 'dsh_submit_task', taskArguments(requested)), /absolute|ENOENT|exist|root/i);
  }
  assert.deepEqual(data(await call(context.client, 'dsh_list_tasks')).tasks, []);
  await assert.rejects(access(join(context.serverDirectory, '.process-cwd.txt')), { code: 'ENOENT' });
});

test('an explicitly configured administrative root still rejects outside task directories and escaping aliases', async t => {
  const context = await setup(t, true);
  const escape = join(context.left, 'outside-link');
  await symlink(context.right, escape, 'dir');
  for (const requested of [context.right, escape]) {
    assertError(await call(context.client, 'dsh_submit_task', taskArguments(requested)), /outside DSH_MCP_WORKSPACE_ROOTS/);
  }
  const started = data(await call(context.client, 'dsh_submit_task', taskArguments(context.left)));
  assert.equal((await waitTask(context, started.task_id)).status, 'completed');
  await assert.rejects(loadConfig({ DSH_MCP_WORKSPACE_ROOTS: '[]' }), /DSH_MCP_WORKSPACE_ROOTS/);
});
