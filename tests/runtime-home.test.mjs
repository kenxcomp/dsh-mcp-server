import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRuntimeHome } from '../dist/runtime-home.js';
import { loadConfig, workspace } from '../dist/config.js';
import { contains } from '../dist/paths.js';
import { makeRuntimeRoot } from './helpers.mjs';

async function context(t) {
  const control = await makeRuntimeRoot();
  const work = await mkdtemp(join(tmpdir(), 'dsh-home-workspace-'));
  t.after(async () => {
    await rm(control, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });
  return { control, work };
}

test('task control homes are private, unique and separate from workspace and shared temp grants', async t => {
  const { control, work } = await context(t);
  const first = await createRuntimeHome(control, work, {});
  const second = await createRuntimeHome(control, work, {});
  assert.notEqual(first, second);
  assert.ok(contains(control, first));
  assert.ok(!contains(work, first));
  assert.ok(!contains(tmpdir(), first));
  if (process.platform !== 'win32') assert.equal((await stat(first)).mode & 0o777, 0o700);
});

test('control homes reject native and explicitly configured worker temporary directories', async t => {
  const { control, work } = await context(t);
  const unsafe = join(work, 'runtime');
  await assert.rejects(createRuntimeHome(unsafe, control, {}), /temporary/);
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    await assert.rejects(createRuntimeHome(join(control, 'runs'), work, { [key]: control }), /temporary/);
  }
});

test('workspace grants cannot include or reside inside the private control root', async t => {
  const { control } = await context(t);
  const child = join(control, 'project');
  await mkdir(child);
  const config = await loadConfig({ DSH_MCP_RUNTIME_ROOT: control });
  for (const candidate of [control, child, dirname(control)]) {
    await assert.rejects(workspace(config, candidate), /overlap.*runtime/);
  }
});

test('runtime root configuration and filesystem metadata fail closed', async t => {
  const { control, work } = await context(t);
  await assert.rejects(loadConfig({ DSH_MCP_RUNTIME_ROOT: 'relative' }), /absolute/);
  const alias = join(control, 'alias');
  const target = join(control, 'target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, alias, 'dir');
  await assert.rejects(createRuntimeHome(alias, work, {}), /private directory/);
  if (process.platform !== 'win32') {
    await chmod(control, 0o755);
    await assert.rejects(createRuntimeHome(control, work, {}), /private directory/);
  }
});
