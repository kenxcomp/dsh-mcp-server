# dsh-mcp-server

- This is a local stdio MCP server bridging to the official DeepSeek Harness ACP profile. Keep stdout exclusively for MCP frames.
- Build: `npm run build`; type-check: `npm run check`; tests: `npm test`.
- Keep the MCP transport, task lifecycle, ACP worker, and workspace/config validation separate. Source files must stay under 500 lines.
- Never read or print user credentials. Tests use temporary workspaces and fixture ACP agents; live DeepSeek calls require explicitly supplied credentials.
- Workspace roots are canonicalized at admission. `allowed_paths` and acceptance commands are instructions to the worker, not a replacement for the Harness sandbox.
- Do not register clients, publish packages, push commits, or weaken Harness permissions without explicit authorization.
