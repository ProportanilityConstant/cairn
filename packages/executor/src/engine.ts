import {
  CairnError,
  createMasker,
  toCairnError,
  interpolateDeep,
  resolveVariables,
  validateStepConfig,
  type Evidence,
  type Execution,
  type ExecutionStatus,
  type FailureRecord,
  type PolicyConfig,
  type RunContext,
  type StepDef,
  type StepResult,
  type StepRunner,
  type WorkflowDef,
  compileCondition,
} from "@cairn/core";

export interface EvidenceSink {
  save(evidence: Evidence): Promise<void> | void;
}

export interface EngineOptions {
  runners: Record<string, StepRunner>;
  policy: PolicyConfig;
  /** Secret references resolved for this execution. Keys are credential names. */
  secrets: Record<string, string>;
  evidenceSink: EvidenceSink;
  /** Wall-clock limit for the whole execution. */
  globalTimeoutMs?: number;
  /** Called when an execution leaves the "running" state. */
  onExecutionFinished?: (execution: Execution) => void;
}

export interface RunOptions {
  executionId: string;
  projectId: string;
  workflowId: string;
  workflowName: string;
  environment: string;
  environmentVariables: Record<string, string>;
  variableOverrides?: Record<string, string>;
  trigger: Execution["trigger"];
  cancelSignal?: AbortSignal;
}

export interface RunOutput {
  execution: Execution;
  failures: FailureRecord[];
}

const MAX_ATTEMPTS_RETRIES = 10;

/**
 * Deterministic execution engine. It enforces policy *before* any runner
 * runs, times every step, retries with backoff, collects evidence, and never
 * leaves an execution stuck in "running" — every code path terminates in a
 * terminal status.
 */
export class ExecutionEngine {
  constructor(private readonly opts: EngineOptions) {}

