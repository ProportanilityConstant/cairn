import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, Execution } from "@cairn/core";

/**
 * SQLite persistence via Node's built-in driver — no native compilation,
 * no external database process. Single-file storage under CAIRN_DATA_DIR.
 */

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface WorkflowRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  version: number;
  /** The full WorkflowDef as JSON. Executions snapshot it at run time. */
  def: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretRow {
  name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  createdAt: string;
}

export interface SettingRow {
  key: string;
  value: string;
}

// Storage adapter: node:sqlite on Node >=22.5, bun:sqlite under Bun.
// Same minimal interface either way — prepare/run/get/all + exec.
export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

async function openDatabase(path: string): Promise<SqlDb> {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (isBun) {
    const spec = ["bun", ":sqlite"].join("");
    const mod = (await import(spec)) as {
      Database: new (p: string) => {
        exec(s: string): void;
        query(s: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
      };
    };
    const db = new mod.Database(path);
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const stmt = db.query(sql);
        return { run: (...a) => stmt.run(...a), get: (...a) => stmt.get(...a), all: (...a) => stmt.all(...a) };
      },
    };
  }
  const spec2 = ["node", ":sqlite"].join(":");
  const mod2 = (await import(/* webpackIgnore: true */ spec2)) as { DatabaseSync: new (p: string) => SqlDb };
  return new mod2.DatabaseSync(path);
}

export class Store {
  private constructor(private readonly db: SqlDb) {}

