# Architecture

## Packages

```
@cairn/core      Domain: types, validation, expression evaluator, policy, masking
@cairn/executor  Engine: state machine, runners (http/browser/assert/delay/note), evidence
@cairn/ai        Providers, structured completions, planner, failure analysis
@cairn/server    Fastify API, SQLite store, queue, crypto, static hosting
@cairn/web       React console
```

Dependencies point one way: `web → server → ai → executor → core`. Nothing cycles.

## The engine contract

`ExecutionEngine.run(workflow, runOptions)` guarantees:

1. A row exists for the execution before the first step starts.
2. Every path — success, failure, cancel, timeout, *engine crash* — ends in a terminal status with timestamps.
3. Secrets never appear in: step outputs, evidence payloads, logs, or the persisted execution record.
4. Policy is checked *per attempt*, in the engine, before any runner code executes.

## Trust boundaries

```
LLM ──▶ schema validation ──▶ one repair round ──▶ core validation ──▶ policy gate ──▶ runner
```

The AI layer can only produce inputs to these gates. It cannot register step
kinds, change the policy, or read the secret store.

## Why SQLite

Self-hosted QA tooling should be one process and one file. Node's built-in
`node:sqlite` (or `bun:sqlite` under Bun) means zero native compilation and
zero external services. If a deployment outgrows it, `Store` is the single
class to replace.

## Why the expression language is hand-rolled

Workflow conditions and assertions need comparisons and boolean logic. Using
`eval` for that is how sandboxes die. The evaluator is a ~160-line recursive
descent parser with an AST, no property access, no calls, no globals. Malformed
conditions fail at *save* time.
