# Authentication

ownllm reaches each provider through your subscription login instead of an API key. You log in once
per provider, ownllm stores the OAuth tokens under `~/.ownllm/`, and from then on it refreshes them
for you.

Two providers are supported:

| Provider | Subscription | Login id |
|---|---|---|
| ChatGPT / Codex | ChatGPT Plus, Pro, or Business | `openai-codex` |
| xAI Grok | Grok or SuperGrok | `xai` |

## Logging in

```bash
ownllm auth login openai-codex
ownllm auth login xai
```

The two flows differ a little, because the providers do.

### ChatGPT / Codex

`ownllm auth login openai-codex` prints a URL and a short code:

```
To authorize Codex, open this URL on any device:
  https://auth.openai.com/codex/device
and enter the code: ABCD-EFGH
```

Open the URL, sign in to ChatGPT, type the code. The terminal finishes on its own once you approve.
Because you enter the code by hand, the device with the browser doesn't have to be the one running
ownllm: your phone works, and so does a laptop on the near end of an SSH session. This flow behaves
the same on a headless server as on your desktop.

### xAI Grok

If the machine has a browser, `ownllm auth login xai` prints a URL to open and catches the redirect
for you. Approve the request and you're done.

If it doesn't (think containers, SSH sessions, cloud shells), there's no browser to open and nothing
local for xAI's redirect to reach. ownllm notices and switches to a paste flow instead: it prints a
URL, you open it on whatever machine does have a browser, and you paste the result back. You can
force that mode anywhere with `--manual`:

```bash
ownllm auth login xai --manual
```

The paste flow is three steps:

1. Open the printed URL in any browser and approve the request.
2. Your browser gets redirected to a `http://127.0.0.1:…` address that won't load. That is expected;
   the page never needs to load.
3. Copy that whole address out of the address bar and paste it into the terminal. If xAI showed a
   code on the page instead of redirecting, paste the code on its own.

One thing worth knowing up front: xAI only grants programmatic access to certain subscription tiers.
If login succeeds but your requests come back as `xai_tier_denied`, the account isn't entitled, and
logging in again won't change that. See [troubleshooting](#troubleshooting).

## Checking what's stored

```bash
ownllm auth status
```

prints each stored credential: the account it belongs to, the last four characters of the token,
when it expires, and whether it's still valid. Full tokens are never printed.

`ownllm doctor` goes a step further and actually probes each provider to see whether it's reachable
from where you're running. That's the quickest way to tell an entitlement problem apart from a plain
network one.

## Logging out

```bash
ownllm auth logout xai
```

removes that one provider's credential and leaves the others alone.

## Reusing an existing Codex login

Already using the official Codex CLI? You can import its tokens instead of logging in again:

```bash
ownllm auth import openai-codex
```

This reads whatever the Codex CLI saved under `~/.codex` (or `$CODEX_HOME`). Be careful with it: the
two tools then share one refresh token, and the first to refresh invalidates the other's session, so
you can get logged out of both at once. A plain `ownllm auth login openai-codex` keeps the sessions
separate and is the safer default.

## Where credentials live

Tokens go in `~/.ownllm/auth.json`, owner-readable only (`0600`), kept apart from your config. Set
`OWNLLM_HOME` to move that directory. To hand another machine a login (a container, say), copy that
file across or mount the directory in — no second login needed.

In Docker you can also just log in inside the running container; the image puts `ownllm` on `PATH`,
and both flows above work headless:

```bash
docker compose exec ownllm ownllm auth login openai-codex
docker compose exec ownllm ownllm auth login xai   # add --manual to force the paste flow
```

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| `credential_expired` (401) | The token expired and couldn't be refreshed. | Run `ownllm auth login <provider>` again. |
| `xai_tier_denied` (403) | Your xAI account isn't allowlisted for API access. | A tier gate on xAI's end; re-logging in won't help. Check your plan at x.ai. |
| `codex_cloudflare_blocked` (502) | Cloudflare challenged the request, which is common on datacenter and Docker IPs. | Try from a residential or home-server IP. It's a network block, not a bad token. |
| xAI login sits on "waiting for callback" | The browser can't reach the loopback listener on this machine. | Press Ctrl-C and re-run with `--manual`. |

The full list of error codes is in the [HTTP API reference](./api.md#errors).