  static async create(dataDir: string): Promise<Store> {
    mkdirSync(dataDir, { recursive: true });
    const store = new Store(await openDatabase(join(dataDir, "cairn.db")));
    store.migrate();
    return store;
  }


  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        description TEXT,
        version INTEGER NOT NULL,
        def TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        environment TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        variables TEXT NOT NULL,
        steps TEXT NOT NULL,
        failures TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project_id, started_at);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id),
        step_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content_type TEXT NOT NULL,
        encoding TEXT NOT NULL,
        data TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_execution ON evidence(execution_id);
      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---------- projects ----------
  createProject(p: ProjectRow): void {
    this.db.prepare("INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)")
      .run(p.id, p.name, p.description, p.createdAt);
  }

  listProjects(): ProjectRow[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM evidence WHERE execution_id IN (SELECT id FROM executions WHERE project_id = ?)").run(id);
    this.db.prepare("DELETE FROM executions WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM workflows WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---------- workflows ----------
  saveWorkflow(w: WorkflowRow, isUpdate: boolean): void {
    if (isUpdate) {
      this.db.prepare("UPDATE workflows SET name = ?, description = ?, version = ?, def = ?, updated_at = ? WHERE id = ? AND version = ?")
        .run(w.name, w.description, w.version, w.def, w.updatedAt, w.id, w.version);
      if (this.changes() === 0) {
        // Version moved under us: insert as the next version.
        const latest = this.latestWorkflowVersion(w.id) ?? 0;
        this.db.prepare("INSERT INTO workflows (id, project_id, name, description, version, def, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(w.id, w.projectId, w.name, w.description, latest + 1, w.def, w.createdAt, w.updatedAt);
      }
    } else {
      this.db.prepare("INSERT INTO workflows (id, project_id, name, description, version, def, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(w.id, w.projectId, w.name, w.description, w.version, w.def, w.createdAt, w.updatedAt);
    }
  }

  private changes(): number {
    return Number(this.db.prepare("SELECT changes() AS c").get() !== undefined ? (this.db.prepare("SELECT changes() AS c").get() as { c: number }).c : 0);
  }

  latestWorkflowVersion(id: string): number | undefined {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM workflows WHERE id = ?").get(id) as { v: number | null } | undefined;
    return row?.v ?? undefined;
  }

  latestWorkflows(projectId: string): WorkflowRow[] {
    const rows = this.db.prepare(`
      SELECT w.* FROM workflows w
      JOIN (SELECT id, MAX(version) AS mv FROM workflows WHERE project_id = ? GROUP BY id) latest
      ON w.id = latest.id AND w.version = latest.mv
      ORDER BY w.updated_at DESC
    `).all(projectId) as unknown as WorkflowRow[];
    return rows;
  }

  getWorkflow(id: string): WorkflowRow | undefined {
    const row = this.db.prepare(`
      SELECT * FROM workflows WHERE id = ? ORDER BY version DESC LIMIT 1
    `).get(id) as unknown as WorkflowRow | undefined;
    return row;
  }

  deleteWorkflow(id: string): void {
    this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  }

  // ---------- executions ----------
  saveExecution(e: Execution, failures: unknown): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO executions (id, project_id, workflow_id, workflow_name, workflow_version, environment, trigger, status, started_at, finished_at, duration_ms, variables, steps, failures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.id, e.projectId, e.workflowId, e.workflowName, e.workflowVersion,
      e.environment, e.trigger, e.status, e.startedAt, e.finishedAt ?? null,
      e.durationMs ?? null, JSON.stringify(e.variables), JSON.stringify(e.steps), JSON.stringify(failures)
    );
  }

  getExecution(id: string): (Omit<Execution, "steps"> & { steps: Execution["steps"]; failures: unknown[] }) | undefined {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      workflowName: row.workflow_name as string,
      workflowVersion: Number(row.workflow_version),
      projectId: row.project_id as string,
      environment: row.environment as string,
      trigger: row.trigger as Execution["trigger"],
      status: row.status as Execution["status"],
      startedAt: row.started_at as string,
      finishedAt: (row.finished_at as string | null) ?? undefined,
      durationMs: (row.duration_ms as number | null) ?? undefined,
      variables: JSON.parse(row.variables as string),
      steps: JSON.parse(row.steps as string),
      failures: JSON.parse(row.failures as string),
    };
  }

  listExecutions(projectId: string | undefined, limit: number): (Omit<Execution, "steps"> & { failures: unknown[] })[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM executions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?").all(projectId, limit)
        : this.db.prepare("SELECT * FROM executions ORDER BY started_at DESC LIMIT ?").all(limit)
    ) as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      workflowId: row.workflow_id as string,
      workflowName: row.workflow_name as string,
      workflowVersion: Number(row.workflow_version),
      projectId: row.project_id as string,
      environment: row.environment as string,
      trigger: row.trigger as Execution["trigger"],
      status: row.status as Execution["status"],
      startedAt: row.started_at as string,
      finishedAt: (row.finished_at as string | null) ?? undefined,
      durationMs: (row.duration_ms as number | null) ?? undefined,
      variables: JSON.parse(row.variables as string),
      failures: JSON.parse(row.failures as string),
    }));
  }

  // ---------- evidence ----------
  saveEvidence(e: Evidence): void {
    this.db.prepare("INSERT INTO evidence (id, execution_id, step_id, type, content_type, encoding, data, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, e.executionId, e.stepId, e.type, e.contentType, e.encoding, e.data, e.label ?? null, e.createdAt);
  }

  listEvidence(executionId: string): { id: string; stepId: string; type: string; contentType: string; label: string | null; createdAt: string; size: number }[] {
    return (this.db.prepare("SELECT id, step_id, type, content_type, label, created_at, LENGTH(data) AS size FROM evidence WHERE execution_id = ? ORDER BY created_at").all(executionId) as unknown as Record<string, unknown>[])
      .map((r) => ({
        id: r.id as string,
        stepId: r.step_id as string,
        type: r.type as string,
        contentType: r.content_type as string,
        label: (r.label as string | null) ?? null,
        createdAt: r.created_at as string,
        size: Number(r.size),
      }));
  }

  getEvidence(id: string): Evidence | undefined {
    const r = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      executionId: r.execution_id as string,
      stepId: r.step_id as string,
      type: r.type as Evidence["type"],
      contentType: r.content_type as string,
      encoding: r.encoding as Evidence["encoding"],
      data: r.data as string,
      label: (r.label as string | null) ?? undefined,
      createdAt: r.created_at as string,
    };
  }

  // ---------- secrets ----------
  saveSecret(s: SecretRow): void {
    this.db.prepare("INSERT OR REPLACE INTO secrets (name, ciphertext, iv, tag, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(s.name, s.ciphertext, s.iv, s.tag, s.createdAt);
  }

  getSecret(name: string): SecretRow | undefined {
    return this.db.prepare("SELECT * FROM secrets WHERE name = ?").get(name) as unknown as SecretRow | undefined;
  }

  listSecretNames(): { name: string; createdAt: string }[] {
    return (this.db.prepare("SELECT name, created_at FROM secrets ORDER BY name").all() as unknown as Record<string, unknown>[])
      .map((r) => ({ name: r.name as string, createdAt: r.created_at as string }));
  }

  deleteSecret(name: string): boolean {
    const before = this.listSecretNames().length;
    this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
    return this.listSecretNames().length < before;
  }

  // ---------- settings ----------
  getSetting(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}
