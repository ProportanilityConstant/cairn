import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CairnError,
  defaultPolicy,
  isCairnError,
  newId,
  toCairnError,
  validateWorkflow,
  type ActionClass,
  type Evidence,
  type Execution,
  type WorkflowDef,
  stepKinds,
  stepKindSchemas,
  stepActionClasses,
} from "@cairn/core";
import { ExecutionEngine, createRunnerRegistry } from "@cairn/executor";
import { analyzeFailure, planWorkflow } from "@cairn/ai";
import { AnthropicProvider, LocalHeuristicProvider, OpenAICompatibleProvider, type AIProvider } from "@cairn/ai";
import { loadConfig, type ServerConfig } from "./config.js";
import { SecretBox } from "./crypto.js";
import { Store } from "./store.js";

export async function buildServer(cfg: ServerConfig, opts?: { store?: Store }) {
  const store = opts?.store ?? (await Store.create(cfg.dataDir));
  const box = new SecretBox(cfg.secretKey);

  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, logger: { level: cfg.logLevel } });

  // ---------- auth ----------
  if (cfg.apiToken) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/") && req.method !== "GET") {
        const header = req.headers.authorization;
        if (header !== `Bearer ${cfg.apiToken}`) {
          await reply.code(401).send({ error: { code: "E_UNAUTHORIZED", message: "A valid bearer token is required", hint: "Set Authorization: Bearer <CAIRN_API_TOKEN>." } });
        }
      }
    });
  }

  // ---------- error mapping ----------
  app.setErrorHandler((rawErr, _req, reply) => {
    const err = rawErr as unknown;
    if (isCairnError(err)) {
      const status = err.code === "E_NOT_FOUND" ? 404
        : err.code === "E_VALIDATION" || err.code === "E_CONFIG" || err.code === "E_STEP_VALIDATION" ? 400
        : err.code === "E_CONFLICT" ? 409
        : err.code === "E_POLICY" || err.code === "E_UNAUTHORIZED" ? 403
        : 500;
      reply.code(status).send({ error: err.toJSON() });
      return;
    }
    const fe = rawErr as { statusCode?: number; validation?: unknown; message?: string; code?: string };
    if (fe.statusCode === 400 && fe.validation) {
      reply.code(400).send({ error: { code: "E_VALIDATION", message: "Request body failed validation", detail: fe.validation } });
      return;
    }
    // Malformed body / bad content-type: Fastify parse errors surface as 400,
    // sometimes without statusCode set on the error object.
    if (fe.statusCode === 400 || (typeof fe.code === "string" && fe.code.startsWith("FST_ERR_") && fe.statusCode === undefined)) {
      reply.code(400).send({ error: { code: "E_VALIDATION", message: fe.message ?? "Request could not be processed" } });
      return;
    }
    app.log.error(rawErr);
    reply.code(500).send({ error: { code: "E_INTERNAL", message: fe.message } });
  });

  // ---------- execution engine wiring ----------
  const inFlight = new Map<string, AbortController>();
  const queue: { run: () => void }[] = [];
  let active = 0;
  const MAX_CONCURRENCY = 2;

  async function resolveSecrets(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const { name } of store.listSecretNames()) {
      const row = store.getSecret(name);
      if (row) out[name] = box.decrypt(row);
    }
    return out;
  }

  function buildProvider(): AIProvider {
    switch (cfg.ai.kind) {
      case "openai-compatible":
        return new OpenAICompatibleProvider({ baseUrl: cfg.ai.baseUrl!, apiKey: cfg.ai.apiKey, model: cfg.ai.model ?? "gpt-4o-mini", timeoutMs: cfg.ai.timeoutMs });
      case "anthropic":
        return new AnthropicProvider({ apiKey: cfg.ai.apiKey!, model: cfg.ai.model ?? "claude-sonnet-4-5", timeoutMs: cfg.ai.timeoutMs });
      case "local":
        return new LocalHeuristicProvider();
      default:
        // No remote provider configured — fall back to the built-in local
        // heuristics so the product never dead-ends. Responses always name
        // their provider ("local-heuristic"), so the fallback is visible,
        // never silent.
        return new LocalHeuristicProvider();
    }
  }

  function enqueue(job: () => void): void {
    queue.push({ run: job });
    pump();
  }

  function pump(): void {
    while (active < MAX_CONCURRENCY && queue.length > 0) {
      const job = queue.shift()!.run;
      active++;
      void job();
    }
  }

  async function runExecution(wf: WorkflowDef, executionId: string, environment: string, variables: Record<string, string>, trigger: Execution["trigger"]): Promise<void> {
    const secrets = await resolveSecrets();
    const ac = new AbortController();
    inFlight.set(executionId, ac);
    const runners = createRunnerRegistry({ ...defaultPolicy, networkAllowlist: cfg.policy.networkAllowlist, maxNetworkRequests: cfg.policy.maxNetworkRequests }, { headless: cfg.browserHeadless });
    const engine = new ExecutionEngine({
      runners,
      policy: { ...defaultPolicy, networkAllowlist: cfg.policy.networkAllowlist, maxNetworkRequests: cfg.policy.maxNetworkRequests },
      secrets,
      evidenceSink: { save: (e: Evidence) => store.saveEvidence(e) },
      globalTimeoutMs: 10 * 60_000,
    });
    try {
      const out = await engine.run(wf, {
        executionId,
        projectId: wf.projectId,
        workflowId: wf.id,
        workflowName: wf.name,
        environment,
        environmentVariables: {},
        variableOverrides: variables,
        trigger,
        cancelSignal: ac.signal,
      });
      store.saveExecution(out.execution, out.failures);
    } catch (e) {
      // The engine guarantees terminal status for normal failure modes; this
      // catch handles engine-level crashes so nothing stays "running".
      const err = toCairnError(e);
      const crashed: Execution = {
        id: executionId, workflowId: wf.id, workflowName: wf.name, workflowVersion: wf.version,
        projectId: wf.projectId, environment, trigger, status: "failed",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0,
        variables: {}, steps: [],
      };
      store.saveExecution(crashed, [{ stepId: "(engine)", code: err.code, message: `Execution engine crashed: ${err.message}` }]);
      app.log.error({ err }, "execution crashed");
    } finally {
      inFlight.delete(executionId);
      active--;
      pump();
    }
  }

  // ---------- routes ----------
  app.get("/api/health", async () => ({ ok: true, version: "0.1.0", ai: cfg.ai.kind === "none" ? "local (built-in)" : cfg.ai.kind }));

  app.get("/api/step-kinds", async () => ({
    kinds: stepKinds.map((k) => ({
      kind: k,
      actionClass: stepActionClasses[k] as ActionClass,
      schemaHint: schemaSummary(stepKindSchemas[k]),
    })),
  }));

  // ----- projects -----
  app.post("/api/projects", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; description?: string };
    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new CairnError("E_VALIDATION", "Project name is required");
    }
    const p = { id: newId("prj"), name: body.name.trim().slice(0, 128), description: body.description?.slice(0, 2048) ?? null, createdAt: new Date().toISOString() };
    store.createProject(p);
    reply.code(201);
    return p;
  });

  app.get("/api/projects", async () => store.listProjects());
  app.get("/api/projects/:id", async (req) => {
    const p = store.getProject((req.params as { id: string }).id);
    if (!p) throw new CairnError("E_NOT_FOUND", "Project not found");
    return p;
  });
  app.delete("/api/projects/:id", async (req) => {
    store.deleteProject((req.params as { id: string }).id);
    return { ok: true };
  });

  // ----- workflows -----
  app.get("/api/projects/:id/workflows", async (req) => store.latestWorkflows((req.params as { id: string }).id));

  app.post("/api/projects/:id/workflows", async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    if (!store.getProject(projectId)) throw new CairnError("E_NOT_FOUND", "Project not found");
    const body = (req.body ?? {}) as Partial<WorkflowDef>;
    const res = validateWorkflow({ ...body, projectId, version: 1 });
    if (!res.ok) {
      throw new CairnError("E_VALIDATION", `Workflow definition is invalid: ${res.issues.map((i) => `${i.stepId ? `[${i.stepId}] ` : ""}${i.field}: ${i.message}`).join("; ")}`, { detail: res.issues });
    }
    const now = new Date().toISOString();
    const id = res.workflow.id;
    if (store.getWorkflow(id)) throw new CairnError("E_CONFLICT", `A workflow with id "${id}" already exists`);
    store.saveWorkflow({ id, projectId, name: res.workflow.name, description: res.workflow.description ?? null, version: 1, def: JSON.stringify(res.workflow), createdAt: now, updatedAt: now }, false);
    reply.code(201);
    return res.workflow;
  });

  app.get("/api/workflows/:id", async (req) => {
    const w = store.getWorkflow((req.params as { id: string }).id);
    if (!w) throw new CairnError("E_NOT_FOUND", "Workflow not found");
    return { ...w, def: JSON.parse(w.def) as WorkflowDef };
  });

  app.put("/api/workflows/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = store.getWorkflow(id);
    if (!existing) throw new CairnError("E_NOT_FOUND", "Workflow not found");
    const body = (req.body ?? {}) as Partial<WorkflowDef>;
    const nextVersion = existing.version + 1;
    const res = validateWorkflow({ ...existing, ...body, id, projectId: existing.projectId, version: nextVersion });
    if (!res.ok) {
      throw new CairnError("E_VALIDATION", `Workflow definition is invalid: ${res.issues.map((i) => `${i.stepId ? `[${i.stepId}] ` : ""}${i.field}: ${i.message}`).join("; ")}`, { detail: res.issues });
    }
    const now = new Date().toISOString();
    store.saveWorkflow({ id, projectId: existing.projectId, name: res.workflow.name, description: res.workflow.description ?? null, version: nextVersion, def: JSON.stringify(res.workflow), createdAt: existing.createdAt, updatedAt: now }, true);
    return res.workflow;
  });

  app.delete("/api/workflows/:id", async (req) => {
    store.deleteWorkflow((req.params as { id: string }).id);
    return { ok: true };
  });

  // ----- executions -----
  app.post("/api/workflows/:id/run", async (req, reply) => {
    const row = store.getWorkflow((req.params as { id: string }).id);
    if (!row) throw new CairnError("E_NOT_FOUND", "Workflow not found");
    const wf = JSON.parse(row.def) as WorkflowDef;
    const body = (req.body ?? {}) as { environment?: string; variables?: Record<string, string> };
    const executionId = newId("ex");
    const environment = body.environment ?? "default";
    // Persist a queued row immediately so clients can poll it, then update in place.
    store.saveExecution({
      id: executionId, workflowId: wf.id, workflowName: wf.name, workflowVersion: wf.version,
      projectId: wf.projectId, environment, trigger: "manual", status: "queued",
      startedAt: new Date().toISOString(), variables: {}, steps: [],
    }, []);
    enqueue(() => { void runExecution(wf, executionId, environment, body.variables ?? {}, "manual"); });
    reply.code(202);
    return { executionId, status: "queued" };
  });

  app.get("/api/executions", async (req) => {
    const q = req.query as { projectId?: string; limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? "50", 10) || 50, 1), 200);
    return store.listExecutions(q.projectId, limit);
  });

  app.get("/api/executions/:id", async (req) => {
    const e = store.getExecution((req.params as { id: string }).id);
    if (!e) throw new CairnError("E_NOT_FOUND", "Execution not found");
    return e;
  });

  app.post("/api/executions/:id/cancel", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ac = inFlight.get(id);
    if (!ac) {
      const e = store.getExecution(id);
      if (!e) throw new CairnError("E_NOT_FOUND", "Execution not found");
      return { ok: false, message: "Execution is not running (status: " + e.status + ")" };
    }
    ac.abort();
    reply.code(202);
    return { ok: true, message: "Cancellation requested" };
  });

  app.get("/api/executions/:id/evidence", async (req) => store.listEvidence((req.params as { id: string }).id));

  app.get("/api/executions/:id/evidence/:evidenceId", async (req, reply) => {
    const params = req.params as { id: string; evidenceId: string };
    const ev = store.getEvidence(params.evidenceId);
    if (!ev || ev.executionId !== params.id) throw new CairnError("E_NOT_FOUND", "Evidence not found");
    if (ev.encoding === "base64") {
      const buf = Buffer.from(ev.data, "base64");
      reply.header("content-type", ev.contentType);
      reply.send(buf);
      return;
    }
    return { ...ev };
  });

  // ----- dashboard (real numbers only — computed from stored executions) -----
  app.get("/api/dashboard", async (req) => {
    const q = req.query as { projectId?: string };
    const executions = store.listExecutions(q.projectId, 200);
    const byStatus = { passed: 0, failed: 0, cancelled: 0, other: 0 };
    for (const e of executions) {
      if (e.status === "passed") byStatus.passed++;
      else if (e.status === "failed") byStatus.failed++;
      else if (e.status === "cancelled") byStatus.cancelled++;
      else byStatus.other++;
    }
    // Flaky proxy: workflows whose recent runs contain both passes and fails.
    const perWorkflow = new Map<string, { pass: number; fail: number }>();
    for (const e of executions) {
      const entry = perWorkflow.get(e.workflowId) ?? { pass: 0, fail: 0 };
      if (e.status === "passed") entry.pass++;
      if (e.status === "failed") entry.fail++;
      perWorkflow.set(e.workflowId, entry);
    }
    const flaky = [...perWorkflow.values()].filter((v) => v.pass > 0 && v.fail > 0).length;
    return {
      totals: { executions: executions.length, ...byStatus, flakySuspects: flaky },
      recent: executions.slice(0, 10),
      generatedAt: new Date().toISOString(),
    };
  });

  // ----- AI -----
  app.post("/api/ai/plan", async (req) => {
    const body = (req.body ?? {}) as { projectId?: string; intent?: string; context?: string };
    if (!body.intent || typeof body.intent !== "string" || body.intent.trim().length < 8) {
      throw new CairnError("E_VALIDATION", "Describe the intent in at least a few words (min 8 chars)");
    }
    if (!body.projectId || !store.getProject(body.projectId)) throw new CairnError("E_NOT_FOUND", "Project not found");
    const provider = buildProvider();
    const result = await planWorkflow(provider, { intent: body.intent.trim(), context: body.context, projectId: body.projectId });
    return result;
  });

  app.post("/api/executions/:id/analyze", async (req) => {
    const e = store.getExecution((req.params as { id: string }).id);
    if (!e) throw new CairnError("E_NOT_FOUND", "Execution not found");
    const failures = e.failures as import("@cairn/core").FailureRecord[];
    if (!failures || failures.length === 0) {
      throw new CairnError("E_CONFLICT", "This execution has no failures to analyze (status: " + e.status + ")");
    }
    const provider = buildProvider();
    const evidence = store.listEvidence(e.id);
    const failure = failures[0]!;
    const ai = await analyzeFailure(provider, {
      execution: { ...e, steps: e.steps ?? [] },
      failure,
      evidenceSummaries: evidence.map((ev) => ({ id: ev.id, type: ev.type, label: ev.label ?? undefined, preview: previewOf(ev.id) })),
    });
    return { failure, ai };
  });

  function previewOf(evidenceId: string): string {
    const ev = store.getEvidence(evidenceId);
    if (!ev) return "(missing)";
    const raw = ev.encoding === "base64" ? "(binary)" : ev.data;
    return raw.slice(0, 300);
  }

  // ----- secrets -----
  app.get("/api/secrets", async () => store.listSecretNames());

  app.put("/api/secrets/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new CairnError("E_VALIDATION", "Secret names use letters, digits, underscores");
    const body = (req.body ?? {}) as { value?: string };
    if (!body.value || typeof body.value !== "string") throw new CairnError("E_VALIDATION", "Secret value is required");
    const rec = box.encrypt(body.value);
    store.saveSecret({ name, ...rec, createdAt: new Date().toISOString() });
    reply.code(204);
    return null;
  });

  app.delete("/api/secrets/:name", async (req) => {
    const ok = store.deleteSecret((req.params as { name: string }).name);
    if (!ok) throw new CairnError("E_NOT_FOUND", "Secret not found");
    return { ok: true };
  });

  // ----- static UI -----
  const webDist = resolve(process.cwd(), "../web/dist");
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/")) {
        reply.code(404).send({ error: { code: "E_NOT_FOUND", message: "Unknown API route" } });
        return;
      }
      return reply.sendFile("index.html");
    });
  }

  return { app, store };
}

