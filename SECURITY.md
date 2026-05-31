# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
(Security advisories) rather than opening a public issue. Include a description,
reproduction steps, and impact. We aim to acknowledge within 72 hours.

## Threat model and handling of secrets

ownllm stores OAuth credentials for your personal LLM subscriptions. They are
sensitive bearer secrets.

- **At rest:** the auth store (`~/.ownllm/auth.json`) is written with mode `0600`
  inside a `0700` parent directory, via atomic create-and-rename.
- **In logs:** credentials are never logged. Logging redacts `authorization`,
  `cookie`, `set-cookie`, `*.access_token`, `*.refresh_token`, `*.id_token`, and
  `cf_clearance`. Request/response bodies are logged only at `debug`.
- **Client authentication:** API requests require `server.api_key`, compared in
  constant time. The server refuses to start on a non-loopback host without one.
- **Network egress:** the upstream HTTP client is host-pinned — bearer tokens and
  cookies are only ever sent to the allowlisted upstream hosts for each provider.
- **No telemetry:** ownllm makes no outbound calls other than to provider OAuth
  and inference endpoints.

## Scope and intended use

ownllm is for personal, single-user use of your own subscriptions. See the
disclaimer in the README. It is not designed or supported for multi-tenant or
resale scenarios.
