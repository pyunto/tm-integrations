/**
 * Pyunto Time Management SDK — public REST API v1 client with optional
 * client-side E2EE decryption.
 *
 * Plain usage (no crypto — dates/times/aggregates, plus plaintext names
 * on legacy projects):
 *
 *   const tm = new PyuntoTM({ apiKey: "ptm_..." });
 *   const record = await tm.serviceRecord("2026-07-01", "2026-07-31");
 *
 * E2EE usage (requires an API key with the keys:read scope; the user must
 * enter their account password once — key material never leaves the
 * process):
 *
 *   await tm.unlock(userPassword);
 *   const projects = await tm.projects({ decrypt: true }); // names filled in
 *   const blocks = await tm.blocks("2026-07-20", "2026-07-20", { decrypt: true });
 */
import {
  CipherEnvelope, ready, b64decode, unwrapPrivateKey, openSealedDEK,
  decryptField, encryptField, wipe,
} from "./crypto.js";

export type { CipherEnvelope };

// ── API types (mirror backend /api/v1 responses) ─────────────────────────────

export interface V1Me { email: string; key_name: string; scopes: string[]; }

export interface V1Project {
  id: number;
  name: string;
  name_enc: CipherEnvelope | null;
  color: string;
  role: string;
  is_shared: boolean;
  encryption_version: number;
  dek_sealed: string | null;
}

export interface V1Task {
  id: number;
  project_id: number;
  name: string;
  name_enc: CipherEnvelope | null;
  start_date: string;
  end_date: string;
  parent_task_id: number | null;
  assignee_id: number | null;
}

export interface V1Block {
  id: number;
  project_id: number;
  task_id: number | null;
  date: string;
  start_min: number;
  end_min: number;
  memo: string;
  memo_enc: CipherEnvelope | null;
  created_by: number | null;
}

export interface V1DeletedBlock extends V1Block {
  deleted_at: string | null;
  restorable_until: string;
}

export interface V1RecordRow {
  date: string;
  project_id: number;
  task_id: number | null;
  minutes: number;
  created_by: number | null;
}

export interface LogWorkInput {
  project_id: number;
  date: string;       // YYYY-MM-DD
  start_min: number;  // minutes from midnight
  end_min: number;
  memo?: string;      // encrypted client-side for E2EE projects (requires unlock)
  task_id?: number;
}

export interface UpdateBlockInput {
  date?: string;       // YYYY-MM-DD
  start_min?: number;
  end_min?: number;
  memo?: string;       // needs project_id; encrypted locally for E2EE projects
  task_id?: number;    // <= 0 detaches the block from its task
  /** Which project's key to encrypt `memo` under. Required only when
   *  setting a memo; it does not move the block between projects. */
  project_id?: number;
}

export class PyuntoTMError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PyuntoTMError";
  }
}

export interface PyuntoTMOptions {
  apiKey: string;
  baseUrl?: string;   // default https://tm.pyunto.com
  fetch?: typeof fetch;
}

interface DecryptOpts { decrypt?: boolean; }

export class PyuntoTM {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  // E2EE state after unlock()
  private publicKey: Uint8Array | null = null;
  private privateKey: Uint8Array | null = null;
  private deks = new Map<number, Uint8Array>();

