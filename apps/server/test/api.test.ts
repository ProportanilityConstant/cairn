import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { loadConfig } from "../src/config.js";

let target: Server;
let targetUrl: string;
let dataDir: string;
let base: string;

const WORKFLOW = {
  id: "smoke_wf",
  name: "Smoke workflow",
  description: "Created by the API test",
  steps: [
    { id: "ping", name: "Ping", kind: "http.request", config: { url: "{{vars.target}}/ping", assertions: [{ target: "status", op: "eq", value: 200 }, { target: "body_json", path: "ok", op: "eq", value: true }] } },
    { id: "check_flag", name: "Check flag", kind: "assert", condition: "steps.ping.status == 200", config: { expr: "steps.ping.body.ok == true", expect: "service reports ok" } },
    { id: "annotate", name: "Annotate", kind: "note", config: { text: "smoke run complete" } },
  ],
  variables: { target: "placeholder" },
};

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function waitForStatus(id: string, terminal: string[], timeoutMs = 15000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, json } = await api("GET", `/api/executions/${id}`);
    if (status !== 200) throw new Error(`Execution fetch failed: ${status}`);
    const s = (json as { status: string }).status;
    if (terminal.includes(s)) return json as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Timed out waiting for execution to finish");
}

beforeAll(async () => {
  // Demo target service with a chaos endpoint for controlled failures.
  let degraded = false;
  target = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url.startsWith("/ping")) {
      if (degraded) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, status: "degraded" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "healthy" }));
    } else if (url.startsWith("/chaos")) {
      degraded = true;
      res.writeHead(200); res.end("chaos enabled");
    } else if (url.startsWith("/heal")) {
      degraded = false;
      res.writeHead(200); res.end("healed");
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const addr = target.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  targetUrl = `http://127.0.0.1:${port}`;

  dataDir = mkdtempSync(join(tmpdir(), "cairn-test-"));
  const cfg = loadConfig({
    CAIRN_SECRET_KEY: "test-secret-key-0123456789abcdef",
    CAIRN_DATA_DIR: dataDir,
    CAIRN_PORT: "0",
    CAIRN_AI_KIND: "local",
  });
  const { app } = await buildServer(cfg);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const saddr = app.server.address();
  const sport = typeof saddr === "object" && saddr ? saddr.port : 0;
  base = `http://127.0.0.1:${sport}`;
});

afterAll(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  await new Promise<void>((r) => target.close(() => r()));
});

