import { CairnError, evaluateExpression, type ActionClass, type RunContext, type StepRunner } from "@cairn/core";

export class AssertRunner implements StepRunner {
  readonly kind = "assert";
  readonly actionClass: ActionClass = "read";

  validate(config: unknown) {
    if (config && typeof config === "object" && "expr" in config && typeof (config as { expr: unknown }).expr === "string") return { ok: true as const };
    return { ok: false as const, issues: ["config.expr must be a string"] };
  }

  async run(config: unknown, ctx: RunContext): Promise<Record<string, unknown>> {
    const { expr, expect } = config as { expr: string; expect?: string };
    const scope = { vars: ctx.variables, steps: ctx.steps };
    let result: unknown;
    try {
      result = evaluateExpression(expr, scope);
    } catch (e) {
      throw new CairnError("E_VALIDATION", `Assertion expression failed to evaluate: ${e instanceof Error ? e.message : String(e)}`, { hint: "Conditions can reference vars.* and steps.<id>.* only." });
    }
    if (!result) {
      throw new CairnError("E_ASSERTION", `Assertion failed: ${expect ?? expr} — expression evaluated to false`, { detail: { expr } });
    }
    return { value: result };
  }
}

export class DelayRunner implements StepRunner {
  readonly kind = "delay";
  readonly actionClass: ActionClass = "safe_write";

  validate(config: unknown) {
    if (config && typeof config === "object" && "ms" in config && typeof (config as { ms: unknown }).ms === "number") return { ok: true as const };
    return { ok: false as const, issues: ["config.ms must be a number (1–60000)"] };
  }

  async run(config: unknown, ctx: RunContext): Promise<Record<string, unknown>> {
    const ms = (config as { ms: number }).ms;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      ctx.signal.addEventListener("abort", () => { clearTimeout(t); reject(new CairnError("E_CANCELLED", "Execution cancelled during delay")); }, { once: true });
    });
    return { waitedMs: ms };
  }
}

export class NoteRunner implements StepRunner {
  readonly kind = "note";
  readonly actionClass: ActionClass = "safe_write";

  validate(config: unknown) {
    if (config && typeof config === "object" && "text" in config && typeof (config as { text: unknown }).text === "string") return { ok: true as const };
    return { ok: false as const, issues: ["config.text must be a string"] };
  }

  async run(config: unknown, ctx: RunContext): Promise<Record<string, unknown>> {
    const text = (config as { text: string }).text;
    const id = ctx.emitEvidence({ type: "note", contentType: "text/plain", encoding: "utf8", data: text, label: "Note" });
    ctx.logger("info", `Note attached (${id})`);
    return { evidenceId: id };
  }
}
