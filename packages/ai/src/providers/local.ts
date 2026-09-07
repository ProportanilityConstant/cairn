import { type AIProvider, type CompletionRequest, type CompletionResponse } from "../provider.js";

/**
 * Deterministic offline provider. It does not call a model and does not
 * pretend to: id "local-heuristic" is surfaced in every result it produces.
 *
 * It supports the structured flows the platform needs offline:
 * - Planner: emits a sensible template workflow for common intents.
 * - Failure analyzer: rule-based hypotheses derived from failure codes.
 */
export class LocalHeuristicProvider implements AIProvider {
  readonly id = "local-heuristic";
  readonly model = "rules-v1";

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // The caller (planner/analyzer) recognizes this provider and bypasses
    // prompt-based generation entirely; this path exists only so the
    // interface stays uniform for diagnostics.
    return { text: "{}", provider: this.id, model: this.model };
  }
}
