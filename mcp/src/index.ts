/**
 * Pyunto Time Management — MCP server (stdio).
 *
 * Exposes the account's projects, tasks, time blocks and per-day
 * aggregates to any MCP client (Claude Code, Claude Desktop, Codex CLI,
 * Cursor, …), plus a write tool that logs time.
 *
 * Configuration is environment-only — MCP clients launch this process and
 * pass env vars from their config file, so there are no CLI flags to get
 * wrong:
 *
 *   PYUNTO_TM_API_KEY    required. "ptm_…" minted in Settings → Account →
 *                        API keys. Its scopes decide which tools work.
 *   PYUNTO_TM_BASE_URL   optional, default https://tm.pyunto.com
 *   PYUNTO_TM_PASSWORD   optional. The account password, used ONLY to
 *                        unwrap the private key locally so E2EE project /
 *                        task names and memos can be decrypted in this
 *                        process. Without it the server still works — you
 *                        get ids, dates, durations and aggregates, just no
 *                        names. It is never sent anywhere: the wrapped key
 *                        blob is downloaded and opened here.
 *
 * Nothing is cached to disk and no key material leaves the process.
 */
import { readFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PyuntoTM, PyuntoTMError } from "@pyunto/tm-sdk";
import type { V1Project, V1Task } from "@pyunto/tm-sdk";

const API_KEY = process.env.PYUNTO_TM_API_KEY ?? "";
const BASE_URL = process.env.PYUNTO_TM_BASE_URL ?? "https://tm.pyunto.com";
// A password may also be handed over via a file path, which keeps it out
// of the client's config JSON and out of `ps` output.
//
// A missing or unreadable file must not take the server down with it.
// Letting readFileSync throw here killed the process during module load,
// and an MCP client has no way to show that — it just reports
// "CONNECTION_CLOSED", pointing at everything except the typo in a path.
// Carry the reason instead and serve without decryption: every
// schedule-shaped tool still works, and whoami explains what happened.
let passwordFileError: string | null = null;

function readPasswordFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (e) {
    passwordFileError =
      `could not read PYUNTO_TM_PASSWORD_FILE (${path}): ` +
      `${e instanceof Error ? e.message : String(e)}`;
    console.error(`pyunto-tm: ${passwordFileError} — continuing without decryption.`);
    return "";
  }
}

const PASSWORD = process.env.PYUNTO_TM_PASSWORD
  ?? (process.env.PYUNTO_TM_PASSWORD_FILE
    ? readPasswordFile(process.env.PYUNTO_TM_PASSWORD_FILE)
    : "");

const tm = new PyuntoTM({ apiKey: API_KEY, baseUrl: BASE_URL });

// ── Helpers ──────────────────────────────────────────────────────────────────

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function hours(min: number): string {
  return (min / 60).toFixed(2);
}

/** Parse "9:30", "09:30" or a plain minute count into minutes past midnight. */
function toMinutes(v: string | number, field: string): number {
  if (typeof v === "number") return v;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (m) {
    const min = Number(m[1]) * 60 + Number(m[2]);
    if (min < 0 || min > 1440) throw new Error(`${field} out of range: ${v}`);
    return min;
  }
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  throw new Error(`${field} must be "HH:MM" or minutes past midnight, got "${v}"`);
}

function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Unlock once, lazily. Returns whether decryption is available. */
let unlockAttempted = false;
let unlockError: string | null = null;
async function ensureUnlocked(): Promise<boolean> {
  if (!PASSWORD) return false;
  if (!unlockAttempted) {
    unlockAttempted = true;
    try {
      await tm.unlock(PASSWORD);
    } catch (e) {
      unlockError = e instanceof Error ? e.message : String(e);
    }
  }
  return tm.unlocked;
}

/** Note appended to name-bearing results when E2EE names can't be read,
 *  so the model reports the real reason instead of inventing names. */
