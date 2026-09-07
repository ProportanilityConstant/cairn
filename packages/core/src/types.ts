/** Core domain types. These are shared by the engine, the AI layer, the API and the UI. */

export type ActionClass = "read" | "safe_write" | "network" | "authenticated" | "destructive";

export interface StepDef {
  /** Unique within the workflow. Referenced by conditions and failure records. */
  id: string;
  name: string;
  /** A registered step kind, e.g. "http.request", "browser.goto". */
  kind: string;
  /** Validated against the kind's schema before execution. */
  config: unknown;
  retries?: number;
  timeoutMs?: number;
  /** "abort" stops the execution (default); "continue" records the failure and moves on. */
  onFailure?: "abort" | "continue";
  /** Skip this step unless the condition evaluates truthy. */
  condition?: string;
  /** Classes above "read" that this step is explicitly allowed to use. */
  allow?: ActionClass[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  version: number;
  projectId: string;
  steps: StepDef[];
  /** Named variable defaults. Secrets are referenced, never inlined: {{secrets.X}}. */
  variables?: Record<string, string | number | boolean>;
  allowExplicit?: boolean;
}

export type ExecutionStatus =
  | "queued" | "preparing" | "running" | "passed" | "failed" | "cancelled" | "timed_out";

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cancelled";

export interface AssertionFailure {
  target: string;
  op: string;
  expected: string;
  observed: string;
  message: string;
}

export interface StepResult {
  stepId: string;
  name: string;
  kind: string;
  status: StepStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Machine-readable, validated output contributed to the execution context. */
  output?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; assertion?: AssertionFailure };
  evidenceIds: string[];
  skippedReason?: string;
}

export interface Execution {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  projectId: string;
  environment: string;
  trigger: "manual" | "api" | "schedule";
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  variables: Record<string, string>;
  steps: StepResult[];
}

export type EvidenceType = "http_exchange" | "screenshot" | "log" | "note" | "json" | "dom";

export interface Evidence {
  id: string;
  executionId: string;
  stepId: string;
  type: EvidenceType;
  contentType: string;
  /** Text, or base64 for binary evidence such as screenshots. */
  data: string;
  encoding: "utf8" | "base64";
  createdAt: string;
  label?: string;
}

/**
 * Failure intelligence record. The contract is explicit:
 * `expected`/`observed`/`error` are facts. Everything under `ai` is a
 * hypothesis with confidence — the UI must render them differently.
 */
export interface FailureRecord {
  stepId: string;
  code: string;
  message: string;
  hint?: string;
  assertion?: AssertionFailure;
  ai?: {
    provider: string;
    summary: string;
    likelyCause: string;
    suggestedInvestigation: string[];
    confidence: "low" | "medium" | "high";
    evidenceRefs: string[];
  };
}

/** Context available to step runners: resolved variables, prior step outputs. */
export interface RunContext {
  executionId: string;
  projectId: string;
  environment: string;
  variables: Record<string, string>;
  /** Outputs of completed steps, keyed by step id. */
  steps: Record<string, Record<string, unknown>>;
  logger: (level: "info" | "warn" | "error", message: string) => void;
  /** Cooperative cancellation. Runners must honor it. */
  signal: AbortSignal;
  /** Attach evidence; returns its id. Runners pass already-masked payloads. */
  emitEvidence: (e: Omit<Evidence, "id" | "executionId" | "stepId" | "createdAt">) => string;
}

export interface StepRunner {
  kind: string;
  actionClass: ActionClass;
  validate(config: unknown): { ok: true } | { ok: false; issues: string[] };
  /** Execute one attempt. Throw CairnError on failure; return validated output on success. */
  run(config: unknown, ctx: RunContext): Promise<Record<string, unknown>>;
}

/** Interpolate {{variables.x}} / {{secrets.x}} / {{steps.id.field}} references. */
export interface Interpolator {
  render(template: string): string;
}