  async run(wf: WorkflowDef, run: RunOptions): Promise<RunOutput> {
    const masker = createMasker(Object.values(this.opts.secrets));
    const startedAt = new Date().toISOString();
    const variables = resolveVariables(wf, run.environmentVariables, run.variableOverrides ?? {});
    // Secrets are addressable as {{secrets.NAME}}; expose them under a
    // reserved prefix so runners can fetch credentials without seeing the map.
    for (const [k, v] of Object.entries(this.opts.secrets)) variables[`__secret:${k}`] = v;

    const execution: Execution = {
      id: run.executionId,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      workflowVersion: wf.version,
      projectId: run.projectId,
      environment: run.environment,
      trigger: run.trigger,
      status: "preparing",
      startedAt,
      variables: {},
      steps: wf.steps.map((s) => ({
        stepId: s.id,
        name: s.name,
        kind: s.kind,
        status: "pending",
        attempts: 0,
        evidenceIds: [],
      })),
    };
    // Never persist resolved secrets or raw variables that may embed them.
    execution.variables = masker.scrub(Object.fromEntries(Object.entries(variables).filter(([k]) => !k.startsWith("__secret:"))));

    const abort = new AbortController();
    const onExternalCancel = () => abort.abort(new CairnError("E_CANCELLED", "Execution cancelled by user"));
    run.cancelSignal?.addEventListener("abort", onExternalCancel, { once: true });
    const globalTimer = this.opts.globalTimeoutMs
      ? setTimeout(() => abort.abort(new CairnError("E_TIMEOUT", `Execution exceeded its global time limit of ${this.opts.globalTimeoutMs}ms`)), this.opts.globalTimeoutMs)
      : undefined;

    const failures: FailureRecord[] = [];
    const stepOutputs: Record<string, Record<string, unknown>> = {};
    const evidenceToPersist: Evidence[] = [];
    let requestCount = 0;

    try {
      execution.status = "running";

      for (let i = 0; i < wf.steps.length; i++) {
        const step = wf.steps[i]!;
        const result = execution.steps[i]!;
        if (execution.status === "cancelled" || execution.status === "timed_out") { result.status = "cancelled"; continue; }
        if (abort.signal.aborted) {
          execution.status = toTerminal(execution.status, abort.signal);
          result.status = "cancelled";
          continue;
        }

        // Condition gate.
        if (step.condition !== undefined) {
          try {
            const cond = compileCondition(step.condition);
            const scope = { vars: variables, steps: stepOutputs };
            if (!cond(scope)) {
              result.status = "skipped";
              result.skippedReason = `Condition not met: ${step.condition}`;
              continue;
            }
          } catch (e) {
            // Condition compiled at save time but references runtime data oddly; fail the step cleanly.
            result.status = "failed";
            result.attempts = 1;
            result.error = { code: "E_VALIDATION", message: `Condition could not be evaluated: ${e instanceof Error ? e.message : String(e)}` };
            execution.status = "failed";
            failures.push({ stepId: step.id, code: "E_VALIDATION", message: result.error.message });
            if (step.onFailure !== "continue") break;
            continue;
          }
        }

        // Policy gate — enforced here, independent of any AI involvement.
        const runner = this.opts.runners[step.kind];
        if (!runner) {
          result.status = "failed";
          result.attempts = 1;
          result.error = { code: "E_VALIDATION", message: `No runner registered for step kind "${step.kind}"` };
          execution.status = "failed";
          failures.push({ stepId: step.id, code: "E_VALIDATION", message: result.error.message });
          if (step.onFailure !== "continue") break;
          continue;
        }
        const policyError = checkPolicy(step, runner.actionClass, wf.allowExplicit === true, this.opts.policy);
        if (policyError) {
          result.status = "failed";
          result.attempts = 1;
          result.error = { code: "E_POLICY", message: policyError };
          execution.status = "failed";
          failures.push({ stepId: step.id, code: "E_POLICY", message: policyError });
          if (step.onFailure !== "continue") break;
          continue;
        }

        // Interpolate + revalidate the config with resolved values.
        let config: unknown;
        try {
          const scope = { vars: variables, secrets: this.opts.secrets, steps: stepOutputs };
          config = interpolateDeep(step.config, scope);
          const revalidated = validateStepConfig(step.kind, config);
          if (!revalidated.ok) {
            throw new CairnError("E_STEP_VALIDATION", `Step config is invalid after interpolation: ${revalidated.issues.join("; ")}`);
          }
          config = revalidated.config;
        } catch (e) {
          const err = toCairnError(e);
          result.status = "failed";
          result.attempts = 1;
          result.startedAt = new Date().toISOString();
          result.error = err instanceof CairnError
            ? { code: err.code, message: err.message, hint: err.hint }
            : { code: "E_INTERNAL", message: String(e) };
          execution.status = "failed";
          failures.push({ stepId: step.id, code: result.error.code, message: result.error.message, hint: result.error.hint });
          if (step.onFailure !== "continue") break;
          continue;
        }

        // Run with retries.
        const maxAttempts = 1 + Math.min(step.retries ?? 0, MAX_ATTEMPTS_RETRIES);
        const timeoutMs = step.timeoutMs ?? 60_000;
        result.status = "running";
        result.startedAt = new Date().toISOString();

        let lastError: { code: string; message: string; hint?: string; detail?: unknown } | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (abort.signal.aborted) break;
          result.attempts = attempt;
          const stepAbort = new AbortController();
          const stepTimer = setTimeout(
            () => stepAbort.abort(new CairnError("E_TIMEOUT", `Step timed out after ${timeoutMs}ms while running "${step.name}"`, { hint: "Raise the step timeout or investigate the target system." })),
            timeoutMs
          );
          const forwardCancel = () => stepAbort.abort(new CairnError("E_CANCELLED", "Execution cancelled by user"));
          abort.signal.addEventListener("abort", forwardCancel, { once: true });
          const ctx: RunContext = {
            executionId: run.executionId,
            projectId: run.projectId,
            environment: run.environment,
            variables,
            steps: stepOutputs,
            signal: stepAbort.signal,
            logger: (level, message) => {
              evidenceToPersist.push({
                id: `${run.executionId}_log_${i}_${attempt}_${evidenceToPersist.length}`,
                executionId: run.executionId,
                stepId: step.id,
                type: "log",
                contentType: "text/plain",
                encoding: "utf8",
                data: `[${level}] ${message}`,
                createdAt: new Date().toISOString(),
              });
            },
            emitEvidence: (partial) => {
              const id = `${run.executionId}_ev_${i}_${attempt}_${evidenceToPersist.length}`;
              evidenceToPersist.push({
                ...partial,
                id,
                executionId: run.executionId,
                stepId: step.id,
                createdAt: new Date().toISOString(),
              });
              result.evidenceIds.push(id);
              return id;
            },
          };

          try {
            const output = await runner.run(config, {
              ...ctx,
              // HTTP runner counts requests against the policy cap.
            });
            if (runner === this.opts.runners["http.request"]) {
              requestCount++;
              if (requestCount > this.opts.policy.maxNetworkRequests) {
                throw new CairnError("E_POLICY", `Network request cap of ${this.opts.policy.maxNetworkRequests} exceeded in this execution`);
              }
            }
            result.output = output;
            result.status = "passed";
            stepOutputs[step.id] = output;
            lastError = null;
            break;
          } catch (e) {
            clearTimeout(stepTimer);
            abort.signal.removeEventListener("abort", forwardCancel);
            const err = e instanceof CairnError ? e : new CairnError("E_INTERNAL", e instanceof Error ? e.message : String(e));
            lastError = { code: err.code, message: err.message, hint: err.hint, detail: masker.scrub(err.detail) };
            if (err.code === "E_CANCELLED") { abort.abort(err); break; }
            if (attempt < maxAttempts) await sleep(Math.min(250 * attempt, 2000), abort.signal);
          }
          clearTimeout(stepTimer);
          abort.signal.removeEventListener("abort", forwardCancel);
        }

        if (lastError) {
          result.status = abort.signal.aborted && lastError.code !== "E_TIMEOUT" ? "cancelled" : "failed";
          result.finishedAt = new Date().toISOString();
          result.durationMs = Date.now() - Date.parse(result.startedAt);
          result.error = { code: lastError.code, message: lastError.message, hint: lastError.hint };
          const assertion = extractAssertion(lastError.detail);
          failures.push({
            stepId: step.id,
            code: lastError.code,
            message: lastError.message,
            hint: lastError.hint,
            ...(assertion ? { assertion } : {}),
          });
          execution.status = result.status === "cancelled" ? "cancelled" : "failed";
          if (step.onFailure !== "continue") break;
        } else if (result.status !== "passed") {
          result.status = abort.signal.aborted ? "cancelled" : result.status;
          execution.status = abort.signal.aborted ? toTerminal(execution.status, abort.signal) : execution.status;
        } else {
          result.finishedAt = new Date().toISOString();
          result.durationMs = Date.now() - Date.parse(result.startedAt);
        }
      }

      if (execution.status === "running") execution.status = "passed";
    } finally {
      clearTimeout(globalTimer);
      run.cancelSignal?.removeEventListener("abort", onExternalCancel);
      // Dispose browser sessions and persist evidence even on crash paths.
      for (const r of Object.values(this.opts.runners)) {
        if ("dispose" in r && typeof (r as { dispose?: unknown }).dispose === "function") {
          await (r as { dispose: () => Promise<void> }).dispose();
        }
      }
      for (const ev of evidenceToPersist) {
        ev.data = masker.redact(ev.data);
        await this.opts.evidenceSink.save(ev);
      }
      execution.finishedAt = new Date().toISOString();
      execution.durationMs = Date.now() - Date.parse(execution.startedAt);
      if (execution.status === "running") execution.status = "failed";
      this.opts.onExecutionFinished?.(execution);
    }

