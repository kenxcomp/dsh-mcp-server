import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { contains } from './paths.js';

export function defaultRuntimeRoot(): string {
  return join(homedir(), '.local', 'state', 'dsh-mcp-server', 'runs');
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(path);
  }
}

export async function assertSeparateRuntimeRoot(workspace: string, root: string): Promise<void> {
  const control = await canonical(root);
  if (contains(workspace, control) || contains(control, workspace)) {
    throw new Error('Task workspace must not overlap the MCP private runtime directory');
  }
}

/** Keep executable policy outside both delegated workspaces and native temp grants. */
export async function createRuntimeHome(root: string, workspace: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!isAbsolute(root)) throw new Error('DSH_MCP_RUNTIME_ROOT must be absolute');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0))) {
    throw new Error('MCP runtime directory must be a private directory owned by the current user (mode 700)');
  }
  const control = await realpath(root);
  for (const temp of [tmpdir(), '/tmp', env.TMPDIR, env.TMP, env.TEMP]) {
    if (temp && isAbsolute(temp) && contains(await canonical(temp), control)) {
      throw new Error('MCP runtime directory must be outside Harness-writable temporary directories');
    }
  }
  await assertSeparateRuntimeRoot(workspace, control);
  return mkdtemp(join(control, 'task-'));
}
