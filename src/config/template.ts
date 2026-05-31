export const DEFAULT_CONFIG_YAML = `# ownllm configuration
# Values support \${ENV_VAR} interpolation, resolved at load time.
# An unresolved \${VAR} (env not set) is a hard error.

server:
  host: 127.0.0.1            # non-loopback host requires api_key, or the server refuses to start
  port: 8787
  # api_key: \${OWNLLM_API_KEY}  # client auth (timing-safe); REQUIRED when host is not loopback
  request_timeout_ms: 600000  # upstream abort deadline
  strict_params: false        # true => unsupported params return 400 instead of being ignored

providers:
  openai-codex:
    enabled: true
  xai:
    enabled: true

# Routing table: requested model name -> upstream provider + model.
# A requested model absent from this table returns 404 (model_not_found).
models:
  gpt-5-codex:
    provider: openai-codex
    upstream: gpt-5-codex
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
  grok:
    provider: xai
    upstream: grok-build      # Grok Build model names churn; verify with 'ownllm models --remote'
    reasoning_effort: medium
  grok-4:
    provider: xai
    upstream: grok-4.3
`