async function encryptionNote(rows: { encryption_version?: number }[]): Promise<string | null> {
  if (await ensureUnlocked()) return null;
  const anyE2EE = rows.some((r) => (r.encryption_version ?? 0) >= 1);
  if (!anyE2EE) return null;
  if (passwordFileError) {
    return `Names are empty because the password file could not be read: ${passwordFileError}. ` +
      "Fix the path, or drop PYUNTO_TM_PASSWORD_FILE and set PYUNTO_TM_PASSWORD instead.";
  }
  if (unlockError) {
    return `Names are empty because unlocking failed: ${unlockError}. ` +
      "Check PYUNTO_TM_PASSWORD and that the API key has the keys:read scope.";
  }
  return "Names are empty because this account is end-to-end encrypted and no " +
    "password was configured. Set PYUNTO_TM_PASSWORD (and mint the API key with " +
    "the keys:read scope) to decrypt names locally. Ids, dates and durations are " +
    "unaffected.";
}

let projectCache: V1Project[] | null = null;
async function projects(): Promise<V1Project[]> {
  if (!projectCache) {
    const decrypt = await ensureUnlocked();
    projectCache = await tm.projects({ decrypt });
  }
  return projectCache;
}

let taskCache: V1Task[] | null = null;
async function tasks(): Promise<V1Task[]> {
  if (!taskCache) {
    const decrypt = await ensureUnlocked();
    taskCache = await tm.tasks(undefined, { decrypt });
  }
  return taskCache;
}

function nameOf(rows: { id: number; name: string }[], id: number | null | undefined): string {
  if (id == null) return "—";
  const hit = rows.find((r) => r.id === id);
  if (!hit) return `#${id}`;
  return hit.name || `#${id}`;
}

function ok(payload: unknown, note?: string | null) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text" as const, text: note ? `${text}\n\nNOTE: ${note}` : text }],
  };
}

