/**
 * Cairn error taxonomy. Every error is actionable: it carries a stable code,
 * a human message, and optional structured detail. User-facing surfaces render
 * these directly — "Something went wrong" is a bug, not an error message.
 */
export type CairnErrorCode =
  | "E_CONFIG"            // invalid configuration
  | "E_VALIDATION"        // invalid user input / workflow definition
  | "E_STEP_VALIDATION"   // step config failed schema validation
  | "E_POLICY"            // action blocked by the security policy
  | "E_TIMEOUT"
  | "E_CANCELLED"
  | "E_ASSERTION"         // an assertion failed (expected behavior not observed)
  | "E_HTTP"              // transport-level HTTP failure (DNS, refused, TLS)
  | "E_BROWSER"           // browser launch/automation failure
  | "E_AI_PROVIDER"       // provider unreachable, bad key, rate limit
  | "E_AI_SCHEMA"         // provider returned output that failed schema validation
  | "E_NOT_FOUND"
  | "E_UNAUTHORIZED"
  | "E_CONFLICT"
  | "E_INTERNAL";

export class CairnError extends Error {
  readonly code: CairnErrorCode;
  readonly detail?: unknown;
  readonly hint?: string;

  constructor(code: CairnErrorCode, message: string, opts?: { detail?: unknown; hint?: string }) {
    super(message);
    this.name = "CairnError";
    this.code = code;
    this.detail = opts?.detail;
    this.hint = opts?.hint;
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail, hint: this.hint };
  }
}

export function isCairnError(e: unknown): e is CairnError {
  return e instanceof CairnError;
}

/** Normalize anything thrown into a CairnError without losing information. */
export function toCairnError(e: unknown): CairnError {
  if (isCairnError(e)) return e;
  if (e instanceof Error) return new CairnError("E_INTERNAL", e.message, { detail: { name: e.name } });
  return new CairnError("E_INTERNAL", String(e));
}