    return { execution, failures };
  }
}

function toTerminal(current: ExecutionStatus, signal: AbortSignal): ExecutionStatus {
  if (current === "cancelled" || current === "timed_out" || current === "passed" || current === "failed") return current;
  const reason = signal.reason;
  return reason instanceof CairnError && reason.code === "E_TIMEOUT" ? "timed_out" : "cancelled";
}

function checkPolicy(step: StepDef, actionClass: import("@cairn/core").ActionClass, workflowAllows: boolean, policy: PolicyConfig): string | null {
  if (policy.requireExplicitAllow.includes(actionClass)) {
    const allowed = step.allow?.includes(actionClass) || workflowAllows;
    if (!allowed) {
      return `Step "${step.id}" uses action class "${actionClass}" which requires explicit authorization. Add "${actionClass}" to the step's allow list or enable allowExplicit on the workflow.`;
    }
  }
  return null;
}

function extractAssertion(detail: unknown): FailureRecord["assertion"] {
  if (detail && typeof detail === "object" && "target" in detail && "op" in detail && "expected" in detail) {
    const d = detail as { target: string; op: string; expected: string; observed: string; message?: string };
    return { target: d.target, op: d.op, expected: d.expected, observed: d.observed, message: d.message ?? `${d.target} ${d.op}` };
  }
  return undefined;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
