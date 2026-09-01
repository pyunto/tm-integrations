# Pyunto Time Management — integrations

Open-source client libraries for [Pyunto Time Management](https://tm.pyunto.com),
a time-management and project-planning service with end-to-end encryption.

| Package | What it is |
|---|---|
| [`@pyunto/tm-sdk`](./sdk) | TypeScript client for the public REST API (v1), with client-side E2EE decryption |
| [`@pyunto/tm-mcp`](./mcp) | MCP (Model Context Protocol) server — connects Claude Code, Claude Desktop, Codex CLI, Cursor and other AI clients to an account |

**The service itself is not open source.** This repository contains only the
client side: HTTP calls against the documented public API, plus the crypto
needed to decrypt your own data locally. There is nothing here that talks to the
database, handles billing, or holds a key.

## Why this part is public

The MCP server can be given **your account password** so it can decrypt project
and task names. That is a lot to ask of a program you cannot read, so this is
the part we publish: you can verify for yourself that the password is used only
to unwrap the private key in your own process, and is never transmitted.

See [`sdk/src/crypto.ts`](./sdk/src/crypto.ts) for the primitives and
[`mcp/src/index.ts`](./mcp/src/index.ts) for how they're used.

## Quick start (MCP)

No clone needed — the published package runs straight from npm:

```bash
claude mcp add pyunto-tm \
  --env PYUNTO_TM_API_KEY=ptm_your_key \
  -- npx -y @pyunto/tm-mcp
```

Full setup instructions, including Claude Desktop, Codex CLI and Cursor:
**<https://tm.pyunto.com/docs/mcp.en.md>** (日本語:
<https://tm.pyunto.com/docs/mcp.ja.md>).

Get an API key from **Settings → Account → API keys** in the app. Scopes decide
what an integration may read or write, and a key can be revoked at any time.

## Quick start (SDK)

```bash
npm install @pyunto/tm-sdk
```

```ts
import { PyuntoTM } from "@pyunto/tm-sdk";

const tm = new PyuntoTM({ apiKey: process.env.PTM_KEY! });

// Dates, durations and aggregates need no key material at all
const record = await tm.serviceRecord("2026-08-01", "2026-08-31");

// Names and memos are encrypted; unlock decrypts them locally
await tm.unlock(process.env.PTM_PASSWORD!);
const projects = await tm.projects({ decrypt: true });
```

## Development

npm workspaces; Node 18+.

```bash
npm install
npm run build     # both packages
npm test          # sdk crypto round-trips + mcp tools against a stub API
```

`mcp` depends on `@pyunto/tm-sdk` by version, so the published package resolves
it from the registry while local development links the workspace copy.

## Security

Found a problem in this code, or in the service? Please report it privately
rather than opening a public issue: **support@pyunto.com**.

## Licence

MIT — see [LICENSE](./LICENSE).
