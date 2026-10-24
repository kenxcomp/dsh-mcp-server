// Exercise npm's real Git dependency preparation path from a source-only tree.
// npm ci must run first: --offline reuses its lockfile-backed dependency cache.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'dsh-git-package-'));
const source = join(root, 'source');
const unpacked = join(root, 'unpacked');
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'README.md',
  'LICENSE', 'docs', 'examples', 'skills', 'scripts'];
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', npm_config_offline: 'true',
  npm_config_audit: 'false', npm_config_fund: 'false' };
const options = { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 };

try {
  await mkdir(source);
  await mkdir(unpacked);
  for (const file of files) await cp(join(repo, file), join(source, file), { recursive: true });
  await assert.rejects(access(join(source, 'dist')), { code: 'ENOENT' });
  await run('git', ['-C', source, 'init', '-b', 'main'], options);
  await run('git', ['-C', source, 'add', '--', ...files], options);
  await run('git', ['-C', source, '-c', 'user.name=Package verification',
    '-c', 'user.email=package-check@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-m', 'Create source-only package fixture'], options);

  const args = ['pack', `git+${pathToFileURL(source).href}`, '--offline', '--ignore-scripts=false',
    '--pack-destination', root];
  const npmCli = process.env.npm_execpath;
  await run(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args,
    { ...options, cwd: root });
  const archives = (await readdir(root)).filter(file => file.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'Expected one Git dependency tarball');
  await run('tar', ['-xzf', join(root, archives[0]), '-C', unpacked], options);
  const packageRoot = join(unpacked, 'package');
  const bin = join(packageRoot, 'dist', 'index.js');
  await access(bin);
  // Dependencies are already installed by npm ci; avoid a second consumer
  // resolution, which would need registry packuments even with a lock cache.
  await symlink(join(repo, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  const help = await run(process.execPath, [bin, '--help'], options);
  assert.match(help.stdout, /dsh-mcp-server/);
  assert.match(help.stdout, /DSH_MCP_WORKSPACE_ROOTS/);
  console.log('Git package check passed: source-only prepare produced a runnable dist/index.js');
} finally {
  await rm(root, { recursive: true, force: true });
}
