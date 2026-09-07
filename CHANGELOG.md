# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is semantic.

## [0.1.0] — initial release

### Added
- Core domain: workflow graph validation, safe expression evaluator, action policy engine, secret masking.
- Execution engine with retries, per-step timeouts, cooperative cancellation, and a guaranteed terminal status.
- HTTP runner with structured assertions and full request/response evidence capture.
- Playwright-backed browser runner (optional dependency) for navigation, interaction, DOM assertions, and screenshots.
- Provider-agnostic AI layer: OpenAI-compatible and Anthropic providers, schema-validated structured outputs, and a deterministic offline "local" mode.
- AI planner: natural-language intent to validated workflow drafts; hallucinated step kinds are dropped, never executed.
- Failure intelligence: structured expected/observed records plus clearly labeled AI hypotheses with confidence levels.
- Evidence system: HTTP exchanges, screenshots, console logs, and notes, linked to steps.
- Fastify server: projects, versioned workflows, execution queue, encrypted secret store (AES-256-GCM), dashboard statistics computed from real data.
- React console: overview, project dashboards, workflow editor, live execution timelines, evidence viewer, settings.
- Docker deployment with health checks; GitHub Actions CI and release workflow.
