# AI providers

Cairn ships three provider kinds. All are opt-in.

## OpenAI-compatible

Works with any server speaking the `/chat/completions` shape: OpenAI, Azure
OpenAI (via gateway), OpenRouter, Together, vLLM, LM Studio, Ollama's OpenAI
adapter.

```bash
CAIRN_AI_KIND=openai-compatible
CAIRN_AI_BASE_URL=http://localhost:11434/v1
CAIRN_AI_MODEL=llama3.1
```

## Anthropic

```bash
CAIRN_AI_KIND=anthropic
CAIRN_AI_API_KEY=sk-ant-…
CAIRN_AI_MODEL=claude-sonnet-4-5
```

## Local heuristics (offline)

```bash
CAIRN_AI_KIND=local
```

No model, no network. The planner emits template workflows for common shapes;
failure analysis derives hypotheses from failure codes and assertion records.
Results are labeled `local-heuristic` and carry conservative confidence.

## Guarantees (all kinds)

1. Structured outputs are schema-validated; one repair round-trip is attempted
   before giving up with `E_AI_SCHEMA`.
2. Plans pass through the same validator as hand-written workflows. Unregistered
   step kinds are dropped. A plan with zero valid steps is rejected.
3. Failure analyses are *hypotheses*. The console labels provider and
   confidence, and shows them next to — never instead of — observed facts.
4. If a cloud provider fails mid-analysis, the local analyzer takes over and
   the provider label says so.
