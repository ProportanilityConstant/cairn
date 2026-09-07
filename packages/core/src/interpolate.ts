import { CairnError } from "./errors.js";

/**
 * Template interpolation for step configs at run time.
 * Supported: {{vars.NAME}}, {{secrets.NAME}}, {{steps.STEP_ID.field[.path]}}
 * Unknown references are an error — silent empty strings hide bugs.
 */
const PATTERN = /\{\{\s*(vars|secrets|steps)\.([A-Za-z0-9_.]+?)\s*\}\}/g;

export interface InterpolationScope {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  steps: Record<string, Record<string, unknown>>;
  secretValues?: Set<string>;
}

export function interpolate(template: string, scope: InterpolationScope): string {
  return template.replace(PATTERN, (_m, ns: string, path: string) => {
    switch (ns) {
      case "vars": {
        if (!(path in scope.vars)) throw new CairnError("E_VALIDATION", `Unknown variable reference {{vars.${path}}}`, { hint: "Declare it in workflow variables or the environment." });
        return scope.vars[path] ?? "";
      }
      case "secrets": {
        if (!(path in scope.secrets)) throw new CairnError("E_VALIDATION", `Unknown secret reference {{secrets.${path}}}`, { hint: "Add it in Settings → Secrets." });
        return scope.secrets[path] ?? "";
      }
      case "steps": {
        const [stepId, ...rest] = path.split(".");
        const out = scope.steps[stepId ?? ""];
        if (!out) throw new CairnError("E_VALIDATION", `Reference to step "${stepId}" which has not produced output`, { hint: "Steps can only reference earlier steps." });
        let cur: unknown = out;
        for (const seg of rest) {
          if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[seg];
          else throw new CairnError("E_VALIDATION", `Step "${stepId}" has no output field "${rest.join(".")}"`);
        }
        return String(cur);
      }
      default:
        throw new CairnError("E_INTERNAL", `Unhandled namespace ${ns}`);
    }
  });
}

/** Deep-interpolate strings inside arbitrary JSON-ish values. */
export function interpolateDeep<T>(value: T, scope: InterpolationScope): T {
  if (typeof value === "string") return interpolate(value, scope) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, scope)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, scope)])) as unknown as T;
  }
  return value;
}
