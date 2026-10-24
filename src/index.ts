#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('dsh-mcp-server: local MCP stdio bridge to DeepSeek Harness ACP\nEach task requires an explicit absolute workspace directory authorization.\nOptional: DSH_MCP_WORKSPACE_ROOTS (JSON directory array; admission upper bound),\n          DSH_MCP_RUNTIME_ROOT (private control directory outside workspaces/temp),\n          DSH_MCP_COMMAND, DSH_MCP_ARGS, DSH_MCP_MODEL, DSH_MCP_PROVIDER,\n          DSH_MCP_TIMEOUT_SECONDS, DSH_MCP_MAX_CONCURRENCY, DEEPSEEK_API_KEY,\n          DSH_MCP_CREDENTIALS_FILE (existing Harness store; explicit opt-in)\nSee README.md for client setup.\n');
    return;
  }
  const config = await loadConfig();
  const { server, tasks } = createServer(config);
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => shutdown ??= (async () => {
    await tasks.close();
    await server.close();
  })();
  server.server.onclose = () => { void close().catch(() => { process.exitCode = 1; }); };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  }
  // EOF is also observed explicitly: a disconnected MCP client must not leave
  // a coding worker modifying its workspace in the background.
  process.stdin.once('end', () => { void close().catch(() => { process.exitCode = 1; }); });
  // A client can close its read pipe before stdin reaches EOF. Absorb EPIPE
  // and take the same quiescent shutdown path instead of crashing mid-task.
  process.stdout.on('error', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.stdin.on('error', () => { void close().catch(() => { process.exitCode = 1; }); });
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  // Config failures contain names and validation messages, never env contents.
  process.stderr.write(`dsh-mcp-server: ${error instanceof Error ? error.message : 'Startup failed'}\n`);
  process.exitCode = 1;
});
