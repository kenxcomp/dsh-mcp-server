# dsh-mcp-server

- This is a local stdio MCP server bridging to the official DeepSeek Harness ACP profile. Keep stdout exclusively for MCP frames.
- Build: `npm run build`; type-check: `npm run check`; tests: `npm test`.
- Keep the MCP transport, task lifecycle, ACP worker, and workspace/config validation separate. Source files must stay under 500 lines.
- Never read or print user credentials. Tests use temporary workspaces and fixture ACP agents; live DeepSeek calls require explicitly supplied credentials.
- Every task explicitly authorizes its canonical `workspace`; optional server roots only cap admission. Keep that directory as the Harness write root, reject scope-widening permissions, and never inherit another task's grant. Native reads and temporary writes remain available. `allowed_paths` and acceptance commands are instructions, not a file sandbox.
- Keep per-task control homes in a private runtime root outside task workspaces and native writable temporary areas; validate ownership, permissions and path separation before launch.
- Do not register clients, publish packages, push commits, or weaken Harness permissions without explicit authorization.
