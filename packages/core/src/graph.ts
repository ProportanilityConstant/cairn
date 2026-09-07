import { z } from "zod";
import { CairnError } from "./errors.js";
import { isRegisteredKind, validateStepConfig } from "./steps.js";
import { compileCondition } from "./expr.js";
import type { WorkflowDef, StepDef } from "./types.js";

const stepDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/).min(1).max(64),
  name: z.string().min(1).max(128),
  kind: z.string().min(1).max(64),
  config: z.unknown(),
  retries: z.number().int().min(0).max(10).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  onFailure: z.enum(["abort", "continue"]).optional(),
  condition: z.string().max(2048).optional(),
  allow: z.array(z.enum(["read", "safe_write", "network", "authenticated", "destructive"])).optional(),
});

const workflowSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  version: z.number().int().min(1),
  projectId: z.string().min(1).max(64),
  steps: z.array(stepDefSchema).min(1).max(200),
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.union([z.string().max(4096), z.number(), z.boolean()])).optional(),
  allowExplicit: z.boolean().optional(),
});

export interface ValidationIssue {
  stepId?: string;
  field: string;
  message: string;
}

/**
 * Validate a workflow definition end-to-end: shape, step kinds, per-step
 * config schemas, conditions, and cross-step references. Returns a fully
 * normalized definition on success.
 */
export function validateWorkflow(input: unknown): { ok: true; workflow: WorkflowDef } | { ok: false; issues: ValidationIssue[] } {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ field: i.path.join(".") || "(root)", message: i.message })) };
  }
  const wf = parsed.data as WorkflowDef;
  const issues: ValidationIssue[] = [];

  const seen = new Set<string>();
  for (const step of wf.steps) {
    if (seen.has(step.id)) issues.push({ stepId: step.id, field: "id", message: `Duplicate step id "${step.id}"` });
    seen.add(step.id);

    if (!isRegisteredKind(step.kind)) {
      issues.push({ stepId: step.id, field: "kind", message: `Unknown kind "${step.kind}"` });
    } else {
      const res = validateStepConfig(step.kind, step.config);
      if (!res.ok) {
        for (const m of res.issues) issues.push({ stepId: step.id, field: "config", message: m });
      }
    }

    if (step.condition !== undefined) {
      try {
        // Compile now so malformed conditions fail at save time, not run time.
        compileCondition(step.condition);
      } catch (e) {
        issues.push({ stepId: step.id, field: "condition", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, workflow: wf };
}

export function assertWorkflowValid(input: unknown): WorkflowDef {
  const res = validateWorkflow(input);
  if (!res.ok) {
    const detail = res.issues.map((i) => `${i.stepId ? `[${i.stepId}] ` : ""}${i.field}: ${i.message}`).join("; ");
    throw new CairnError("E_VALIDATION", `Workflow definition is invalid: ${detail}`);
  }
  return res.workflow;
}

/** Resolution order for a workflow run: workflow defaults → environment values → run overrides. */
export function resolveVariables(wf: WorkflowDef, environment: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(wf.variables ?? {})) out[k] = String(v);
  for (const [k, v] of Object.entries(environment)) out[k] = v;
  for (const [k, v] of Object.entries(overrides)) out[k] = v;
  return out;
}

export type { StepDef };
