import { z } from "zod";
import type { StepRunner } from "./types.js";

/**
 * Step kind registry. The executor owns runners; this module owns the
 * declarative contract: kind → action class + config schema. Registration is
 * explicit so the UI can enumerate kinds and the AI planner can only emit
 * kinds that actually exist.
 */

// ---------- shared pieces ----------
const templateSchema = z.string().max(8192);

const retryable = {
  retries: z.number().int().min(0).max(10).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
};

const httpHeaders = z.record(z.string().min(1).max(256), templateSchema).optional();

const assertionTarget = z.object({
  target: z.enum(["status", "latency_ms", "header", "body_text", "body_json", "body_length"]),
  /** Header name or dot path into the JSON body (e.g. "data.user.id"). */
  path: z.string().max(256).optional(),
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "matches", "exists"]),
  /** Comparison value. Ignored for "exists". Stringified at runtime. */
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

// ---------- http.request ----------
export const httpRequestConfig = z.object({
  url: z.string().min(1).max(2048),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
  headers: httpHeaders,
  query: z.record(z.string().min(1).max(256), templateSchema).optional(),
  /** Raw body. JSON objects are stringified for you. */
  body: z.union([z.string().max(1_048_576), z.record(z.string(), z.unknown())]).optional(),
  /** Named credential reference resolved from the secret store at run time. */
  authRef: z.string().max(128).optional(),
  authType: z.enum(["bearer", "basic"]).optional(),
  assertions: z.array(assertionTarget).max(32).optional(),
  maxRedirects: z.number().int().min(0).max(10).default(5),
});

// ---------- browser.* ----------
const browserBase = {
  /** Session id: steps sharing a session reuse one browser context, in order. */
  session: z.string().min(1).max(64).default("default"),
};
export const browserGotoConfig = z.object({ ...browserBase, url: z.string().min(1).max(2048), waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load") });
export const browserClickConfig = z.object({ ...browserBase, selector: z.string().min(1).max(512) });
export const browserFillConfig = z.object({ ...browserBase, selector: z.string().min(1).max(512), value: templateSchema, secretRef: z.string().max(128).optional() });
export const browserSelectConfig = z.object({ ...browserBase, selector: z.string().min(1).max(512), value: templateSchema });
export const browserWaitConfig = z.object({ ...browserBase, selector: z.string().min(1).max(512), state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"), timeoutMs: z.number().int().min(50).max(120_000).optional() });
export const browserAssertConfig = z.object({ ...browserBase, selector: z.string().min(1).max(512), state: z.enum(["visible", "hidden", "text"]) , text: z.string().max(2048).optional() });
export const browserScreenshotConfig = z.object({ ...browserBase, fullPage: z.boolean().default(false) });
export const browserConsoleConfig = z.object({ ...browserBase, level: z.enum(["info", "warning", "error"]).default("error") });

// ---------- misc ----------
export const assertStepConfig = z.object({
  /** Expression evaluated in the same sandbox as workflow conditions. */
  expr: z.string().min(1).max(2048),
  /** Human-facing phrasing used in reports. */
  expect: z.string().max(512).optional(),
});
export const delayConfig = z.object({ ms: z.number().int().min(1).max(60_000) });
export const noteConfig = z.object({ text: z.string().min(1).max(8192) });

export const stepKindSchemas: Record<string, z.ZodTypeAny> = {
  "http.request": httpRequestConfig,
  "browser.goto": browserGotoConfig,
  "browser.click": browserClickConfig,
  "browser.fill": browserFillConfig,
  "browser.select": browserSelectConfig,
  "browser.wait": browserWaitConfig,
  "browser.assert": browserAssertConfig,
  "browser.screenshot": browserScreenshotConfig,
  "browser.console": browserConsoleConfig,
  "assert": assertStepConfig,
  "delay": delayConfig,
  "note": noteConfig,
};

export const stepKinds = Object.keys(stepKindSchemas);

/** Declared action classes. Runners must match; the engine enforces the declaration. */
export const stepActionClasses: Record<string, import("./types.js").ActionClass> = {
  "http.request": "network",
  "browser.goto": "network",
  "browser.click": "safe_write",
  "browser.fill": "safe_write",
  "browser.select": "safe_write",
  "browser.wait": "read",
  "browser.assert": "read",
  "browser.screenshot": "read",
  "browser.console": "read",
  "assert": "read",
  "delay": "safe_write",
  "note": "safe_write",
};

export function isRegisteredKind(kind: string): boolean {
  return kind in stepKindSchemas;
}

export function validateStepConfig(kind: string, config: unknown): { ok: true; config: unknown } | { ok: false; issues: string[] } {
  const schema = stepKindSchemas[kind];
  if (!schema) return { ok: false, issues: [`Unknown step kind "${kind}". Registered kinds: ${stepKinds.join(", ")}`] };
  const parsed = schema.safeParse(config);
  if (parsed.success) return { ok: true, config: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}

export type { StepRunner };
