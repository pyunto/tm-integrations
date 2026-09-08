/**
 * End-to-end check of the executable entry point.
 *
 * Regression guard for a real 0.1.0 defect: index.ts decided whether to
 * start the transport by comparing import.meta.url with process.argv[1].
 * npm and npx launch a package's bin through a symlink in
 * node_modules/.bin, so argv[1] is the link and import.meta.url is the
 * resolved file — they never matched, and `npx @pyunto/tm-mcp` exited 0
 * without a word. Unit tests could not see it because they import the
 * module directly.
 *
 * So this test spawns the built CLI *through a symlink*, the way a client
 * does, and speaks real MCP to it.
 *
 *   node test/cli.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");

/** Feed the server some JSON-RPC over stdin, collect stdout/stderr. */
function run(entry, env, lines) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => done({ code, out, err }));
    for (const l of lines) child.stdin.write(JSON.stringify(l) + "\n");
    child.stdin.end();
    // The server keeps running after stdin closes in some Node versions;
    // it has answered by then, so stop waiting.
    setTimeout(() => child.kill(), 4000);
  });
}

const HANDSHAKE = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "test", version: "1.0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];

function replies(out) {
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let n = 0;
const check = (label, fn) => { fn(); n++; console.log("  ok", label); };

// 1. Launched directly.
console.log("direct launch");
const direct = await run(CLI, { PYUNTO_TM_API_KEY: "ptm_test" }, HANDSHAKE);
check("announces itself on stderr", () =>
  assert.match(direct.err, /pyunto-tm MCP server ready/));
check("answers initialize", () => {
  const r = replies(direct.out).find((x) => x.id === 1);
  assert.ok(r, "no reply to initialize");
  assert.equal(r.result.serverInfo.name, "pyunto-tm");
});
check("lists its tools", () => {
  const r = replies(direct.out).find((x) => x.id === 2);
  assert.ok(r, "no reply to tools/list");
  const names = r.result.tools.map((t) => t.name);
  for (const expected of ["whoami", "list_projects", "list_tasks",
                          "list_time_blocks", "time_summary", "log_time",
                          "update_time_block", "delete_time_block",
                          "list_deleted_time_blocks", "restore_time_block"]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

// 2. Launched through a symlink — what npx actually does.
console.log("launch through a symlink (npx-style)");
const dir = mkdtempSync(join(tmpdir(), "ptm-bin-"));
const link = join(dir, "pyunto-tm-mcp");
symlinkSync(CLI, link);
const linked = await run(link, { PYUNTO_TM_API_KEY: "ptm_test" }, HANDSHAKE);
rmSync(dir, { recursive: true, force: true });
check("still starts", () => assert.match(linked.err, /pyunto-tm MCP server ready/));
check("still answers", () => {
  const r = replies(linked.out).find((x) => x.id === 2);
  assert.ok(r, "no reply to tools/list through the symlink");
  // Same tool set as the direct launch — pinned by name, not by a count
  // that every new tool would break.
  assert.deepEqual(
    r.result.tools.map((t) => t.name).sort(),
    replies(direct.out).find((x) => x.id === 2).result.tools.map((t) => t.name).sort());
});

// 3. Misconfiguration is reported, not silent.
console.log("missing API key");
const noKey = await run(CLI, { PYUNTO_TM_API_KEY: "" }, []);
check("exits non-zero", () => assert.notEqual(noKey.code, 0));
check("says which variable to set", () =>
  assert.match(noKey.err, /PYUNTO_TM_API_KEY is not set/));
check("keeps stdout clean for the protocol", () => assert.equal(noKey.out, ""));

console.log(`\n${n} checks passed`);
