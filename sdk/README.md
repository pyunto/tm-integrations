# pyunto-tm-sdk

TypeScript SDK for the [Pyunto Time Management](https://tm.pyunto.com) public
REST API (v1), with optional client-side end-to-end-encryption (E2EE)
decryption. Works in Node 18+ and modern browsers.

## Install

```bash
npm install pyunto-tm-sdk
```

## Getting an API key

In the app: **Settings → Account → API keys** — create a key and pick scopes:

| scope | grants |
|---|---|
| `projects:read` | project & task lists |
| `blocks:read` | time blocks |
| `blocks:write` | create time blocks |
| `record:read` | per-day time aggregates |
| `keys:read` | wrapped key material for E2EE decryption |

The plaintext key (`ptm_…`) is shown once — store it securely.

## Plain usage (no crypto needed)

Dates, times, durations and aggregates are always plaintext, and legacy
(non-E2EE) projects return names/memos in plaintext too:

```ts
import { PyuntoTM } from "pyunto-tm-sdk";

const tm = new PyuntoTM({ apiKey: process.env.PTM_KEY! });

// "2h on project #3 / task #12 on the 20th"
const record = await tm.serviceRecord("2026-07-01", "2026-07-31");

// Raw blocks for a day
const blocks = await tm.blocks("2026-07-20", "2026-07-20");

// Log work from your app
await tm.logWork({
  project_id: 3, date: "2026-07-20",
  start_min: 9 * 60, end_min: 10 * 60,
  memo: "Wrote the weekly report",
});
```

## E2EE usage

E2EE projects return `name_enc` / `memo_enc` ciphertext instead of
plaintext. To decrypt, the API key needs the `keys:read` scope and the
**user must enter their account password once** — the password derives the
key that unwraps their private key *locally*; neither the password nor any
decrypted key ever reaches the server (that is the point of E2EE).

```ts
await tm.unlock(passwordFromUserPrompt);   // once per session

const projects = await tm.projects({ decrypt: true }); // names filled in
const blocks = await tm.blocks("2026-07-20", "2026-07-20", { decrypt: true });

// logWork() now encrypts memos client-side for E2EE projects automatically
await tm.logWork({ project_id: 5, date: "2026-07-20", start_min: 540, end_min: 600, memo: "…" });

tm.lock(); // wipe key material when done
```

## Error handling

All API failures throw `PyuntoTMError` with `.status` (HTTP status) and the
server's detail message. `unlock()` throws on a wrong password.

## Endpoints covered

`me()`, `projects()`, `tasks(projectId?)`, `blocks(from, to)`,
`serviceRecord(from, to)`, `logWork(input)`, `unlock(password)`, `lock()`.

Rate limit: 240 requests/minute per key. Date ranges are capped at 92 days.
