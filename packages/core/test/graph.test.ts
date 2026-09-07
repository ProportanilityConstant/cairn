import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/graph.js";
import { interpolate } from "../src/interpolate.js";

const wf = {
  id: "demo", name: "Demo", version: 1, projectId: "p1",
  steps: [
    { id: "ping", name: "Ping", kind: "http.request", config: { url: "{{vars.baseUrl}}/ping" } },
    { id: "check", name: "Check", kind: "assert", config: { expr: "true" }, condition: "steps.ping.status == 200" },
  ],
  variables: { baseUrl: "http://localhost:5175" },
};

describe("workflow validation", () => {
  it("accepts a valid workflow and normalizes it", () => {
    const res = validateWorkflow(wf);
    expect(res.ok).toBe(true);
  });

  it("rejects unknown step kinds with a clear issue", () => {
    const res = validateWorkflow({ ...wf, steps: [{ ...wf.steps[0], kind: "magic.auto" }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => /Unknown kind/.test(i.message))).toBe(true);
  });

  it("rejects invalid step config with actionable paths", () => {
    const res = validateWorkflow({ ...wf, steps: [{ id: "bad", name: "Bad", kind: "http.request", config: { url: 42 } }] });
    expect(res.ok).toBe(false);
  });

  it("rejects duplicate step ids and malformed conditions", () => {
    const dup = validateWorkflow({ ...wf, steps: [wf.steps[0], wf.steps[0]!] });
    expect(dup.ok).toBe(false);
    const badCond = validateWorkflow({ ...wf, steps: [{ ...wf.steps[0]!, condition: "(((" }] });
    expect(badCond.ok).toBe(false);
  });
});

describe("interpolation", () => {
  const scope = {
    vars: { baseUrl: "http://x" },
    secrets: { apiKey: "K" },
    steps: { s1: { status: 200, body: { id: 7 } } },
  };

  it("resolves vars, secrets and step outputs", () => {
    expect(interpolate("{{vars.baseUrl}}/a?key={{secrets.apiKey}}", scope)).toBe("http://x/a?key=K");
    expect(interpolate("{{steps.s1.body.id}}", scope)).toBe("7");
  });

  it("errors on unknown references instead of writing empty strings", () => {
    expect(() => interpolate("{{vars.missing}}", scope)).toThrow(/Unknown variable/);
    expect(() => interpolate("{{steps.nope.status}}", scope)).toThrow(/has not produced output/);
  });
});
