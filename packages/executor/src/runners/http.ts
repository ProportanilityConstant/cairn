import { CairnError, domainAllowed, httpRequestConfig, type ActionClass, type RunContext, type StepRunner, type AssertionFailure } from "@cairn/core";

type ParsedHttp = import("zod").infer<typeof httpRequestConfig>;
type ParsedAssertion = NonNullable<ParsedHttp["assertions"]>[number];

export class HttpRunner implements StepRunner {
  readonly kind = "http.request";
  readonly actionClass: ActionClass = "network";

  constructor(
    private readonly opts: {
      networkAllowlist?: string[];
      maxNetworkRequests: number;
      onRequest?: () => void;
    }
  ) {}

  validate(config: unknown) {
    const res = httpRequestConfig.safeParse(config);
    return res.success ? { ok: true as const } : { ok: false as const, issues: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }

  async run(rawConfig: unknown, ctx: RunContext): Promise<Record<string, unknown>> {
    const parsed = httpRequestConfig.parse(rawConfig);
    if (!domainAllowed(this.opts.networkAllowlist, parsed.url)) {
      throw new CairnError("E_POLICY", `Blocked request to ${parsed.url}: host is not in the network allowlist`, { hint: "Add the host under Settings → Policy, or set NETWORK_ALLOWLIST." });
    }
    if (this.opts.onRequest) this.opts.onRequest();

    const url = new URL(parsed.url);
    for (const [k, v] of Object.entries(parsed.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = { ...parsed.headers };
    let body: string | undefined;
    if (parsed.body !== undefined) {
      if (typeof parsed.body === "string") {
        body = parsed.body;
        headers["Content-Type"] ??= "text/plain";
      } else {
        body = JSON.stringify(parsed.body);
        headers["Content-Type"] ??= "application/json";
      }
    }
    if (parsed.authRef) {
      const secret = ctx.variables[`__secret:${parsed.authRef}`];
      if (!secret) {
        throw new CairnError("E_VALIDATION", `Credential "${parsed.authRef}" is not available in this environment`, { hint: "Add it under Settings → Secrets and enable it for the target environment." });
      }
      headers["Authorization"] = parsed.authType === "basic" ? `Basic ${Buffer.from(secret).toString("base64")}` : `Bearer ${secret}`;
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: parsed.method,
        headers,
        body: parsed.method === "GET" || parsed.method === "HEAD" ? undefined : body,
        redirect: parsed.maxRedirects > 0 ? "follow" : "manual",
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal.aborted) {
        const reason = (ctx.signal as { reason?: unknown }).reason;
        if (reason instanceof CairnError) throw reason;
        throw new CairnError("E_CANCELLED", "Execution was cancelled while the request was in flight");
      }
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new CairnError("E_TIMEOUT", `Request to ${parsed.url} timed out. Verify the target is reachable or raise the step timeout.`, { detail: { url: parsed.url } });
      }
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new CairnError("E_HTTP", `Request to ${parsed.url} failed before a response was received (${msg})`, { hint: "Check DNS, connectivity, TLS, and that the target service is running." });
  }

    const responseText = await res.text();
    const latencyMs = Date.now() - started;

    // Evidence: the full exchange, minus credentials.
    const exchange = {
      request: {
        method: parsed.method,
        url: url.toString(),
        headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !/authorization|cookie/i.test(k))),
        body: body === undefined ? null : body.slice(0, 64 * 1024),
      },
      response: {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: responseText.slice(0, 64 * 1024),
      },
      latency_ms: latencyMs,
    };
    ctx.emitEvidence({ type: "http_exchange", contentType: "application/json", encoding: "utf8", data: JSON.stringify(exchange, null, 2), label: `${parsed.method} ${url.pathname} → ${res.status}` });

    // Assertions. Each failure is structured: expected vs observed.
    if (parsed.assertions) {
      for (const a of parsed.assertions) {
        const observed = extractObservable(a, res, responseText, latencyMs);
        const failure = checkAssertion(a, observed);
        if (failure) {
          throw new CairnError("E_ASSERTION", failure.message, {
            detail: {
              ...failure,
              response: { status: res.status, latency_ms: latencyMs, body_preview: responseText.slice(0, 2048) },
            },
          });
        }
      }
    }

    let json: unknown;
    try { json = responseText.length > 0 ? JSON.parse(responseText) : undefined; } catch { json = undefined; }

    return {
      status: res.status,
      latency_ms: latencyMs,
      contentType: res.headers.get("content-type") ?? "",
      body: json ?? responseText,
      bodyText: responseText.slice(0, 64 * 1024),
    };
  }
}

function extractObservable(a: ParsedAssertion, res: Response, bodyText: string, latencyMs: number): string | number | boolean | undefined {
  switch (a.target) {
    case "status": return res.status;
    case "latency_ms": return latencyMs;
    case "header": return a.path ? res.headers.get(a.path) ?? undefined : undefined;
    case "body_length": return bodyText.length;
    case "body_text": return bodyText;
    case "body_json": {
      let json: unknown;
      try { json = JSON.parse(bodyText); } catch { return undefined; }
      if (!a.path) return JSON.stringify(json);
      let cur: unknown = json;
      for (const seg of a.path.split(".")) {
        if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[seg];
        else return undefined;
      }
      return typeof cur === "object" ? JSON.stringify(cur) : (cur as string | number | boolean | undefined);
    }
  }
}

function checkAssertion(a: ParsedAssertion, observed: string | number | boolean | undefined): AssertionFailure | null {
  const fmt = (v: unknown) => (v === undefined ? "(missing)" : String(v));
  const expected = a.value;
  const pass = (() => {
    switch (a.op) {
      case "exists": return observed !== undefined && observed !== "";
      case "eq": return observed === expected;
      case "ne": return observed !== expected;
      case "gt": return typeof observed === "number" && typeof expected === "number" && observed > expected;
      case "gte": return typeof observed === "number" && typeof expected === "number" && observed >= expected;
      case "lt": return typeof observed === "number" && typeof expected === "number" && observed < expected;
      case "lte": return typeof observed === "number" && typeof expected === "number" && observed <= expected;
      case "contains": return String(observed).includes(String(expected));
      case "matches": return expected !== undefined && new RegExp(String(expected)).test(String(observed));
    }
  })();
  if (pass) return null;
  const where = a.target === "header" || a.target === "body_json" ? `${a.target}.${a.path ?? "*"}` : a.target;
  return {
    target: where,
    op: a.op,
    expected: a.op === "exists" ? "a value" : fmt(expected),
    observed: fmt(observed),
    message: `Assertion failed: ${where} ${a.op} ${a.op === "exists" ? "" : fmt(expected)} — observed ${fmt(observed)}`,
  };

}
