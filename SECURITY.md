# Security policy

## Reporting a vulnerability

Open a private security advisory via GitHub's "Report a vulnerability" feature,
or contact the maintainers directly. Do not open a public issue for security
problems. You can expect an initial response within 7 days.

## Security model

- **Secrets** are encrypted at rest (AES-256-GCM) with the key derived from
  `CAIRN_SECRET_KEY`. They are never returned by the API, never written to
  logs, and masked at the central choke point through which all evidence and
  report output passes.
- **AI output is untrusted.** Plans and analyses must pass schema validation
  and the action-policy engine; the execution engine enforces policy
  independently of the AI layer.
- **Destructive action classes** require explicit per-workflow authorization.
- **Network allowlist** (`CAIRN_NETWORK_ALLOWLIST`) restricts outbound HTTP and
  browser steps when set.
- **No telemetry.** The only outbound traffic Cairn makes on its own is to the
  AI provider you configure, of the data you send.
