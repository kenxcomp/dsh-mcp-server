import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCredentialFile } from '../dist/credentials.js';
import { loadConfig } from '../dist/config.js';
import { AcpWorker } from '../dist/acp-worker.js';
import { makeRuntimeRoot } from './helpers.mjs';

const fakeContent = 'version: 1\nrecords:\n  fixture/only:\n    kind: grant\n    payload: fixture-not-a-real-token\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-credential-tests-'));
  const runtimeRoot = await makeRuntimeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const path = join(root, '.credentials.yaml');
  await writeFile(path, fakeContent, { mode: 0o600 });
  return { root, path, runtimeRoot };
}

test('credential-file metadata validation returns its canonical path without modifying it', async t => {
  const context = await fixture(t);
  const before = await stat(context.path);
  assert.equal(await validateCredentialFile(context.path), await realpath(context.path));
  assert.equal(await readFile(context.path, 'utf8'), fakeContent);
  const after = await stat(context.path);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('explicit credential-file references preserve account routing and stay out of child environment', async t => {
  const context = await fixture(t);
  const config = await loadConfig({
    DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([context.root]),
    DSH_MCP_CREDENTIALS_FILE: context.path,
    DSH_MCP_PROVIDER: 'deepseek-account',
    DSH_MCP_MODEL: 'deepseek-flash',
  });
  assert.equal(config.credentialsFile, await realpath(context.path));
  assert.equal(config.provider, 'deepseek-account');
  assert.equal(config.model, 'deepseek-flash');
  assert.equal(config.childEnv.DSH_MCP_CREDENTIALS_FILE, undefined);
  assert.equal(config.childEnv.DEEPSEEK_API_KEY, undefined);
  assert.ok(!JSON.stringify(config).includes('fixture-not-a-real-token'));
});

test('without credential-file opt-in existing environment credential behavior remains intact', async t => {
  const context = await fixture(t);
  const config = await loadConfig({
    DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([context.root]),
    DEEPSEEK_API_KEY: 'fixture-environment-key-not-real',
  });
  assert.equal(config.credentialsFile, undefined);
  assert.equal(config.childEnv.DEEPSEEK_API_KEY, 'fixture-environment-key-not-real');
});

test('credential-file paths must be absolute', async () => {
  await assert.rejects(validateCredentialFile('.credentials.yaml'), /absolute/i);
});

test('credential-file references reject directories and missing files', async t => {
  const context = await fixture(t);
  await assert.rejects(validateCredentialFile(context.root), /file|regular/i);
  await assert.rejects(validateCredentialFile(join(context.root, 'missing.yaml')));
});

test('credential-file references resolve symlinks before using their target identity', async t => {
  const context = await fixture(t);
  const link = join(context.root, 'reference.yaml');
  await symlink(context.path, link);
  assert.equal(await validateCredentialFile(link), await realpath(context.path));
});

test('credential files accessible to other users are refused without changing their permissions',
  { skip: process.platform === 'win32' }, async t => {
    const context = await fixture(t);
    for (const mode of [0o644, 0o640, 0o602]) {
      await chmod(context.path, mode);
      await assert.rejects(validateCredentialFile(context.path), /permission|private|600|owner|readable/i);
      assert.equal((await stat(context.path)).mode & 0o777, mode);
    }
  });

test('an invalid configured credential-file reference fails instead of silently falling back', async t => {
  const context = await fixture(t);
  await assert.rejects(loadConfig({
    DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([context.root]),
    DSH_MCP_CREDENTIALS_FILE: join(context.root, 'missing.yaml'),
    DEEPSEEK_API_KEY: 'fixture-environment-key-not-real',
  }));
});

test('worker composes the saved-credential reference and selected account route without copying credentials', async t => {
  const context = await fixture(t);
  const fixturePath = join(context.root, 'inspect-profile.mjs');
  const inspection = join(context.root, 'inspection.json');
  await writeFile(fixturePath, `
    import { readFile, writeFile, stat } from 'node:fs/promises';
    import { join } from 'node:path';
    const home = process.env.DSH_HOME;
    const patchText = await readFile(join(home, 'profiles/acp/cordis.patch.yml'), 'utf8');
    let copied = true;
    try { await stat(join(home, '.credentials.yaml')); } catch (error) { if (error.code === 'ENOENT') copied = false; else throw error; }
    await writeFile(${JSON.stringify(inspection)}, JSON.stringify({ home, patch: JSON.parse(patchText), patchText, copied,
      fileEnv: process.env.DSH_MCP_CREDENTIALS_FILE, apiEnv: process.env.DEEPSEEK_API_KEY }));
  `);
  const config = await loadConfig({
    DSH_MCP_WORKSPACE_ROOTS: JSON.stringify([context.root]),
    DSH_MCP_CREDENTIALS_FILE: context.path,
    DSH_MCP_PROVIDER: 'deepseek-account',
    DSH_MCP_MODEL: 'deepseek-flash',
    DSH_MCP_COMMAND: process.execPath,
    DSH_MCP_ARGS: JSON.stringify([fixturePath]),
    DSH_MCP_RUNTIME_ROOT: context.runtimeRoot,
  });
  const worker = new AcpWorker(config, {
    ready() {}, update() {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  });
  await assert.rejects(worker.run({ workspace: context.root, objective: 'Inspect fixture profile only', allowed_paths: ['inspection.json'] }));
  const result = JSON.parse(await readFile(inspection, 'utf8'));
  assert.equal(result.patch.find(row => row.id === 'credentials').config.path, await realpath(context.path));
  assert.deepEqual(result.patch.find(row => row.id === 'acp').config, { provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.equal(result.copied, false);
  assert.equal(result.fileEnv, undefined);
  assert.equal(result.apiEnv, undefined);
  assert.ok(!result.patchText.includes('fixture-not-a-real-token'));
  await assert.rejects(access(result.home), { code: 'ENOENT' });
  assert.equal(await readFile(context.path, 'utf8'), fakeContent);
});
