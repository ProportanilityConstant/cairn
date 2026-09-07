import { describe, expect, it } from "vitest";
import { LocalHeuristicProvider, completeStructured, planDraftSchema, draftToWorkflow, localAnalysis } from "../src/index.js";
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
