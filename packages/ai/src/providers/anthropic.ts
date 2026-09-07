import { CairnError } from "@cairn/core";
import { type AIProvider, type CompletionRequest, type CompletionResponse } from "../provider.js";

/** Anthropic Messages API provider. */
export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  constructor(private readonly opts: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }) {}
  get model() { return this.opts.model; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let res: Response;
    try {
      res = await fetch(`${(this.opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: req.maxTokens ?? 2048,
          temperature: req.temperature ?? 0.2,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new CairnError("E_AI_PROVIDER", `Anthropic timed out after ${this.opts.timeoutMs ?? 60_000}ms`);
      }
      throw new CairnError("E_AI_PROVIDER", `Anthropic is unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CairnError("E_AI_PROVIDER", `Anthropic returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = json.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
    if (!text) throw new CairnError("E_AI_SCHEMA", "Anthropic returned an empty response");
    return { text, provider: this.id, model: this.opts.model, usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens } };
  }
}
