import {
  CairnError,
  assertWorkflowValid,
  stepKinds,
  type Execution,
  type FailureRecord,
  type WorkflowDef,
} from "@cairn/core";
import {
  completeStructured,
  failureAnalysisSchema,
  planDraftSchema,
  type AIProvider,
  type FailureAnalysis,
  type PlanDraft,
} from "./provider.js";

/**
 * Planner: natural-language intent → a *draft* workflow definition.
 * The draft is validated by the same code paths the API uses for
 * hand-written workflows — the AI cannot produce a definition the engine
 * would reject. Unregistered kinds are dropped, never invented.
 */

const PLANNER_SYSTEM = `You are a senior QA engineer writing automation workflows for Cairn.
Available step kinds: ${stepKinds.join(", ")}.
Rules:
- Use only the listed kinds.
- http.request config: { url, method, headers?, query?, body?, assertions?: [{target, path?, op, value?}] }.
  Assertion targets: status, latency_ms, header, body_text, body_json, body_length. Ops: eq, ne, gt, gte, lt, lte, contains, matches, exists.
- assert config: { expr, expect? } — expr may reference vars.* and steps.<id>.<output>.
- note config: { text }.
- URLs must use {{vars.<name>}} for hosts so workflows stay portable across environments.
- Prefer a small number of high-signal assertions over exhaustive ones.`;

export interface PlanRequest {
  intent: string;
  /** Anything the user told us about the target app (URLs, auth style, known endpoints). */
  context?: string;
  projectId: string;
}

export interface PlanResult {
  workflow: WorkflowDef;
  draft: PlanDraft;
  provider: string;
}

/**
 * Offline planner. Reads the intent for concrete signals — a target URL,
 * health/ping endpoint names, a latency budget — and emits a small, honest
 * draft. It never invents endpoints it didn't see; anything it couldn't
 * determine is left for the user to fill in, and the note step says so.
 */
