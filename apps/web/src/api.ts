/** Typed API client. Every surface in the console renders from these calls — no mock data anywhere. */

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface StepDef {
  id: string;
  name: string;
  kind: string;
  config: unknown;
  retries?: number;
  timeoutMs?: number;
  onFailure?: "abort" | "continue";
  condition?: string;
  allow?: string[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  version: number;
  projectId: string;
  steps: StepDef[];
  variables?: Record<string, string | number | boolean>;
}

export interface WorkflowRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StepResult {
  stepId: string;
  name: string;
  kind: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "cancelled";
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string };
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
  trigger: string;
  status: "queued" | "preparing" | "running" | "passed" | "failed" | "cancelled" | "timed_out";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  variables: Record<string, string>;
  steps: StepResult[];
  failures: FailureRecord[];
}

export interface FailureRecord {
  stepId: string;
  code: string;
  message: string;
  hint?: string;
  assertion?: { target: string; op: string; expected: string; observed: string; message: string };
  ai?: {
    provider: string;
    summary: string;
    likelyCause: string;
    suggestedInvestigation: string[];
    confidence: "low" | "medium" | "high";
    evidenceRefs: string[];
  };
}

export interface EvidenceMeta {
  id: string;
  stepId: string;
  type: string;
  contentType: string;
  label: string | null;
  createdAt: string;
  size: number;
}

export interface Dashboard {
  totals: { executions: number; passed: number; failed: number; cancelled: number; other: number; flakySuspects: number };
  recent: Execution[];
  generatedAt: string;
}

export interface StepKindInfo {
  kind: string;
  actionClass: string;
  schemaHint: string;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint?: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; hint?: string } })?.error;
    throw new ApiError(err?.code ?? "E_HTTP", err?.message ?? `Request failed with HTTP ${res.status}`, err?.hint);
  }
  return json as T;
}

export const api = {
  dashboard: (projectId?: string) => call<Dashboard>("GET", `/api/dashboard${projectId ? `?projectId=${projectId}` : ""}`),
  projects: () => call<Project[]>("GET", "/api/projects"),
  createProject: (name: string, description?: string) => call<Project>("POST", "/api/projects", { name, description }),
  deleteProject: (id: string) => call<{ ok: boolean }>("DELETE", `/api/projects/${id}`),

  workflows: (projectId: string) => call<WorkflowRow[]>("GET", `/api/projects/${projectId}/workflows`),
  workflow: (id: string) => call<{ def: WorkflowDef } & WorkflowRow>("GET", `/api/workflows/${id}`),
  createWorkflow: (projectId: string, def: WorkflowDef) => call<WorkflowDef>("POST", `/api/projects/${projectId}/workflows`, def),
  updateWorkflow: (id: string, def: Partial<WorkflowDef>) => call<WorkflowDef>("PUT", `/api/workflows/${id}`, def),
  deleteWorkflow: (id: string) => call<{ ok: boolean }>("DELETE", `/api/workflows/${id}`),
  runWorkflow: (id: string, environment: string, variables: Record<string, string>) =>
    call<{ executionId: string }>("POST", `/api/workflows/${id}/run`, { environment, variables }),

  executions: (projectId?: string) => call<Execution[]>("GET", `/api/executions${projectId ? `?projectId=${projectId}` : ""}`),
  execution: (id: string) => call<Execution>("GET", `/api/executions/${id}`),
  cancelExecution: (id: string) => call<{ ok: boolean; message?: string }>("POST", `/api/executions/${id}/cancel`),
  evidence: (id: string) => call<EvidenceMeta[]>("GET", `/api/executions/${id}/evidence`),
  analyze: (id: string) => call<{ failure: FailureRecord; ai: NonNullable<FailureRecord["ai"]> }>("POST", `/api/executions/${id}/analyze`),

  stepKinds: () => call<{ kinds: StepKindInfo[] }>("GET", "/api/step-kinds"),
  secrets: () => call<{ name: string; createdAt: string }[]>("GET", "/api/secrets"),
  setSecret: (name: string, value: string) => call<null>("PUT", `/api/secrets/${name}`, { value }),
  deleteSecret: (name: string) => call<{ ok: boolean }>("DELETE", `/api/secrets/${name}`),

  health: () => call<{ ok: boolean; version: string; ai: string }>("GET", "/api/health"),
  plan: (projectId: string, intent: string, context?: string) =>
    call<{ workflow: WorkflowDef; provider: string; draft: { steps: { id: string; rationale?: string }[] } }>("POST", "/api/ai/plan", { projectId, intent, context }),
};

export const TERMINAL_STATUSES = ["passed", "failed", "cancelled", "timed_out"];
