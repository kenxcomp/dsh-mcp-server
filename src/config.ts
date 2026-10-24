import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, parse } from 'node:path';
import { z } from 'zod';
import { validateCredentialFile } from './credentials.js';
import { contains } from './paths.js';
import { assertSeparateRuntimeRoot, defaultRuntimeRoot } from './runtime-home.js';

export interface Config {
  roots?: string[];
  command: string;
  args: string[];
  provider: string;
  model: string;
  concurrency: number;
  maxTasks: number;
  timeoutSeconds: number;
  childEnv: NodeJS.ProcessEnv;
  credentialsFile?: string;
  runtimeRoot: string;
}

function stringArray(value: string | undefined, name: string, fallback?: string[], minimum = 1): string[] {
  if (value === undefined && fallback) return fallback;
  try {
    return z.array(z.string().min(1)).min(minimum).parse(JSON.parse(value ?? ''));
  } catch {
    throw new Error(`${name} must be a ${minimum ? 'non-empty ' : ''}JSON array of strings`);
  }
}

function integer(value: string | undefined, fallback: number, max: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return result;
}

export async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Workspace paths must be absolute');
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace must be a directory');
  return canonical;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const roots = env.DSH_MCP_WORKSPACE_ROOTS === undefined ? undefined
    : await Promise.all(stringArray(env.DSH_MCP_WORKSPACE_ROOTS, 'DSH_MCP_WORKSPACE_ROOTS').map(directory));
  const credentialsFile = env.DSH_MCP_CREDENTIALS_FILE === undefined ? undefined
    : await validateCredentialFile(env.DSH_MCP_CREDENTIALS_FILE);
  const runtimeRoot = env.DSH_MCP_RUNTIME_ROOT ?? defaultRuntimeRoot();
  if (!isAbsolute(runtimeRoot)) throw new Error('DSH_MCP_RUNTIME_ROOT must be absolute');
  // Only explicitly needed environment crosses into the worker. In particular,
  // ambient cloud/provider tokens and NODE_OPTIONS are not inherited.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT',
    'LANG', 'LC_ALL', 'DEEPSEEK_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  return {
    roots: roots === undefined ? undefined : [...new Set(roots)],
    command: env.DSH_MCP_COMMAND || 'dsh',
    args: stringArray(env.DSH_MCP_ARGS, 'DSH_MCP_ARGS', ['--profile', 'acp'], 0),
    provider: env.DSH_MCP_PROVIDER || 'deepseek-official',
    model: env.DSH_MCP_MODEL || 'deepseek-v4-flash',
    concurrency: integer(env.DSH_MCP_MAX_CONCURRENCY, 2, 8, 'DSH_MCP_MAX_CONCURRENCY'),
    maxTasks: 100,
    timeoutSeconds: integer(env.DSH_MCP_TIMEOUT_SECONDS, 600, 3600, 'DSH_MCP_TIMEOUT_SECONDS'),
    childEnv,
    credentialsFile,
    runtimeRoot,
  };
}

export async function workspace(config: Config, requested: string): Promise<string> {
  const canonical = await directory(requested);
  if (canonical === parse(canonical).root) {
    throw new Error('Task workspace must be a specific project directory, not a filesystem root');
  }
  if (config.roots && !config.roots.some(root => contains(root, canonical))) {
    throw new Error('Workspace is outside DSH_MCP_WORKSPACE_ROOTS');
  }
  await assertSeparateRuntimeRoot(canonical, config.runtimeRoot);
  return canonical;
}
