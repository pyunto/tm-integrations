/**
 * MCP tool tests. Runs the real tool implementations against a stub HTTP
 * server that speaks the /api/v1 contract, so argument handling, name
 * resolution, aggregation and error messages are all covered without
 * touching a live account.
 *
 *   node test/tools.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

// ── Stub API ─────────────────────────────────────────────────────────────────

const PROJECTS = [
  { id: 1, name: "Alpha", name_enc: null, color: "#f00", role: "owner",
    is_shared: false, encryption_version: 0, dek_sealed: null },
  { id: 2, name: "Beta", name_enc: null, color: "#0f0", role: "viewer",
    is_shared: true, encryption_version: 0, dek_sealed: null },
];
const TASKS = [
  { id: 10, project_id: 1, name: "Design", name_enc: null,
    start_date: "2026-07-01", end_date: "2026-07-10", parent_task_id: null, assignee_id: null },
  { id: 11, project_id: 1, name: "Build", name_enc: null,
    start_date: "2026-07-11", end_date: "2026-07-31", parent_task_id: null, assignee_id: null },
];
const BLOCKS = [
  { id: 100, project_id: 1, task_id: 10, date: "2026-07-02", start_min: 540, end_min: 660,
    memo: "kickoff", memo_enc: null, created_by: 1 },
  { id: 101, project_id: 1, task_id: 11, date: "2026-07-02", start_min: 780, end_min: 810,
    memo: "scaffolding", memo_enc: null, created_by: 1 },
  { id: 102, project_id: 2, task_id: null, date: "2026-07-03", start_min: 600, end_min: 630,
    memo: "review", memo_enc: null, created_by: 1 },
];

const posted = [];
const patched = [];
const deleted = [];
const softDeleted = [];
const restored = [];

function stub() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const send = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== "Bearer ptm_test") return send(401, { detail: "bad key" });

      if (url.pathname === "/api/v1/me") {
        return send(200, { email: "a@b.c", key_name: "test", scopes: ["projects:read"] });
      }
      if (url.pathname === "/api/v1/projects") return send(200, PROJECTS);
      if (url.pathname === "/api/v1/tasks") return send(200, TASKS);
      if (url.pathname === "/api/v1/blocks" && req.method === "GET") {
        const f = url.searchParams.get("date_from"), t = url.searchParams.get("date_to");
        return send(200, BLOCKS.filter((b) => b.date >= f && b.date <= t));
      }
      if (url.pathname === "/api/v1/blocks" && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const body = JSON.parse(raw);
          posted.push(body);
          send(201, { id: 999, memo: body.memo ?? "", memo_enc: null, created_by: 1, ...body,
                      start_min: body.start_min, end_min: body.end_min });
        });
        return;
      }
      const patchMatch = /^\/api\/v1\/blocks\/(\d+)$/.exec(url.pathname);
      if (patchMatch && req.method === "PATCH") {
        const id = Number(patchMatch[1]);
        const target = BLOCKS.find((b) => b.id === id);
        if (!target) return send(404, { detail: "block not found" });
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const body = JSON.parse(raw);
          patched.push({ id, body });
          send(200, { ...target, ...body, memo: body.memo ?? target.memo });
        });
        return;
      }
      if (url.pathname === "/api/v1/blocks/deleted" && req.method === "GET") {
        return send(200, softDeleted.map((b) => ({
          ...b, deleted_at: "2026-09-08T01:00:00+00:00",
          restorable_until: "2026-09-22T01:00:00+00:00",
        })));
      }
      const restoreMatch = /^\/api\/v1\/blocks\/(\d+)\/restore$/.exec(url.pathname);
      if (restoreMatch && req.method === "POST") {
        const id = Number(restoreMatch[1]);
        const i = softDeleted.findIndex((b) => b.id === id);
        if (i < 0) return send(404, { detail: "block not found" });
        const [back] = softDeleted.splice(i, 1);
        restored.push(id);
        return send(200, back);
      }
      if (patchMatch && req.method === "DELETE") {
        const id = Number(patchMatch[1]);
        const target = BLOCKS.find((b) => b.id === id);
        if (!target) return send(404, { detail: "block not found" });
        deleted.push(id);
        softDeleted.push(target);
        return send(200, target);
      }
      if (url.pathname === "/api/v1/service-record") {
        const f = url.searchParams.get("date_from"), t = url.searchParams.get("date_to");
        return send(200, BLOCKS.filter((b) => b.date >= f && b.date <= t).map((b) => ({
          date: b.date, project_id: b.project_id, task_id: b.task_id,
          minutes: b.end_min - b.start_min, created_by: b.created_by,
        })));
      }
      send(404, { detail: "not found" });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────

const srv = await stub();
const port = srv.address().port;
process.env.PYUNTO_TM_API_KEY = "ptm_test";
process.env.PYUNTO_TM_BASE_URL = `http://127.0.0.1:${port}`;
delete process.env.PYUNTO_TM_PASSWORD;

const { callTool, toMinutes, TOOLS } = await import("../dist/index.js");

const json = (r) => JSON.parse(r.content[0].text.split("\n\nNOTE:")[0]);
let n = 0;
const check = (label, fn) => { fn(); n++; console.log("  ok", label); };

console.log("time parsing");
check("HH:MM", () => assert.equal(toMinutes("09:30", "start"), 570));
check("H:MM", () => assert.equal(toMinutes("9:30", "start"), 570));
check("raw minutes as number", () => assert.equal(toMinutes(570, "start"), 570));
check("raw minutes as string", () => assert.equal(toMinutes("570", "start"), 570));
check("garbage rejected", () => assert.throws(() => toMinutes("half past nine", "start")));
check("out of range rejected", () => assert.throws(() => toMinutes("25:00", "start")));

console.log("tool manifest");
check("every tool has a description and schema", () => {
  for (const t of TOOLS) {
    assert.ok(t.name && t.description && t.inputSchema, `incomplete tool: ${t.name}`);
    assert.equal(t.inputSchema.type, "object");
  }
});
check("names are unique", () =>
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length));
check("the write tool is present and flagged in its description", () => {
  const w = TOOLS.find((t) => t.name === "log_time");
  assert.ok(w && /confirm/i.test(w.description));
});

console.log("whoami");
const who = json(await callTool("whoami", {}));
check("reports the account", () => assert.equal(who.email, "a@b.c"));
check("reports E2EE off when no password is set", () =>
  assert.match(who.e2ee_decryption, /disabled/));

console.log("list_projects");
const projs = json(await callTool("list_projects", {}));
check("returns both projects with roles", () => {
  assert.equal(projs.length, 2);
  assert.equal(projs[0].name, "Alpha");
  assert.equal(projs[1].role, "viewer");
});

console.log("list_tasks");
const allTasks = json(await callTool("list_tasks", {}));
check("lists every task with its project name", () => {
  assert.equal(allTasks.length, 2);
  assert.equal(allTasks[0].project, "Alpha");
});
const filtered = json(await callTool("list_tasks", { active_on: "2026-07-05" }));
check("active_on keeps only tasks covering that day", () => {
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, "Design");
});
const badDate = await callTool("list_tasks", { active_on: "07/05/2026" });
check("bad active_on is an error, not a crash", () => {
  assert.equal(badDate.isError, true);
  assert.match(badDate.content[0].text, /YYYY-MM-DD/);
});

console.log("list_time_blocks");
const blocks = json(await callTool("list_time_blocks",
  { date_from: "2026-07-01", date_to: "2026-07-31" }));
check("totals the range", () => assert.equal(blocks.total_hours, 3));
check("formats times and resolves names", () => {
  const b = blocks.blocks[0];
  assert.equal(b.start, "09:00");
  assert.equal(b.end, "11:00");
  assert.equal(b.hours, 2);
  assert.equal(b.project, "Alpha");
  assert.equal(b.task, "Design");
});

console.log("time_summary");
const byProject = json(await callTool("time_summary",
  { date_from: "2026-07-01", date_to: "2026-07-31" }));
check("groups by project, largest first", () => {
  assert.equal(byProject.total_hours, 3);
  assert.equal(byProject.items[0].project, "Alpha");
  assert.equal(byProject.items[0].hours, 2.5);
  assert.equal(byProject.items[1].hours, 0.5);
});
const byTask = json(await callTool("time_summary",
  { date_from: "2026-07-01", date_to: "2026-07-31", group_by: "task" }));
check("groups by task, labelling untasked time", () => {
  assert.equal(byTask.items.length, 3);
  assert.ok(byTask.items.some((i) => i.task === "Design" && i.hours === 2));
  assert.ok(byTask.items.some((i) => i.task === "(no task)"));
});
const byDate = json(await callTool("time_summary",
  { date_from: "2026-07-01", date_to: "2026-07-31", group_by: "date" }));
check("groups by date in chronological order", () => {
  assert.deepEqual(byDate.items.map((i) => i.date), ["2026-07-02", "2026-07-03"]);
});
const badGroup = await callTool("time_summary",
  { date_from: "2026-07-01", date_to: "2026-07-31", group_by: "colour" });
check("rejects an unknown group_by", () => assert.equal(badGroup.isError, true));

console.log("log_time");
const logged = json(await callTool("log_time",
  { project_id: 1, date: "2026-07-04", start: "13:00", end: "14:30", memo: "pairing" }));
check("posts the block and echoes it back", () => {
  assert.equal(logged.logged, true);
  assert.equal(logged.hours, 1.5);
  assert.equal(posted.at(-1).start_min, 780);
  assert.equal(posted.at(-1).end_min, 870);
  assert.equal(posted.at(-1).memo, "pairing");
});
const reversed = await callTool("log_time",
  { project_id: 1, date: "2026-07-04", start: "15:00", end: "14:00" });
check("rejects end before start", () => {
  assert.equal(reversed.isError, true);
  assert.match(reversed.content[0].text, /start must be before end/);
});
const viewer = await callTool("log_time",
  { project_id: 2, date: "2026-07-04", start: "09:00", end: "10:00" });
check("refuses to write to a viewer-role project", () => {
  assert.equal(viewer.isError, true);
  assert.match(viewer.content[0].text, /viewer/);
});
const missing = await callTool("log_time",
  { project_id: 99, date: "2026-07-04", start: "09:00", end: "10:00" });
check("names the fix when the project id is unknown", () => {
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /list_projects/);
});

console.log("update_time_block");
const updated = json(await callTool("update_time_block",
  { block_id: 100, start: "10:00", end: "11:30" }));
check("patches only what was passed", () => {
  assert.equal(patched.at(-1).id, 100);
  assert.deepEqual(patched.at(-1).body, { start_min: 600, end_min: 690 });
});
check("reports the result with names resolved", () => {
  assert.equal(updated.updated, true);
  assert.equal(updated.project, "Alpha");
  assert.equal(updated.hours, 1.5);
});
const noop = await callTool("update_time_block", { block_id: 100 });
check("refuses a patch that changes nothing", () => {
  assert.equal(noop.isError, true);
  assert.match(noop.content[0].text, /nothing to change/);
});
const badOrder = await callTool("update_time_block",
  { block_id: 100, start: "12:00", end: "11:00" });
check("rejects end before start", () => assert.equal(badOrder.isError, true));
const missingBlock = await callTool("update_time_block", { block_id: 4242, start: "09:00" });
check("surfaces a 404 as an error, not a crash", () =>
  assert.equal(missingBlock.isError, true));

console.log("delete_time_block");
const removed = json(await callTool("delete_time_block", { block_id: 101 }));
check("deletes exactly the id given", () => assert.deepEqual(deleted, [101]));
check("reports what was deleted, not just ok", () => {
  assert.equal(removed.deleted, true);
  assert.equal(removed.date, "2026-07-02");
  assert.equal(removed.start, "13:00");
  assert.equal(removed.project, "Alpha");
  assert.equal(removed.memo, "scaffolding");
});
check("gives the recovery deadline instead of calling it final", () => {
  assert.match(removed.recoverable_until, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(removed.note, /restore_time_block/);
});
const noId = await callTool("delete_time_block", {});
check("requires a block id", () => {
  assert.equal(noId.isError, true);
  assert.match(noId.content[0].text, /block_id is required/);
});
check("exposes no bulk delete", () => {
  const del = TOOLS.find((t) => t.name === "delete_time_block");
  assert.deepEqual(Object.keys(del.inputSchema.properties), ["block_id"]);
  assert.equal(del.inputSchema.properties.block_id.type, "number");
});
check("tells the model to confirm the specific block first", () => {
  const del = TOOLS.find((t) => t.name === "delete_time_block");
  assert.match(del.description, /MUST show the user/);
  assert.match(del.description, /one at a time/);
});
check("describes deletion as reversible for 14 days, without contradicting itself", () => {
  // This assertion used to require "cannot be undone" — a leftover from
  // before soft delete, which then sat in the same paragraph as "can be
  // put back for 14 days". A model reading the first half warns the user
  // that nothing can be recovered, which is false.
  const del = TOOLS.find((t) => t.name === "delete_time_block");
  assert.match(del.description, /14 days/);
  assert.match(del.description, /restore_time_block/);
  for (const contradiction of [/cannot be undone/, /no restore/, /no trash/,
                                /irreversible(?!\.)/]) {
    assert.doesNotMatch(del.description.replace(
      "do not tell the user the deletion is irreversible", ""), contradiction);
  }
});

console.log("restore");
const binned = json(await callTool("list_deleted_time_blocks", {}));
check("lists what is still recoverable, with the deadline", () => {
  assert.equal(binned.count, 1);
  assert.equal(binned.blocks[0].id, 101);
  assert.equal(binned.blocks[0].project, "Alpha");
  assert.equal(binned.blocks[0].restorable_until, "2026-09-22T01:00:00+00:00");
});
const back = json(await callTool("restore_time_block", { block_id: 101 }));
check("puts the block back", () => {
  assert.equal(back.restored, true);
  assert.equal(back.date, "2026-07-02");
  assert.deepEqual(restored, [101]);
});
const emptyBin = json(await callTool("list_deleted_time_blocks", {}));
check("the restored block leaves the recoverable list", () =>
  assert.equal(emptyBin.count, 0));
const gone = await callTool("restore_time_block", { block_id: 999 });
check("restoring something already purged is an error, not a crash", () =>
  assert.equal(gone.isError, true));

srv.close();
console.log(`\n${n} checks passed`);
