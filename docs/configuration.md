# Configuration

All configuration is environment variables. See [.env.example](../.env.example)
for the annotated list.

| Variable | Default | Meaning |
|---|---|---|
| `CAIRN_SECRET_KEY` | *required* | Key material for the encrypted secret store. ≥16 chars. Generate: `openssl rand -base64 32` |
| `CAIRN_PORT` | `5175` | HTTP port |
| `CAIRN_HOST` | `127.0.0.1` | Bind address |
| `CAIRN_DATA_DIR` | `./data` | SQLite database location |
| `CAIRN_API_TOKEN` | unset | When set, requires `Authorization: Bearer <token>` on API routes |
| `CAIRN_AI_KIND` | `none` | `none` \| `local` \| `openai-compatible` \| `anthropic` |
| `CAIRN_AI_BASE_URL` | — | Required for `openai-compatible` |
| `CAIRN_AI_API_KEY` | — | Required for `anthropic`; optional for OpenAI-compatible |
| `CAIRN_AI_MODEL` | provider default | Model identifier |
| `CAIRN_AI_TIMEOUT_MS` | `60000` | Provider request timeout |
| `CAIRN_NETWORK_ALLOWLIST` | unset (allow all) | Comma-separated hosts; `*.example.com` wildcards supported |
| `CAIRN_MAX_NETWORK_REQUESTS` | `500` | Cap per execution |
| `CAIRN_BROWSER_HEADLESS` | `true` | Browser visibility |
| `CAIRN_LOG_LEVEL` | `info` | Fastify log level |
