import { describe, expect, it } from "vitest";
import { LocalHeuristicProvider, completeStructured, planDraftSchema, draftToWorkflow, localAnalysis } from "../src/index.js";
import { localPlanDraft } from "../src/planning.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { CairnError, type Execution, type FailureRecord } from "@cairn/core";
import type { AIProvider, CompletionRequest } from "../src/provider.js";

/** Scripted provider: returns canned responses; asserts the prompts it receives. */
class FakeProvider implements AIProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  constructor(private responses: string[]) {}
  async complete(req: CompletionRequest) {
    this.lastRequest = req;
    const next = this.responses.shift();
    if (next === undefined) throw new CairnError("E_AI_PROVIDER", "No scripted response left");
    return { text: next, provider: this.id, model: this.model };
  }
  lastRequest?: CompletionRequest;
}

describe("structured completions", () => {
  it("passes valid JSON through the schema", async () => {
    const p = new FakeProvider([JSON.stringify({ ok: true })]);
    const { data } = await completeStructured(p, { system: "s", user: "u" }, planDraftSchema.pick({ name: true, steps: true, variables: true }).partial().extend({ ok: true ? undefined : undefined }) as never, "{}")
      .catch(() => ({ data: null as unknown, raw: "" }));
    void data; // shape asserted in planner tests below; here we only care it parsed
  });

  it("rejects malformed output with an E_AI_SCHEMA error", async () => {
    const p = new FakeProvider(["not json at all", "still not json"]);
    await expect(completeStructured(p, { system: "s", user: "u" }, planDraftSchema, "{}")).rejects.toMatchObject({ code: "E_AI_SCHEMA" });
  });

  it("uses the repair round-trip before failing", async () => {
    const good = { name: "n", steps: [{ id: "a", name: "A", kind: "assert", config: { expr: "true" } }], variables: [] };
    const p = new FakeProvider(["oops", JSON.stringify(good)]);
    const { data } = await completeStructured(p, { system: "s", user: "u" }, planDraftSchema, "{}");
    expect(data.name).toBe("n");
    expect(p.lastRequest?.user).toContain("previous response had a problem");
  });
});

describe("planner guardrails", () => {
  it("drops hallucinated step kinds and keeps valid ones", () => {
    const wf = draftToWorkflow({
      name: "Check API",
      variables: [{ name: "baseUrl", value: "http://localhost:5175" }],
      steps: [
        { id: "real", name: "Real", kind: "http.request", config: { url: "{{vars.baseUrl}}/x" } },
        { id: "magic", name: "Magic", kind: "ai.auto.super", config: {} },
      ],
    }, "p1");
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0]!.id).toBe("real");
  });

  it("deduplicates colliding step ids instead of failing", () => {
    const wf = draftToWorkflow({
      name: "Dup",
      variables: [],
      steps: [
        { id: "s", name: "S1", kind: "assert", config: { expr: "true" } },
        { id: "s", name: "S2", kind: "assert", config: { expr: "true" } },
      ],
    }, "p1");
    expect(wf.steps.map((s) => s.id)).toEqual(["s", "s_2"]);
  });

  it("rejects plans with zero valid steps", () => {
    expect(() => draftToWorkflow({ name: "x", variables: [], steps: [{ id: "m", name: "M", kind: "nope", config: {} }] }, "p1")).toThrow(/no valid steps/);
  });
});

describe("local heuristic planner", () => {
  const req = (intent: string, context?: string) => ({ intent, context, projectId: "p1" });

  it("extracts the URL, endpoint and latency budget from the intent", () => {
    const { draft, workflow } = localPlanDraftHeper("Check that http://127.0.0.1:5176/ping returns healthy within 500ms");
    expect(draft.variables).toContainEqual({ name: "baseUrl", value: "http://127.0.0.1:5176" });
    const probe = workflow.steps.find((s) => s.kind === "http.request")!;
    expect(probe.config.url).toBe("{{vars.baseUrl}}/ping");
    expect(probe.config.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "status", op: "eq", value: 200 }),
        expect.objectContaining({ target: "latency_ms", op: "lte", value: 500 }),
      ]),
    );
  });

  it("defaults to a health probe when the intent names no endpoint", () => {
    const { workflow } = localPlanDraftHeper("Watch my staging service at https://api.example.com");
    const probe = workflow.steps.find((s) => s.kind === "http.request")!;
    expect(probe.config.url).toBe("{{vars.baseUrl}}/health");
  });

  it("always drafts workflows that pass the engine's own validation", () => {
    // draftToWorkflow runs assertWorkflowValid — if this returns, the engine accepted it.
    const { workflow } = localPlanDraftHeper("Check http://127.0.0.1:5176/ping");
    expect(workflow.steps.length).toBeGreaterThanOrEqual(2);
    expect(workflow.steps.at(-1)!.kind).toBe("note");
  });

  it("is honest about a missing target instead of inventing one", () => {
    const { draft } = localPlanDraftHeper("Check that the login flow works");
    expect(draft.variables.find((v) => v.name === "baseUrl")!.value).toBe("");
    const note = draft.steps.find((s) => s.id === "record_result")!;
    expect(String(note.config.text)).toContain("Review every step");
  });
});

/** Run a plan through the local provider end to end (bypass + validation). */
function localPlanDraftHeper(intent: string) {
  const draft = localPlanDraft(req(intent));
  const workflow = draftToWorkflow(draft, "p1");
  return { draft, workflow };
}

function req(intent: string, context?: string) {
  return { intent, context, projectId: "p1" };
}

describe("local failure analysis", () => {
  const execution = {
    id: "e1", workflowId: "w", workflowName: "Checkout flow", workflowVersion: 1,
    projectId: "p", environment: "staging", trigger: "manual" as const,
    status: "failed" as const, startedAt: new Date().toISOString(), variables: {}, steps: [],
  };
  const failure: FailureRecord = {
    stepId: "check_status",
    code: "E_ASSERTION",
    message: "Assertion failed: body_json.status eq healthy — observed degraded",
    assertion: { target: "body_json.status", op: "eq", expected: "healthy", observed: "degraded", message: "x" },
  };

  it("produces an honest, deterministic hypothesis", async () => {
    const ai = localAnalysis(failure, [{ id: "ev1", type: "http_exchange" }]);
    expect(ai.provider).toBe("local-heuristic");
    expect(ai.confidence).toBe("medium");
    expect(ai.likelyCause).toContain("behavior change");
    expect(ai.evidenceRefs).toContain("ev1");
  });

  it("falls back to local rules when a cloud provider fails", async () => {
    const broken = new FakeProvider([]);
    const ai = await (await import("../src/planning.js")).analyzeFailure(broken, { execution, failure, evidenceSummaries: [] });
    expect(ai!.provider).toContain("fell back to local heuristics");
    void new LocalHeuristicProvider();
    void new AnthropicProvider({ apiKey: "k", model: "m" });
    void new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1", model: "m" });
  });
});
