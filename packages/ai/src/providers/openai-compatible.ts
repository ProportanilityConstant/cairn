import { CairnError } from "@cairn/core";
import { type AIProvider, type CompletionRequest, type CompletionResponse } from "../provider.js";

/**
 * Any OpenAI-compatible /v1/chat/completions endpoint: OpenAI, Azure,
 * OpenRouter, Together, vLLM, Ollama (openai adapter), LM Studio. The base
 * URL and key come from configuration — never defaults.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  constructor(
    private readonly opts: { baseUrl: string; apiKey?: string; model: string; name?: string; timeoutMs?: number }
  ) {
    if (!opts.baseUrl.startsWith("http")) {
      throw new CairnError("E_CONFIG", `AI base URL must be an http(s) URL, got "${opts.baseUrl}"`);
    }
    this.id = opts.name ?? "openai-compatible";
  }
  get model() { return this.opts.model; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          max_tokens: req.maxTokens ?? 2048,
          temperature: req.temperature ?? 0.2,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new CairnError("E_AI_PROVIDER", `AI provider "${this.id}" timed out after ${this.opts.timeoutMs ?? 60_000}ms`, { hint: "Check the provider endpoint or raise AI_TIMEOUT_MS." });
      }
      throw new CairnError("E_AI_PROVIDER", `AI provider "${this.id}" is unreachable: ${e instanceof Error ? e.message : String(e)}`, { hint: "Verify the base URL and that the service is running." });
    }
    if (res.status === 401 || res.status === 403) {
      throw new CairnError("E_AI_PROVIDER", `AI provider "${this.id}" rejected the credentials (HTTP ${res.status})`, { hint: "Check the configured API key." });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CairnError("E_AI_PROVIDER", `AI provider "${this.id}" returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new CairnError("E_AI_SCHEMA", `AI provider "${this.id}" returned an unexpected response shape`, { detail: { keys: Object.keys(json) } });
    }
    return {
      text,
      provider: this.id,
      model: this.opts.model,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }
}
