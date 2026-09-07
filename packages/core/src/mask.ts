/**
 * Secret masking. A single choke point: every log line, report, evidence
 * payload and API response passes through `redact` before leaving the process.
 */
export interface Masker {
  /** Replace known secret values with a stable mask. */
  redact(text: string): string;
  /** Deep-copy a value, masking secret-bearing keys and known values. */
  scrub<T>(value: T): T;
}

const SECRET_KEY_PATTERN = /(secret|password|passwd|token|api[-_]?key|authorization|cookie|set-cookie|session)/i;
const MASK = "••••••••";

export function createMasker(secretValues: Iterable<string>): Masker {
  const values = [...secretValues].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);

  function redact(text: string): string {
    let out = text;
    for (const v of values) {
      out = out.split(v).join(MASK);
    }
    return out;
  }

  function scrubKey(key: string, value: unknown): unknown {
    if (SECRET_KEY_PATTERN.test(key) && typeof value === "string" && value.length > 0) {
      return MASK;
    }
    return scrubAny(value);
  }

  function scrubAny(value: unknown): unknown {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map((v) => scrubAny(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubKey(k, v)]));
    }
    return value;
  }

  return {
    redact,
    scrub: scrubAny as <T>(value: T) => T,
  };
}

/** Masker used when no secrets are registered — still scrubs secret-named keys. */
export const defaultMasker = createMasker([]);
