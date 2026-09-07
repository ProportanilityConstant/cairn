<p align="center">
  <img src="assets/logo/cairn-logo.svg" alt="Cairn" width="260" />
</p>

<p align="center">
  <strong>Evidence-first automation and QA.</strong><br/>
  AI plans. A deterministic engine executes. Evidence proves what happened.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#demo-in-five-minutes">Demo</a> ·
  <a href="#the-ai-layer">AI layer</a> ·
  <a href="#security--privacy">Privacy</a> ·
  <a href="docs/">Docs</a>
</p>

---

**Cairn** is a self-hosted platform that turns natural-language intent and hand-built workflows into *reliable, observable, repeatable* automation. It tests APIs and web applications, captures evidence for every step, and analyzes failures — with a strict boundary between what the machine observed and what an AI *thinks* happened.

A cairn is a stack of stones that marks a verified path across uncertain terrain. That's the product philosophy: every execution leaves evidence a human can inspect, every claim is checkable, and nothing is fake.

```text
Intent ──▶ Planner ──▶ Validation ──▶ Workflow graph ──▶ Execution engine
                                                              │
                                              ┌───────────────┼───────────────┐
                                              ▼               ▼               ▼
                                          HTTP steps     Browser steps    Assertions
                                              └───────────────┼───────────────┘
                                                              ▼
                                                    Evidence collector
                                                              ▼
                                                 Failure intelligence
                                                              ▼
                                              Reports · timelines · console
```

## Why Cairn exists

Most "AI automation" tools share one flaw: they trust the model. Cairn takes the opposite position:

- **Deterministic core.** The engine is plain, boring, testable code. AI is a layer that *proposes*; it never executes directly.
- **Schema-validated everything.** An LLM's plan goes through the same validation as a hand-written workflow — invalid steps are dropped, never guessed. Its failure analysis is labeled a *hypothesis* with a confidence level, next to the observed facts.
- **Evidence over assertions.** A failed step ships with the full HTTP exchange, the response body, screenshots, and console logs — not just "test failed".
- **Self-hosted and honest.** No telemetry, no accounts, no data leaving your machine unless *you* configure a provider. The offline "local" AI mode is rule-based and labeled as such everywhere.

## Features

- **API testing** — REST steps with assertions on status, headers, JSON paths, latency; chained outputs via `{{steps.id.field}}`; bearer/basic auth from the encrypted secret store.
- **Browser testing** — Playwright-backed navigation, interaction, DOM assertions, and screenshots (optional install; the core has zero browser dependencies).
- **Workflow engine** — declarative step graphs with conditions, retries, per-step timeouts, and a documented JSON format that versions automatically.
- **Evidence system** — HTTP exchanges, screenshots, console logs, and notes, all attached to steps and viewable in the console.
- **Failure intelligence** — structured expected/observed records, plus AI hypotheses (provider-configurable) that are explicitly separated from facts.
- **Web console** — dashboards computed from real data, a workflow editor, live execution timelines, and a hypothesis panel that never pretends to be sure.
- **Privacy by architecture** — encrypted secrets at rest (AES-256-GCM), mandatory masking of secret-named keys in logs and evidence, an outbound host allowlist, and a policy engine the AI cannot bypass.

## Quick start

Requirements: Node ≥ 22.5 (or Bun ≥ 1.1), npm.

```bash
git clone https://github.com/YOUR_ORG/cairn.git
cd cairn
npm install

# 1. Secret key for the encrypted store (generate once, keep stable)
echo "CAIRN_SECRET_KEY=$(openssl rand -base64 32)" > .env

# 2. Build
npm run build

# 3. Run
npm run start          # server + console on http://127.0.0.1:5175
```

Open the console, create a project, and either click **Blank workflow** or describe what you want tested and let the planner draft it. Run it, watch the timeline, inspect the evidence.

**New here? Read [docs/user-guide.md](docs/user-guide.md)** — a complete walkthrough from install to failure intelligence, with a troubleshooting table for every error the product can emit. The in-app **Guide** page covers the same ground from inside the console.

### Docker

```bash
cp .env.example .env   # set CAIRN_SECRET_KEY
docker compose up -d   # http://127.0.0.1:5175, data persisted in a volume
```

