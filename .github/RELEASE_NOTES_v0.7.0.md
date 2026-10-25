# dsh-memory-fish v0.7.0

**Context-budgeted local memory for DeepSeek Harness.** Memory grows; the prompt doesn't.

## Highlights

- **Fixed ~600 token injection** — L0 profile + L1 hot index have a hard budget; L2/L3 stay on disk and load on demand. Ten memories or ten thousand, the prompt stays the same size.
- **Three-stage sleep** (`memory_dream`) — SWS replay & compression → SHY salience-weighted decay → REM associative links.
- **Spaced repetition** — per-memory `stability` / `nextReview` / `reviews`; search reinforces ×1.3, read ×1.1; due items are marked `⏰`.
- **Temporal validity** — `validFrom` / `validTo` + version history; `memory_search({ asOf: "2026-09-15" })` answers "what did we use last month".
- **Salience & novelty gate** — automatic 0–10 scoring, NOOP above 0.92 similarity, in-place update between 0.75 and 0.92.
- **Auto-capture journal** — raw conversation is stored locally with secrets redacted, never injected, 30-day retention.
- **Dream reminder (C1)** — no scheduled tasks and no session-event writes; the injected block nudges when a dream is due. Nothing to initialize, nothing to clean up.
- **Zero dependencies, zero servers** — plain Markdown + JSON under `~/.dsh/memory-fish/`.
- **Optional visual panel** — a Settings section in DSH plus a standalone page at `/memory-fish/panel`.

## Install

```bash
dsh plugin --profile web add dsh-memory-fish
```

Then restart DSH. Verify in a new chat: say *"remember: I prefer pnpm"* and look for a `memory_save` call.

## Requirements

- Node.js ≥ 22.19
- DeepSeek Harness 0.2.x (tested on 0.2.1)

## Security

Local-first, no network. Journal writes redact API keys, passwords, bearer tokens and PEM private keys before hitting disk. The optional panel is localhost-only with same-origin checks but has no authentication. Mutating operations take a cross-process lock. See [SECURITY.md](../SECURITY.md).

## Testing

49 smoke assertions, CI on Linux and Windows with Node 22 and 24. Run locally:

```bash
npm test
```

## License

MIT