export function localPlanDraft(req: PlanRequest): PlanDraft {
  const text = `${req.intent}\n${req.context ?? ""}`.trim();
  const low = text.toLowerCase();

  // Target: first URL in the intent or context. Use its origin as baseUrl and
  // keep an explicit path only when the user named one.
  const urlMatch = text.match(/https?:\/\/[^\s,;'")\]]+/i);
  let baseUrl = "";
  let path = "";
  if (urlMatch) {
    try {
      const u = new URL(urlMatch[0].replace(/[.,;]+$/, ""));
      baseUrl = u.origin;
      path = u.pathname !== "/" ? u.pathname : "";
    } catch { baseUrl = urlMatch[0].replace(/[.,;]+$/, ""); }
  }

  // Endpoint guess: explicit ping/health mentions win; otherwise the path from
  // the URL; otherwise the conventional health path.
  if (/\bping\b/.test(low)) path = path || "/ping";
  else if (/\bhealth|healthy\b/.test(low)) path = path || "/health";
  else if (!path) path = "/health";

  const steps: PlanDraft["steps"] = [];

  const assertions: Record<string, unknown>[] = [{ target: "status", op: "eq", value: 200 }];
  const latency = text.match(/within\s+(\d+)\s*ms\b/i);
  if (latency) assertions.push({ target: "latency_ms", op: "lte", value: Number(latency[1]) });

  steps.push({
    id: "probe",
    name: `Probe ${path}`,
    kind: "http.request",
    config: { url: `{{vars.baseUrl}}${path}`, method: "GET", assertions },
    rationale: `GET {{vars.baseUrl}}${path} must answer 200${latency ? ` within ${latency[1]}ms` : ""}. This is the one check the intent states clearly; the heuristic planner adds nothing it cannot see.`,
  });

  steps.push({
    id: "record_result",
    name: "Record result",
    kind: "note",
    config: { text: `Heuristic draft (local-heuristic rules-v1) for intent: ${req.intent.slice(0, 200)}. Review every step and set the baseUrl variable before running — this draft only automates what the intent stated explicitly.` },
    rationale: "Every run leaves a note in the evidence trail marking this workflow as heuristic-drafted and not yet reviewed.",
  });

  const name = (req.intent.trim().split(/\n/)[0]?.slice(0, 80) || "Heuristic draft").replace(/\s+/g, " ");
  return {
    name: name.length > 0 ? name : "Heuristic draft",
    description: `Drafted by the offline heuristic planner (rules-v1) from the stated intent. It checks ${path} on {{vars.baseUrl}} returns 200. Review and edit before running.`,
    variables: [{ name: "baseUrl", value: baseUrl }],
    steps,
  };
}

export async function planWorkflow(provider: AIProvider, req: PlanRequest): Promise<PlanResult> {
  // Deterministic offline planning: rule-based, honest, useful. Mirrors the
  // analyzer's local-heuristic bypass so "Draft with AI" works with no model.
  if (provider.id === "local-heuristic") {
    const draft = localPlanDraft(req);
    const workflow = draftToWorkflow(draft, req.projectId);
    return { workflow, draft, provider: provider.id };
  }

  const user = [
    `Intent: ${req.intent}`,
    req.context ? `Context about the target: ${req.context}` : "",
  ].filter(Boolean).join("\n");

  const { data: draft } = await completeStructured(
    provider,
    { system: PLANNER_SYSTEM, user, temperature: 0.2, maxTokens: 3000 },
    planDraftSchema,
    JSON.stringify(planDraftSchema.shape, (_k, v) => (typeof v === "function" ? "<string|number|boolean>" : v), 2)
  );

  const workflow = draftToWorkflow(draft, req.projectId);
  return { workflow, draft, provider: provider.id };
}

export function draftToWorkflow(draft: PlanDraft, projectId: string): WorkflowDef {
  // Drop steps whose kind is not registered (the model may hallucinate kinds).
  const allowed = new Set(stepKinds);
  const seen = new Set<string>();
  const steps = draft.steps
    .filter((s) => allowed.has(s.kind))
    .map((s) => {
      let id = s.id;
      let n = 2;
      while (seen.has(id)) id = `${s.id}_${n++}`;
      seen.add(id);
      return { id, name: s.name, kind: s.kind, config: s.config };
    });
  if (steps.length === 0) {
    throw new CairnError("E_AI_SCHEMA", "The generated plan contained no valid steps", { hint: "Rephrase the intent, or build the workflow manually — the editor gives full access." });
  }
  const variables: Record<string, string> = {};
  for (const v of draft.variables) variables[v.name] = v.value;
  return assertWorkflowValid({
    id: `planned_${Date.now().toString(36)}`,
    name: draft.name,
    description: draft.description,
    version: 1,
    projectId,
    steps,
    variables,
  });
}

/**
 * Failure intelligence. Produces a *hypothesis* with confidence, clearly
 * separated from observed facts (which the engine already recorded).
 */
export async function analyzeFailure(
  provider: AIProvider,
  input: {
    execution: Execution;
    failure: FailureRecord;
    evidenceSummaries: { id: string; type: string; label?: string; preview: string }[];
  }
): Promise<FailureRecord["ai"]> {
  // Deterministic offline analysis: rule-based, honest, useful.
  if (provider.id === "local-heuristic") {
    return localAnalysis(input.failure, input.evidenceSummaries);
  }

  const { execution, failure, evidenceSummaries } = input;
  const user = [
    `Workflow: ${execution.workflowName} (v${execution.workflowVersion})`,
    `Failed step: ${failure.stepId} — ${failure.code}: ${failure.message}`,
    failure.assertion ? `Expected: ${failure.assertion.expected}\nObserved: ${failure.assertion.observed}` : "",
    failure.hint ? `Engine hint: ${failure.hint}` : "",
    "",
    "Evidence available:",
    ...evidenceSummaries.map((e) => `- [${e.type}] ${e.label ?? e.id}: ${e.preview.slice(0, 300)}`),
    "",
    "Analyze the failure. Distinguish observed facts from inference. Set confidence honestly: high only when evidence directly confirms the cause.",
  ].filter(Boolean).join("\n");

  try {
    const { data } = await completeStructured(
      provider,
      {
        system: "You are a pragmatic QA failure analyst. You never state a guess as fact.",
        user,
        temperature: 0.1,
        maxTokens: 1500,
      },
      failureAnalysisSchema,
      JSON.stringify(failureAnalysisSchema.shape, (_k, v) => (typeof v === "function" ? "<string>" : v), 2)
    );
    return {
      provider: provider.id,
      summary: data.summary,
      likelyCause: data.likelyCause,
      suggestedInvestigation: data.suggestedInvestigation,
      confidence: data.confidence,
      evidenceRefs: evidenceSummaries.slice(0, 4).map((e) => e.id),
    };
  } catch (e) {
    // AI analysis is best-effort: fall back to the local rules, mark it so.
    if (e instanceof CairnError && (e.code === "E_AI_PROVIDER" || e.code === "E_AI_SCHEMA")) {
      return { ...localAnalysis(failure, evidenceSummaries)!, provider: `${provider.id} (unavailable — fell back to local heuristics)` };
    }
    throw e;
  }
}

/** Rule-based hypothesis generation. Deterministic and cheap by design. */
export function localAnalysis(failure: FailureRecord, evidence: { id: string; type: string }[]): NonNullable<FailureRecord["ai"]> {
  const investigation: string[] = [];
  let cause: string;
  let confidence: "low" | "medium" | "high";

  switch (failure.code) {
    case "E_ASSERTION":
      if (failure.assertion?.observed === "(missing)") {
        cause = `The asserted field (${failure.assertion.target}) was absent from the response. Either the API contract changed or an earlier step did not produce the expected data.`;
        investigation.push("Re-run the workflow and inspect the http_exchange evidence for the failed request.", "Check whether a prior step's output feeds this assertion.");
        confidence = "medium";
      } else {
        cause = `The response was received but did not match the expectation (${failure.assertion?.expected ?? "assertion"}). This is usually a real behavior change, not tooling noise.`;
        investigation.push("Compare the observed response body in the evidence against the documented API contract.", "If a deploy just happened, diff the change.");
        confidence = "medium";
      }
      break;
    case "E_TIMEOUT":
      cause = "The target did not respond within the configured time. The cause is latency or unavailability of the target system, not the workflow definition.";
      investigation.push("Check whether the target service is up and its latency from this host.", "Re-run once: a single slow response is often transient.");
      confidence = "low";
      break;
    case "E_HTTP":
      cause = "The request never reached a server (connection-level failure). DNS, port, or TLS is the problem.";
      investigation.push("Confirm the host and port in the step URL.", "Try the same URL with curl from the server running Cairn.");
      confidence = "high";
      break;
    case "E_POLICY":
      cause = "The security policy blocked this step by design. This is a configuration decision, not a runtime fault.";
      investigation.push("Review the step's action class and the project's network allowlist.", "Only widen policy deliberately — the block is the control working.");
      confidence = "high";
      break;
    case "E_BROWSER":
      cause = "The browser automation layer failed. Commonly a missing Playwright browser install or an unstable selector.";
      investigation.push("Run: npx playwright-core install chromium", "Check the selector against the page's current DOM.");
      confidence = "medium";
      break;
    case "E_VALIDATION":
      cause = "The step configuration was rejected before execution. Nothing ran, so no target system was affected.";
      investigation.push("Fix the configuration error shown in the message and re-run.");
      confidence = "high";
      break;
    default:
      cause = `The engine reported ${failure.code}. The failure record's message is authoritative; no stronger hypothesis is available without more evidence.`;
      investigation.push("Inspect the step evidence attached to this failure.");
      confidence = "low";
  }

  return {
    provider: "local-heuristic",
    summary: `Step "${failure.stepId}" failed with ${failure.code}: ${failure.message.slice(0, 200)}`,
    likelyCause: cause,
    suggestedInvestigation: investigation,
    confidence,
    evidenceRefs: evidence.slice(0, 4).map((e) => e.id),
  };
}