function fail(e: unknown) {
  let msg = e instanceof Error ? e.message : String(e);
  if (e instanceof PyuntoTMError) {
    if (e.status === 401) {
      msg = `${msg} — the API key is missing, wrong or revoked (PYUNTO_TM_API_KEY).`;
    } else if (e.status === 403) {
      msg = `${msg} — mint a key with this scope in Settings → Account → API keys.`;
    } else if (e.status === 429) {
      msg = `${msg} — rate limited (240 requests/minute per key); retry shortly.`;
    }
  }
  return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "whoami",
    description:
      "Who this MCP server is connected as: account email, API key name, granted " +
      "scopes, server URL, and whether end-to-end-encrypted names can be decrypted. " +
      "Call this first when a tool fails, to see which scopes are missing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_projects",
    description:
      "List every project the account can see, with id, name, colour and role " +
      "(owner/editor/viewer). Use it to resolve a project name the user typed into " +
      "the project_id other tools need. Requires the projects:read scope.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tasks",
    description:
      "List Gantt tasks (and subtasks) with their id, project, name and date range. " +
      "Filter to one project with project_id. Use it to resolve a task name into the " +
      "task_id that log_time takes. Requires the projects:read scope.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Only tasks in this project." },
        active_on: {
          type: "string",
          description: "YYYY-MM-DD — keep only tasks whose date range covers this day.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_time_blocks",
    description:
      "The individual time blocks logged between two dates (inclusive, max 92 days), " +
      "with start/end times, duration, project, task and memo. This is the detailed " +
      "schedule; use time_summary when you only need totals. Requires blocks:read.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "YYYY-MM-DD (inclusive)." },
        date_to: { type: "string", description: "YYYY-MM-DD (inclusive)." },
      },
      required: ["date_from", "date_to"],
      additionalProperties: false,
    },
  },
  {
    name: "time_summary",
    description:
      "Total hours logged between two dates (inclusive, max 92 days), grouped by " +
      "project, by task, or by day. This is the tool to answer 'how much time did I " +
      "spend on X' and to write a work log or diary entry. Requires record:read.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "YYYY-MM-DD (inclusive)." },
        date_to: { type: "string", description: "YYYY-MM-DD (inclusive)." },
        group_by: {
          type: "string",
          enum: ["project", "task", "date"],
          description: "Grouping for the totals. Default: project.",
        },
      },
      required: ["date_from", "date_to"],
      additionalProperties: false,
    },
  },
  {
    name: "log_time",
    description:
      "Record a block of worked time on the calendar. Writes to the user's real " +
      "schedule, so confirm the project, date and times with them before calling it. " +
      "Requires the blocks:write scope; for an end-to-end-encrypted project a memo " +
      "additionally needs PYUNTO_TM_PASSWORD so it can be encrypted locally.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "From list_projects." },
        date: { type: "string", description: "YYYY-MM-DD." },
        start: { type: "string", description: '"HH:MM" (24h) or minutes past midnight.' },
        end: { type: "string", description: '"HH:MM" (24h) or minutes past midnight.' },
        memo: { type: "string", description: "What was worked on. Encrypted client-side." },
        task_id: { type: "number", description: "Gantt task to attribute the time to." },
      },
      required: ["project_id", "date", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "update_time_block",
    description:
      "Change an already-recorded time block: its date, start/end times, memo, " +
      "or the task it counts towards. Get block_id from list_time_blocks. Only " +
      "the fields you pass change. Tell the user what the block currently says " +
      "and what it will say before calling this. Requires the blocks:write scope; " +
      "changing a memo on an end-to-end-encrypted project also needs " +
      "PYUNTO_TM_PASSWORD, and project_id so the memo is encrypted under the " +
      "right key.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: { type: "number", description: "From list_time_blocks." },
        date: { type: "string", description: "YYYY-MM-DD." },
        start: { type: "string", description: '"HH:MM" (24h) or minutes past midnight.' },
        end: { type: "string", description: '"HH:MM" (24h) or minutes past midnight.' },
        memo: { type: "string", description: "Replaces the memo. Needs project_id." },
        task_id: { type: "number", description: "Task to attribute the time to; 0 detaches it." },
        project_id: {
          type: "number",
          description: "The block's project, from list_time_blocks. Required with memo.",
        },
      },
      required: ["block_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_time_block",
    description:
      "Permanently delete ONE recorded time block, along with any files attached " +
      "to it. This cannot be undone — there is no trash and no restore. Before " +
      "calling it you MUST show the user the block you are about to delete (date, " +
      "start and end time, project, task and memo, from list_time_blocks) and get " +
      "an explicit yes for that specific block. Never infer the block from a vague " +
      "instruction, and never delete several blocks because the user described a " +
      "range — confirm and delete them one at a time. A deleted block can be put " +
      "back with restore_time_block for 14 days, after which it and its attachments " +
      "are purged for good; say so when you report the deletion. Requires the " +
      "blocks:delete scope, which is separate from blocks:write and has to be " +
      "granted deliberately.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: {
          type: "number",
          description: "From list_time_blocks. Exactly one block is deleted.",
        },
      },
      required: ["block_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_deleted_time_blocks",
    description:
      "Time blocks that were deleted but can still be restored, newest first, " +
      "each with the date it was deleted and the deadline for putting it back. " +
      "Use it to find the block_id for restore_time_block when the user says they " +
      "deleted something by mistake. Requires the blocks:read scope.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "restore_time_block",
    description:
      "Put a deleted time block back on the calendar, along with any files that " +
      "were attached to it. Get block_id from list_deleted_time_blocks. Works only " +
      "within the 14-day recovery window; after that the block is gone for good. " +
      "Requires the blocks:write scope.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: { type: "number", description: "From list_deleted_time_blocks." },
      },
      required: ["block_id"],
      additionalProperties: false,
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────────────

type Args = Record<string, unknown>;

/** Public entry point: never throws. A failed tool comes back as an
 *  isError result whose text tells the model (and the user) what to fix,
 *  which is far more useful to an agent than a transport-level error. */