  constructor(opts: PyuntoTMOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://tm.pyunto.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
      } catch { /* non-JSON error body */ }
      throw new PyuntoTMError(res.status, detail);
    }
    return res.json() as Promise<T>;
  }

  // ── Plain API ──────────────────────────────────────────────────────────────

  me(): Promise<V1Me> {
    return this.req("GET", "/me");
  }

  async projects(opts: DecryptOpts = {}): Promise<V1Project[]> {
    const rows = await this.req<V1Project[]>("GET", "/projects");
    if (opts.decrypt) {
      for (const p of rows) {
        if (p.encryption_version >= 1 && p.name_enc) {
          const dek = await this.dekFor(p);
          if (dek) p.name = await decryptField(dek, p.name_enc);
        }
      }
    }
    return rows;
  }

  async tasks(projectId?: number, opts: DecryptOpts = {}): Promise<V1Task[]> {
    const q = projectId != null ? `?project_id=${projectId}` : "";
    const rows = await this.req<V1Task[]>("GET", `/tasks${q}`);
    if (opts.decrypt) {
      const projMap = await this.projectMap();
      for (const t of rows) {
        const proj = projMap.get(t.project_id);
        if (proj && proj.encryption_version >= 1 && t.name_enc) {
          const dek = await this.dekFor(proj);
          if (dek) t.name = await decryptField(dek, t.name_enc);
        }
      }
    }
    return rows;
  }

  async blocks(dateFrom: string, dateTo: string, opts: DecryptOpts = {}): Promise<V1Block[]> {
    const rows = await this.req<V1Block[]>(
      "GET", `/blocks?date_from=${dateFrom}&date_to=${dateTo}`);
    if (opts.decrypt) {
      const projMap = await this.projectMap();
      for (const b of rows) {
        const proj = projMap.get(b.project_id);
        if (proj && proj.encryption_version >= 1 && b.memo_enc) {
          const dek = await this.dekFor(proj);
          if (dek) b.memo = await decryptField(dek, b.memo_enc);
        }
      }
    }
    return rows;
  }

  serviceRecord(dateFrom: string, dateTo: string): Promise<V1RecordRow[]> {
    return this.req("GET", `/service-record?date_from=${dateFrom}&date_to=${dateTo}`);
  }

  /** Create a time block. For E2EE projects with a memo, call unlock()
   *  first — the memo is encrypted locally and never sent in plaintext. */
  async logWork(input: LogWorkInput): Promise<V1Block> {
    const { memo, ...rest } = input;
    const projMap = await this.projectMap();
    const proj = projMap.get(input.project_id);
    if (proj && proj.encryption_version >= 1) {
      const dek = await this.dekFor(proj);
      if (!dek) {
        throw new Error(
          "E2EE project — call unlock(password) first (and mint the API key with keys:read)");
      }
      const memo_enc = await encryptField(dek, memo ?? "");
      return this.req("POST", "/blocks", { ...rest, memo_enc });
    }
    return this.req("POST", "/blocks", { ...rest, memo: memo ?? "" });
  }

  /** Change an existing block. Only the fields you pass are touched.
   *
   *  Setting `memo` also needs `project_id` — a memo is encrypted under
   *  the project's own key, and the API has no endpoint that reveals which
   *  project a block id belongs to, so the caller (who got the block from
   *  blocks()) has to say. It selects the key; it does not move the block. */
  async updateBlock(id: number, patch: UpdateBlockInput): Promise<V1Block> {
    const { memo, project_id, ...rest } = patch;
    if (memo === undefined) return this.req("PATCH", `/blocks/${id}`, rest);
    if (project_id == null) {
      throw new Error("updating a memo requires project_id, to know which key to encrypt under");
    }
    const proj = (await this.projectMap()).get(project_id);
    if (proj && proj.encryption_version >= 1) {
      const dek = await this.dekFor(proj);
      if (!dek) {
        throw new Error(
          "E2EE project — call unlock(password) first (and mint the API key with keys:read)");
      }
      return this.req("PATCH", `/blocks/${id}`, { ...rest, memo_enc: await encryptField(dek, memo) });
    }
    return this.req("PATCH", `/blocks/${id}`, { ...rest, memo });
  }

  /** Delete one block. Recoverable via restoreBlock() until the server's
   *  retention window closes (14 days), after which the row and its
   *  attachments are purged for good. Returns what was deleted so the
   *  caller can report it. There is no bulk form on purpose. */
  deleteBlock(id: number): Promise<V1Block> {
    return this.req("DELETE", `/blocks/${id}`);
  }

  /** Blocks deleted but still restorable, newest first. */
  async deletedBlocks(opts: DecryptOpts = {}): Promise<V1DeletedBlock[]> {
    const rows = await this.req<V1DeletedBlock[]>("GET", "/blocks/deleted");
    if (opts.decrypt) {
      const projMap = await this.projectMap();
      for (const b of rows) {
        const proj = projMap.get(b.project_id);
        if (proj && proj.encryption_version >= 1 && b.memo_enc) {
          const dek = await this.dekFor(proj);
          if (dek) b.memo = await decryptField(dek, b.memo_enc);
        }
      }
    }
    return rows;
  }

  /** Put a deleted block back. A no-op on a block that is not deleted. */
  restoreBlock(id: number): Promise<V1Block> {
    return this.req("POST", `/blocks/${id}/restore`);
  }

  // ── E2EE ───────────────────────────────────────────────────────────────────

  /** Fetch the wrapped key material (scope keys:read) and unwrap the
   *  private key with the user's account password. The password is used
   *  on this call only and not retained. */
  async unlock(password: string): Promise<void> {
    await ready();
    const keys = await this.req<{
      encryption_version: number;
      public_key: string | null;
      encrypted_private_key: string | null;
    }>("GET", "/keys");
    if (keys.encryption_version < 1) return; // legacy account — nothing to unlock
    if (!keys.public_key || !keys.encrypted_private_key) {
      throw new Error("account is E2EE but the server has no wrapped key material");
    }
    this.publicKey = b64decode(keys.public_key);
    this.privateKey = await unwrapPrivateKey(b64decode(keys.encrypted_private_key), password);
  }

  get unlocked(): boolean {
    return this.privateKey !== null;
  }

  /** Wipe all key material held in memory. */
  lock(): void {
    if (this.privateKey) wipe(this.privateKey);
    this.privateKey = null;
    this.publicKey = null;
    for (const dek of this.deks.values()) wipe(dek);
    this.deks.clear();
  }

  private projectsCache: V1Project[] | null = null;

  private async projectMap(): Promise<Map<number, V1Project>> {
    if (!this.projectsCache) {
      this.projectsCache = await this.req<V1Project[]>("GET", "/projects");
    }
    return new Map(this.projectsCache.map((p) => [p.id, p]));
  }

  /** Invalidate the internal projects cache (e.g. after creating projects
   *  elsewhere). */
  refresh(): void {
    this.projectsCache = null;
  }

  private async dekFor(proj: V1Project): Promise<Uint8Array | null> {
    const cached = this.deks.get(proj.id);
    if (cached) return cached;
    if (!this.privateKey || !this.publicKey) return null;
    if (!proj.dek_sealed) return null;
    await ready();
    const dek = await openSealedDEK(b64decode(proj.dek_sealed), this.publicKey, this.privateKey);
    this.deks.set(proj.id, dek);
    return dek;
  }
}

export {
  unwrapPrivateKey, openSealedDEK, decryptField, encryptField, wipe,
} from "./crypto.js";