/** One-line summary of a step kind's config schema for the UI editor. */
function schemaSummary(schema: unknown): string {
  const s = schema as { _def?: { typeName?: string; fields?: Record<string, { _def?: { typeName?: string } }> } };
  const fields = s?._def?.fields;
  if (!fields) return "";
  return Object.entries(fields).map(([k, v]) => {
    const t = v?._def?.typeName?.replace("Zod", "").toLowerCase() ?? "any";
    return `${k}: ${t}`;
  }).join(", ");
}

// Standalone boot.
if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const cfg = loadConfig();
  const { app, store } = await buildServer(cfg);
  app.listen({ port: cfg.port, host: cfg.host }).then((addr) => {
    const url = addr.replace("0.0.0.0", "127.0.0.1").replace("[::]", "127.0.0.1").replace("::", "127.0.0.1");
    const aiLabel = cfg.ai.kind === "openai-compatible"
      ? `openai-compatible (${cfg.ai.model ?? "default model"})`
      : cfg.ai.kind === "anthropic"
        ? `anthropic (${cfg.ai.model ?? "claude"})`
        : "local heuristics (built-in, offline)";
    process.stdout.write(`
   /\\      cairn v0.1.0 — evidence-first automation & QA
  /  \\     console   ${url}
 / /\\ \\    data       ${resolve(cfg.dataDir)}
/_/  \\_\\   ai          ${aiLabel}

`);
    app.log.info(`Cairn server listening on ${addr} (data: ${resolve(cfg.dataDir)})`);
    void store;
  }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
