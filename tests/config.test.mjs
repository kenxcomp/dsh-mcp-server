import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';

test('launcher argument arrays use JSON semantics including whitespace-only empty arrays', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([root]) };
  for (const value of ['[]', '[ ]', '[\n\t]']) {
    assert.deepEqual((await loadConfig({ ...env, DSH_MCP_ARGS: value })).args, []);
  }
  assert.deepEqual((await loadConfig(env)).args, ['--profile', 'acp']);
  for (const value of ['{}', '[1]', '[""]']) {
    await assert.rejects(loadConfig({ ...env, DSH_MCP_ARGS: value }), /DSH_MCP_ARGS/);
  }
  await assert.rejects(loadConfig({ DSH_MCP_WORKSPACE_ROOTS: '[]' }), /DSH_MCP_WORKSPACE_ROOTS/);
});