async function callTool(name: string, args: Args = {}) {
  try {
    return await dispatch(name, args);
  } catch (e) {
    return fail(e);
  }
}

async function dispatch(name: string, args: Args) {
  switch (name) {
    case "whoami": {
      const me = await tm.me();
      const unlocked = await ensureUnlocked();
      return ok({
        email: me.email,
        api_key_name: me.key_name,
        scopes: me.scopes,
        server: BASE_URL,
        e2ee_decryption: unlocked
          ? "enabled — encrypted names and memos are readable"
          : passwordFileError
            ? `unavailable — ${passwordFileError}`
            : PASSWORD
              ? `unavailable — unlock failed: ${unlockError ?? "unknown error"}`
              : "disabled — no PYUNTO_TM_PASSWORD set; ids/dates/durations still work",
      });
    }

    case "list_projects": {
      const rows = await projects();
      return ok(
        rows.map((p) => ({
          id: p.id, name: p.name, color: p.color, role: p.role,
          shared: p.is_shared, encrypted: p.encryption_version >= 1,
        })),
        await encryptionNote(rows));
    }

    case "list_tasks": {
      const pid = args.project_id as number | undefined;
      const activeOn = args.active_on as string | undefined;
      if (activeOn && !isDate(activeOn)) throw new Error("active_on must be YYYY-MM-DD");
      const projRows = await projects();
      let rows = await tasks();
      if (pid != null) rows = rows.filter((t) => t.project_id === pid);
      if (activeOn) rows = rows.filter((t) => t.start_date <= activeOn && t.end_date >= activeOn);
      return ok(
        rows.map((t) => ({
          id: t.id,
          project_id: t.project_id,
          project: nameOf(projRows, t.project_id),
          name: t.name,
          start_date: t.start_date,
          end_date: t.end_date,
          parent_task_id: t.parent_task_id,
        })),
        await encryptionNote(projRows));
    }

    case "list_time_blocks": {
      const from = String(args.date_from ?? ""), to = String(args.date_to ?? "");
      if (!isDate(from) || !isDate(to)) throw new Error("date_from and date_to must be YYYY-MM-DD");
      const decrypt = await ensureUnlocked();
      const [projRows, taskRows, blocks] = await Promise.all([
        projects(), tasks(), tm.blocks(from, to, { decrypt }),
      ]);
      const total = blocks.reduce((a, b) => a + (b.end_min - b.start_min), 0);
      return ok({
        range: { from, to },
        total_hours: Number(hours(total)),
        blocks: blocks.map((b) => ({
          id: b.id,
          date: b.date,
          start: hhmm(b.start_min),
          end: hhmm(b.end_min),
          hours: Number(hours(b.end_min - b.start_min)),
          project: nameOf(projRows, b.project_id),
          project_id: b.project_id,
          task: b.task_id != null ? nameOf(taskRows, b.task_id) : null,
          task_id: b.task_id,
          memo: b.memo,
        })),
      }, await encryptionNote(projRows));
    }

    case "time_summary": {
      const from = String(args.date_from ?? ""), to = String(args.date_to ?? "");
      if (!isDate(from) || !isDate(to)) throw new Error("date_from and date_to must be YYYY-MM-DD");
      const groupBy = (args.group_by as string | undefined) ?? "project";
      if (!["project", "task", "date"].includes(groupBy)) {
        throw new Error('group_by must be "project", "task" or "date"');
      }
      const [projRows, taskRows, rows] = await Promise.all([
        projects(), tasks(), tm.serviceRecord(from, to),
      ]);
      const agg = new Map<string, number>();
      for (const r of rows) {
        const k = groupBy === "date" ? r.date
          : groupBy === "task" ? `${r.project_id}:${r.task_id ?? ""}`
            : String(r.project_id);
        agg.set(k, (agg.get(k) ?? 0) + r.minutes);
      }
      const items = [...agg.entries()]
        .map(([k, minutes]) => {
          if (groupBy === "date") return { date: k, hours: Number(hours(minutes)) };
          if (groupBy === "task") {
            const [pid, tid] = k.split(":");
            return {
              project: nameOf(projRows, Number(pid)),
              project_id: Number(pid),
              task: tid ? nameOf(taskRows, Number(tid)) : "(no task)",
              task_id: tid ? Number(tid) : null,
              hours: Number(hours(minutes)),
            };
          }
          return {
            project: nameOf(projRows, Number(k)),
            project_id: Number(k),
            hours: Number(hours(minutes)),
          };
        })
        .sort((a, b) => (groupBy === "date"
          ? String((a as { date: string }).date).localeCompare(String((b as { date: string }).date))
          : b.hours - a.hours));
      const total = rows.reduce((a, r) => a + r.minutes, 0);
      return ok({
        range: { from, to }, group_by: groupBy,
        total_hours: Number(hours(total)),
        items,
      }, await encryptionNote(projRows));
    }

    case "log_time": {
      const projectId = Number(args.project_id);
      const date = String(args.date ?? "");
      if (!Number.isFinite(projectId)) throw new Error("project_id is required");
      if (!isDate(date)) throw new Error("date must be YYYY-MM-DD");
      const start = toMinutes(args.start as string | number, "start");
      const end = toMinutes(args.end as string | number, "end");
      if (!(start < end)) throw new Error("start must be before end");
      if (end > 1440) throw new Error("end must not pass midnight (1440)");

      const projRows = await projects();
      const proj = projRows.find((p) => p.id === projectId);
      if (!proj) throw new Error(`no accessible project with id ${projectId} — call list_projects`);
      if (proj.role === "viewer") throw new Error(`you only have viewer access to "${proj.name}"`);

      const memo = args.memo != null ? String(args.memo) : undefined;
      if (memo && proj.encryption_version >= 1 && !(await ensureUnlocked())) {
        throw new Error(
          `"${proj.name || `#${projectId}`}" is end-to-end encrypted, so a memo must be ` +
          "encrypted locally before upload. Set PYUNTO_TM_PASSWORD (with a keys:read " +
          "API key), or call log_time again without a memo.");
      }

      const block = await tm.logWork({
        project_id: projectId, date, start_min: start, end_min: end,
        memo, task_id: args.task_id != null ? Number(args.task_id) : undefined,
      });
      // The write invalidates nothing name-wise, but a fresh block should
      // show up in later reads within this session.
      return ok({
        logged: true,
        id: block.id,
        date: block.date,
        start: hhmm(block.start_min),
        end: hhmm(block.end_min),
        hours: Number(hours(block.end_min - block.start_min)),
        project: proj.name || `#${projectId}`,
        task_id: block.task_id,
      });
    }

    case "update_time_block": {
      const blockId = Number(args.block_id);
      if (!Number.isFinite(blockId)) throw new Error("block_id is required");
      const patch: Record<string, unknown> = {};
      if (args.date != null) {
        const date = String(args.date);
        if (!isDate(date)) throw new Error("date must be YYYY-MM-DD");
        patch.date = date;
      }
      if (args.start != null) patch.start_min = toMinutes(args.start as string | number, "start");
      if (args.end != null) patch.end_min = toMinutes(args.end as string | number, "end");
      if (patch.start_min != null && patch.end_min != null
          && !((patch.start_min as number) < (patch.end_min as number))) {
        throw new Error("start must be before end");
      }
      if (args.memo != null) patch.memo = String(args.memo);
      if (args.task_id != null) patch.task_id = Number(args.task_id);
      if (args.project_id != null) patch.project_id = Number(args.project_id);
      if (Object.keys(patch).length === 0) {
        throw new Error("nothing to change — pass at least one of date, start, end, memo, task_id");
      }

      const block = await tm.updateBlock(blockId, patch);
      const [projRows, taskRows] = await Promise.all([projects(), tasks()]);
      return ok({
        updated: true,
        id: block.id,
        date: block.date,
        start: hhmm(block.start_min),
        end: hhmm(block.end_min),
        hours: Number(hours(block.end_min - block.start_min)),
        project: nameOf(projRows, block.project_id),
        task: block.task_id != null ? nameOf(taskRows, block.task_id) : null,
        task_id: block.task_id,
        memo: block.memo,
      }, await encryptionNote(projRows));
    }

    case "delete_time_block": {
      const blockId = Number(args.block_id);
      if (!Number.isFinite(blockId)) throw new Error("block_id is required");
      const [projRows, taskRows] = await Promise.all([projects(), tasks()]);
      // The API returns the row it removed, so the reply can name exactly
      // what is gone rather than a bare acknowledgement.
      const gone = await tm.deleteBlock(blockId);
      // The window is fixed server-side; report the deadline so the user
      // knows how long they have rather than being told it is final.
      const gone_until = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
      return ok({
        deleted: true,
        recoverable_until: gone_until,
        note: "Restorable with restore_time_block until the date above; after that "
          + "the block and its attachments are purged permanently.",
        id: gone.id,
        date: gone.date,
        start: hhmm(gone.start_min),
        end: hhmm(gone.end_min),
        hours: Number(hours(gone.end_min - gone.start_min)),
        project: nameOf(projRows, gone.project_id),
        task: gone.task_id != null ? nameOf(taskRows, gone.task_id) : null,
        memo: gone.memo,
      }, await encryptionNote(projRows));
    }

    case "list_deleted_time_blocks": {
      const decrypt = await ensureUnlocked();
      const [projRows, taskRows, rows] = await Promise.all([
        projects(), tasks(), tm.deletedBlocks({ decrypt }),
      ]);
      return ok({
        count: rows.length,
        blocks: rows.map((b) => ({
          id: b.id,
          date: b.date,
          start: hhmm(b.start_min),
          end: hhmm(b.end_min),
          hours: Number(hours(b.end_min - b.start_min)),
          project: nameOf(projRows, b.project_id),
          task: b.task_id != null ? nameOf(taskRows, b.task_id) : null,
          memo: b.memo,
          deleted_at: b.deleted_at,
          restorable_until: b.restorable_until,
        })),
      }, await encryptionNote(projRows));
    }

    case "restore_time_block": {
      const blockId = Number(args.block_id);
      if (!Number.isFinite(blockId)) throw new Error("block_id is required");
      const [projRows, taskRows] = await Promise.all([projects(), tasks()]);
      const back = await tm.restoreBlock(blockId);
      return ok({
        restored: true,
        id: back.id,
        date: back.date,
        start: hhmm(back.start_min),
        end: hhmm(back.end_min),
        hours: Number(hours(back.end_min - back.start_min)),
        project: nameOf(projRows, back.project_id),
        task: back.task_id != null ? nameOf(taskRows, back.task_id) : null,
        memo: back.memo,
      }, await encryptionNote(projRows));
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── Wire up ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "pyunto-tm", version: "0.3.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  callTool(req.params.name, (req.params.arguments ?? {}) as Args));

/** Attach the stdio transport and serve. Called only by cli.ts, so
 *  importing this module (the tests do) never touches stdio. */
export function start(): void {
  if (!API_KEY) {
    // stderr, never stdout — stdout carries the JSON-RPC frames.
    console.error(
      "PYUNTO_TM_API_KEY is not set. Create a key in Pyunto Time Management " +
      "under Settings → Account → API keys, then set it in your MCP client config.");
    process.exit(1);
  }
  server.connect(new StdioServerTransport())
    .then(() => console.error(`pyunto-tm MCP server ready (${BASE_URL})`))
    .catch((e) => {
      console.error("fatal:", e);
      process.exit(1);
    });
}

export { callTool, toMinutes, hhmm, TOOLS };
