import { z } from "zod";
import { CairnError } from "@cairn/core";

/**
 * Provider-agnostic AI layer.
 *
 * Rules the whole package enforces:
 * 1. Raw LLM output is never trusted. Every completion goes through a zod
 *    schema before callers see it.
 * 2. Providers are configured, never hard-coded. Nothing ships a default
 *    endpoint; with no provider configured, AI features state that clearly.
 * 3. The local "heuristic" provider is deterministic and rule-based. It is
 *    labeled as such everywhere it appears, and its analyses are hypotheses
 *    with explicit confidence — never presented as model output.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  /** Hard cap; providers must respect it. */
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResponse {
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/** Validate a completion against a schema, with one repair round-trip. */
export async function completeStructured<T extends z.ZodTypeAny>(
  provider: AIProvider,
  req: CompletionRequest,
  schema: T,
  schemaHint: string
): Promise<{ data: z.infer<T>; raw: string }> {
  const res = await provider.complete({
    ...req,
    system: `${req.system}\n\nRespond with a single JSON object and nothing else. It must match this shape:\n${schemaHint}`,
  });
  const first = tryParse(res.text);
  if (first) {
    const parsed = schema.safeParse(first);
    if (parsed.success) return { data: parsed.data, raw: res.text };
  }
  // One repair round-trip with the validation errors attached.
  const errors = first ? "JSON did not match the required schema." : "Response was not valid JSON.";
  const repair = await provider.complete({
    ...req,
    system: `${req.system}\n\nRespond with a single JSON object and nothing else. It must match this shape:\n${schemaHint}`,
    user: `${req.user}\n\nYour previous response had a problem: ${errors} Return a corrected JSON object.`,
  });
  const second = tryParse(repair.text);
  const parsed2 = second ? schema.safeParse(second) : { success: false as const };
  if (parsed2.success) return { data: parsed2.data, raw: repair.text };
  throw new CairnError("E_AI_SCHEMA", `${provider.id} returned output that failed schema validation after one repair attempt`, {
    hint: "Try a different model or lower temperature. Raw output is logged at debug level.",
    detail: { provider: provider.id, model: provider.model },
  });
}

function tryParse(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

// ---------- structured outputs ----------

export const planDraftSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  variables: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(256) })).max(20).default([]),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_]+$/).min(1).max(64),
    name: z.string().min(1).max(128),
    kind: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown()),
    /** Free-text rationale. Kept out of the executed definition; surfaced in the UI. */
    rationale: z.string().max(2048).optional(),
  })).min(1).max(50),
});
export type PlanDraft = z.infer<typeof planDraftSchema>;

export const failureAnalysisSchema = z.object({
  summary: z.string().min(1).max(1024),
  likelyCause: z.string().min(1).max(2048),
  suggestedInvestigation: z.array(z.string().min(1).max(512)).max(8),
  confidence: z.enum(["low", "medium", "high"]),
});
export type FailureAnalysis = z.infer<typeof failureAnalysisSchema>;