describe("Cairn API", () => {
  let projectId: string;

  it("reports health honestly, including AI mode", async () => {
    const { status, json } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, ai: "local" });
  });

  it("creates a project", async () => {
    const { status, json } = await api("POST", "/api/projects", { name: "Smoke project", description: "api test" });
    expect(status).toBe(201);
    projectId = (json as { id: string }).id;
  });

  it("rejects invalid workflows with actionable issues", async () => {
    const { status, json } = await api("POST", `/api/projects/${projectId}/workflows`, {
      ...WORKFLOW,
      steps: [{ id: "bad", name: "Bad", kind: "http.request", config: { url: 42 } }],
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("url");
  });

  it("creates a valid workflow", async () => {
    const def = { ...WORKFLOW, variables: { target: targetUrl } };
    const { status, json } = await api("POST", `/api/projects/${projectId}/workflows`, def);
    expect(status).toBe(201);
    expect((json as { id: string }).id).toBe("smoke_wf");
  });

  it("runs the workflow to a pass with evidence", async () => {
    const { status, json } = await api("POST", "/api/workflows/smoke_wf/run", { environment: "test" });
    expect(status).toBe(202);
    const id = (json as { executionId: string }).executionId;
    const execution = await waitForStatus(id, ["passed", "failed"]);
    expect(execution.status).toBe("passed");
    const steps = execution.steps as { stepId: string; status: string }[];
    expect(steps.find((s) => s.stepId === "check_flag")!.status).toBe("passed");
    expect(steps.find((s) => s.stepId === "annotate")!.status).toBe("passed");

    const { json: evidence } = await api("GET", `/api/executions/${id}/evidence`);
    const list = evidence as { id: string; type: string }[];
    expect(list.some((e) => e.type === "http_exchange")).toBe(true);
    expect(list.some((e) => e.type === "note")).toBe(true);
  });

  it("captures structured failure evidence when the target degrades, and the local analyzer explains it", async () => {
    await fetch(`${targetUrl}/chaos`);
    const { json } = await api("POST", "/api/workflows/smoke_wf/run", { environment: "test" });
    const id = (json as { executionId: string }).executionId;
    const execution = await waitForStatus(id, ["passed", "failed"]);
    expect(execution.status).toBe("failed");

    const failures = execution.failures as { code: string; assertion?: { expected: string; observed: string } }[];
    expect(failures[0]!.code).toBe("E_ASSERTION");
    expect(failures[0]!.assertion!.expected).toBe("200");
    expect(failures[0]!.assertion!.observed).toBe("500");

    const analysis = await api("POST", `/api/executions/${id}/analyze`);
    expect(analysis.status).toBe(200);
    const ai = (analysis.json as { ai: { provider: string; confidence: string } }).ai;
    expect(ai.provider).toBe("local-heuristic");
    expect(ai.confidence).toBe("medium");

    // Recovery proves the failure was real, not flaky tooling.
    await fetch(`${targetUrl}/heal`);
    const rerun = await api("POST", "/api/workflows/smoke_wf/run", { environment: "test" });
    const rerunExec = await waitForStatus((rerun.json as { executionId: string }).executionId, ["passed", "failed"]);
    expect(rerunExec.status).toBe("passed");
  });

  it("computes dashboard stats from real data", async () => {
    const { json } = await api("GET", `/api/dashboard?projectId=${projectId}`);
    const d = json as { totals: { passed: number; failed: number }; recent: unknown[] };
    expect(d.totals.passed).toBeGreaterThanOrEqual(2);
    expect(d.totals.failed).toBeGreaterThanOrEqual(1);
    expect(d.recent.length).toBeGreaterThan(0);
  });

  it("stores secrets without ever returning them", async () => {
    const put = await api("PUT", "/api/secrets/smoke_key", { value: "hunter2-do-not-leak" });
    expect(put.status).toBe(204);
    const list = await api("GET", "/api/secrets");
    expect(list.json).toEqual([{ name: "smoke_key", createdAt: expect.any(String) }]);
    // The encrypted value must not equal plaintext anywhere in settings reads.
    const raw = await fetch(`${base}/api/secrets`);
    const body = await raw.text();
    expect(body).not.toContain("hunter2");
  });

  it("lists step kinds for the editor", async () => {
    const { json } = await api("GET", "/api/step-kinds");
    const kinds = (json as { kinds: { kind: string }[] }).kinds.map((k) => k.kind);
    expect(kinds).toContain("http.request");
    expect(kinds).toContain("browser.goto");
  });

  it("drafts a valid workflow offline from an intent", async () => {
    const intent = `Check that ${targetUrl}/ping returns healthy within 5000ms`;
    const { status, json } = await api("POST", "/api/ai/plan", { projectId, intent });
    expect(status).toBe(200);
    const plan = json as { workflow: { id: string; steps: { kind: string; config: { url: string; assertions: { target: string; op: string; value: number }[] } }[] }; provider: string };
    expect(plan.provider).toBe("local-heuristic");
    const probe = plan.workflow.steps.find((s) => s.kind === "http.request")!;
    expect(probe.config.url).toBe("{{vars.baseUrl}}/ping");
    // The draft runs through the same validation the engine enforces.
    const created = await api("POST", `/api/projects/${projectId}/workflows`, {
      ...plan.workflow, id: "planned_smoke", variables: { ...plan.workflow.variables },
    });
    expect(created.status).toBe(201);
    const del = await api("DELETE", "/api/workflows/planned_smoke");
    expect(del.status).toBe(200);
  });

  it("returns 404 when deleting a workflow that does not exist", async () => {
    const { status, json } = await api("DELETE", "/api/workflows/no_such_workflow");
    expect(status).toBe(404);
    expect(JSON.stringify(json)).toContain("E_NOT_FOUND");
  });
});
