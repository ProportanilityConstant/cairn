import { CairnError } from "@cairn/core";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Optional bearer token guarding the API and static UI. */
  apiToken?: string;
  secretKey: string;
  /** AI provider, assembled from env or settings (settings wins). */
  ai: AIEnvConfig;
  policy: {
    networkAllowlist: string[];
    maxNetworkRequests: number;
  };
  browserHeadless: boolean;
  logLevel: string;
}

export interface AIEnvConfig {
  kind: "none" | "openai-compatible" | "anthropic" | "local";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const secretKey = env.CAIRN_SECRET_KEY;
  if (!secretKey || secretKey.length < 16) {
    throw new CairnError("E_CONFIG", "CAIRN_SECRET_KEY is not set (or is shorter than 16 characters)", {
      hint: "Generate one with: openssl rand -base64 32 — it encrypts stored secrets. Keep it stable across restarts.",
    });
  }
  const kind = (env.CAIRN_AI_KIND ?? "none") as AIEnvConfig["kind"];
  if (!["none", "openai-compatible", "anthropic", "local"].includes(kind)) {
    throw new CairnError("E_CONFIG", `CAIRN_AI_KIND must be one of none | openai-compatible | anthropic | local, got "${kind}"`);
  }
  if (kind === "openai-compatible" && !env.CAIRN_AI_BASE_URL) {
    throw new CairnError("E_CONFIG", "CAIRN_AI_BASE_URL is required when CAIRN_AI_KIND=openai-compatible", { hint: "Example: http://localhost:11434/v1 for Ollama's OpenAI adapter." });
  }
  if (kind === "anthropic" && !env.CAIRN_AI_API_KEY) {
    throw new CairnError("E_CONFIG", "CAIRN_AI_API_KEY is required when CAIRN_AI_KIND=anthropic");
  }
  return {
    port: intEnv(env.CAIRN_PORT, 5175),
    host: env.CAIRN_HOST ?? "127.0.0.1",
    dataDir: env.CAIRN_DATA_DIR ?? "./data",
    apiToken: env.CAIRN_API_TOKEN || undefined,
    secretKey,
    ai: {
      kind,
      baseUrl: env.CAIRN_AI_BASE_URL,
      apiKey: env.CAIRN_AI_API_KEY,
      model: env.CAIRN_AI_MODEL ?? (kind === "anthropic" ? "claude-sonnet-4-5" : undefined),
      timeoutMs: intEnv(env.CAIRN_AI_TIMEOUT_MS, 60_000),
    },
    policy: {
      networkAllowlist: (env.CAIRN_NETWORK_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      maxNetworkRequests: intEnv(env.CAIRN_MAX_NETWORK_REQUESTS, 500),
    },
    browserHeadless: env.CAIRN_BROWSER_HEADLESS !== "false",
    logLevel: env.CAIRN_LOG_LEVEL ?? "info",
  };
}

function intEnv(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new CairnError("E_CONFIG", `Expected a non-negative integer, got "${v}"`);
  return n;
}
