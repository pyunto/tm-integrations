# pyunto-tm-mcp

MCP (Model Context Protocol) server for
[Pyunto Time Management](https://tm.pyunto.com). Connects Claude Code, Claude
Desktop, Codex CLI, Cursor and any other MCP client to a Pyunto TM account so an
assistant can read the schedule, summarise where the hours went, and log time.

**User-facing setup instructions live at
<https://tm.pyunto.com/docs/mcp.en.md>** (日本語:
<https://tm.pyunto.com/docs/mcp.ja.md>). This file is the developer view.

## Tools

| Tool | Scope |
|---|---|
| `whoami` — account, key name, scopes, decryption status | — |
| `list_projects` | `projects:read` |
| `list_tasks` (filter by project or by a date the task covers) | `projects:read` |
| `list_time_blocks` (range ≤ 92 days) | `blocks:read` |
| `time_summary` (grouped by project / task / date) | `record:read` |
| `log_time` (**writes**) | `blocks:write` |

Every tool returns JSON as text. Failures come back as `isError` results whose
message names the fix (missing scope, wrong key, locked E2EE) rather than
throwing at the transport level — an agent can act on that, a stack trace it
cannot.

## Install

```bash
npx -y pyunto-tm-mcp        # what an MCP client config runs
```

## Build from source

This package lives in an npm-workspaces repository together with the SDK it
depends on; build from the repository root so the workspace link is used:

```bash
npm install
npm run build                 # both packages
npm test                      # sdk crypto round-trips + 25 MCP tool checks
```

Result: `mcp/dist/index.js`, an executable stdio server.

## Configuration

Environment only — MCP clients spawn the process and inject env from their
config file.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PYUNTO_TM_API_KEY` | ✅ | — | `ptm_…`, minted in Settings → Account → API keys |
| `PYUNTO_TM_BASE_URL` | | `https://tm.pyunto.com` | Self-hosted instances |
| `PYUNTO_TM_PASSWORD` | | none | Unwraps the private key locally so E2EE names/memos decrypt |
| `PYUNTO_TM_PASSWORD_FILE` | | none | Same, read from a file instead of the env |

```json
{
  "mcpServers": {
    "pyunto-tm": {
      "command": "npx",
      "args": ["-y", "pyunto-tm-mcp"],
      "env": { "PYUNTO_TM_API_KEY": "ptm_…" }
    }
  }
}
```

## How E2EE is handled

Content fields are encrypted in the user's browser; the server never holds the
plaintext, and neither does this process by default. Given a password, the
server's *password-wrapped* private key blob (`GET /api/v1/keys`, scope
`keys:read`) is unwrapped **here**, in memory, and used to open each project's
sealed DEK. The password is never transmitted and nothing is written to disk.

Without a password the server still answers everything schedule-shaped — ids,
dates, times, durations, aggregates — and name fields come back empty with a
`NOTE:` explaining why, so the model reports the limitation instead of inventing
names.

## Layout

```
src/index.ts     tool definitions + implementations + stdio wiring
test/tools.mjs   stub /api/v1 server, exercises every tool and error path
```

`callTool(name, args)` is exported for tests; the stdio transport only starts
when the file is executed directly.
