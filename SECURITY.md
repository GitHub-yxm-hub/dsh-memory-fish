# Security policy

## Trust model

`dsh-memory-fish` is a **local-first** plugin. It has **no network access** — no
telemetry, no remote sync, no embedding API. All data lives under
`~/.dsh/memory-fish/` (or the configured `dir`).

The plugin runs inside the DeepSeek Harness host process, so it inherits the
host's privileges. It can read and write the memory directory and register
tools and local HTTP routes.

## What is stored

| Path | Content | Notes |
|---|---|---|
| `profile.md` | L0 profile shown to the model every session | user-editable |
| `memories/*.md` | durable memories | plain Markdown |
| `archive/*.md` | superseded/deleted versions | kept for audit |
| `journal/*.jsonl` | raw conversation capture (optional) | **secrets are redacted before write** |
| `dream/*.md` | nightly consolidation reports | |
| `index.json`, `stats.json` | metadata | |

`autoCapture` is on by default. It stores user/assistant message text (up to
`captureMaxChars` per message) to `journal/`. The text is passed through a
secret filter (`sk-…`, `api_key=…`, `password=…`, bearer tokens, PEM private
keys) before it hits disk, but the filter is best-effort — do not paste
credentials into chat.

Set `autoCapture: false` and delete `journal/` if you do not want any raw
conversation history on disk.

## Local panel

The optional HTTP panel is served by the DSH host web server on
`/memory-fish/panel`. It enforces:

- `Origin` vs `Host` match (blocks cross-site requests)
- `Sec-Fetch-Site` must be `same-origin` or `none`
- `Host` allow-list (localhost / loopback IPs only)
- method policing per route

It has **no authentication beyond that**: any local process that can open a
connection to the host port can read and modify memories. Run DSH on a trusted
machine and do not expose the port to the network.

## Multi-instance writes

Mutating operations take a lock file (`<dir>/.index.lock`) so two DSH instances
do not corrupt `index.json`. Stale locks (older than 15 s) are broken
automatically; a 5 s timeout raises an error instead of hanging. Mixing this
plugin with other tools that write `index.json` directly is not supported.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer.
Please do not file a public issue for an exploitable problem.

## Supported versions

Only the latest minor release receives fixes.
