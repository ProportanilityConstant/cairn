# Security model

## Secrets
- Stored encrypted: AES-256-GCM, key = SHA-256(CAIRN_SECRET_KEY), random IV per record.
- API returns names only.
- `masker.scrub`/`redact` run over every log line, evidence payload, error
  detail, and report. Keys matching `(secret|password|token|api[-_]?key|authorization|cookie|session)`
  are masked; registered secret *values* are replaced in any string output.
- HTTP evidence omits `Authorization`/`Cookie` headers entirely.

## Execution safety
- Action classes: `read`, `safe_write`, `network`, `authenticated`, `destructive`.
  `destructive` requires explicit per-step or per-workflow `allow` — the engine
  refuses otherwise, regardless of what any AI proposed.
- `CAIRN_NETWORK_ALLOWLIST` restricts HTTP and browser destinations.
- Request caps bound runaway workflows.
- The expression evaluator has no eval, no property writes, no calls.

## Transport & access
- Optional bearer token (`CAIRN_API_TOKEN`) gates API and UI.
- Binds to `127.0.0.1` by default; Docker exposes `0.0.0.0` deliberately (you
  are expected to front it with your own TLS).
- The browser console never receives secrets; credential resolution happens
  server-side at run time.

## AI data flow
Provider requests contain: the intent text you typed, the failure record, and
evidence *previews* (first 300 chars, already masked). Full evidence never
leaves the server. With `CAIRN_AI_KIND=none|local`, nothing leaves the host.