## Demo in five minutes

```bash
# Terminal 1 — the demo target
node examples/demo-app/server.mjs

# Terminal 2 — Cairn
npm run start
```

1. Create a project → **Draft with AI**: *"Check that GET /ping returns 200 with status healthy, create an order for 1 cairn-stone, and verify it appears in /orders"* (or import `examples/demo-app/demo-workflow.json`).
2. Run it — it passes, with a full HTTP exchange captured per step.
3. Now visit `http://127.0.0.1:5175` target's `/chaos` endpoint to degrade the service, and run the workflow again.
4. The execution fails with a structured expected/observed record. Click **Analyze failure** — the local analyzer explains the likely cause and suggests investigation, with an honest confidence rating.
5. Hit `/heal` and re-run. Green again.

That loop — run, fail, understand, fix, verify — is the product.

## How it works

| Package | Responsibility |
|---|---|
| `@cairn/core` | Domain types, workflow validation, the safe expression evaluator, the action-policy engine, secret masking |
| `@cairn/executor` | The execution engine: retries, timeouts, cancellation, evidence collection; HTTP and Playwright runners |
| `@cairn/ai` | Provider-agnostic planner, schema-validated completions, failure analysis, deterministic local mode |
| `@cairn/server` | Fastify API, SQLite persistence, encrypted secret store, execution queue, console hosting |
| `@cairn/web` | React console: dashboard, editor, execution timelines, evidence viewer |

**Execution lifecycle.** Every run gets an ID and moves through `queued → preparing → running → passed | failed | cancelled | timed_out`. The engine persists a queued row *before* starting, so a client can always poll, and guarantees a terminal status on every path — including crashes, provider outages, and browser failure.

**Safety model.** Each step kind declares an action class (`read`, `safe_write`, `network`, `authenticated`, `destructive`). Classes that need authorization are refused unless the workflow explicitly allows them — enforced by the engine, not the AI. Outbound automation can be locked to a host allowlist. Secrets live encrypted in SQLite, are referenced as `{{secrets.NAME}}`, and every value is masked at the single choke point all output passes through.

## The AI layer

Bring your own provider. Nothing is hard-coded; nothing is sent anywhere you didn't configure:

```bash
# OpenAI-compatible endpoints: OpenAI, Ollama, vLLM, OpenRouter, LM Studio
CAIRN_AI_KIND=openai-compatible
CAIRN_AI_BASE_URL=http://localhost:11434/v1
CAIRN_AI_MODEL=llama3.1

# or Anthropic
CAIRN_AI_KIND=anthropic
CAIRN_AI_API_KEY=sk-ant-…

# or fully offline: deterministic rule-based analysis, clearly labeled
CAIRN_AI_KIND=local
```

Every structured completion goes through `LLM output → schema validation → one repair round → policy checks`. Malformed output never reaches the engine. Failure analysis that arrives after a provider outage falls back to local heuristics — and says so in its provider label.

## Security & privacy

- No telemetry, no analytics, no phoning home. Ever.
- Secrets: AES-256-GCM at rest, masked in every log, report, and evidence payload; never returned by the API.
- The web console talks to your server only; the browser never sees credentials.
- Optional `CAIRN_API_TOKEN` puts the whole console behind a bearer check.
- AI providers are opt-in and user-configured. With `CAIRN_AI_KIND=none` or `local`, no data leaves the host.

See [docs/security.md](docs/security.md) for the full model, and [SECURITY.md](SECURITY.md) for disclosure policy.

## Development

```bash
npm install
npm run test          # vitest: 36 tests across all packages
npm run build         # all packages + web console
npm run dev:web       # vite dev server with API proxy
```

Architecture details live in [docs/architecture.md](docs/architecture.md); the workflow JSON format in [docs/workflow-format.md](docs/workflow-format.md). PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- [x] Core engine, HTTP runner, evidence, failure intelligence
- [x] Provider-agnostic AI planner and analyzer
- [x] Web console with live execution timelines
- [ ] Playwright browser runner in CI (works locally; needs a browser cache layer)
- [ ] Scheduled executions
- [ ] JUnit/HTML export
- [ ] GitHub Actions reporter

## License

Apache-2.0 — see [LICENSE](LICENSE).
