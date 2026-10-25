# dsh-memory-fish 🐟

![banner](https://raw.githubusercontent.com/GitHub-yxm-hub/dsh-memory-fish/main/docs/banner.png)

> **Context-budgeted local memory for DeepSeek Harness.**
> Memory can grow forever; the prompt injection stays at a fixed ~600 tokens.
> It sleeps, it reviews, and it remembers what was true last month.

[中文说明](./README.md) · [Design](./DESIGN.md) · [Research](./RESEARCH.md) · [Changelog](./CHANGELOG.md) · [Security](./SECURITY.md)

## Why

Most memory plugins inject an index that grows with your memory count — 500 memories, 500 lines in every prompt. It gets expensive and slow.

dsh-memory-fish splits *storage* from *injection*:

| Layer | Content | Injected | Budget |
|---|---|---|---|
| L0 profile | who you are, hard constraints | every session | ≤200 tok |
| L1 hot index | pinned + recent entries | every session | ≤400 tok |
| L2 warm memories | full text | on demand via tools | 0 |
| L3 cold archive | superseded/removed versions, raw journal | never | 0 |

**10 memories or 10,000 — the injected block stays the same size.**

## Features

- **Zero dependencies, zero servers.** Plain Markdown + JSON under `~/.dsh/memory-fish/`.
- **Fixed token budget** (600 by default), enforced before injection.
- **Write-time dedupe + novelty gate.** Similarity ≥0.92 → no-op, 0.75–0.92 → in-place update, below → new entry.
- **Automatic salience scoring** (0–10): explicit "remember this", corrections, absolutes, novelty, pins.
- **Three-stage sleep** (`memory_dream`): SWS replay & compression → SHY salience-weighted decay → REM associative links.
- **Spaced repetition**: stability, nextReview, reviews; retrieval reinforces (×1.3 search, ×1.1 read); due items marked ⏰.
- **Temporal validity**: `validFrom`/`validTo` + version history; `memory_search({ asOf: "2026-09-15" })` answers "what did we use last month".
- **Auto-capture** of conversations into a raw journal (never injected, secrets redacted, 30-day retention).
- **Dream reminder (C1)** — no scheduled tasks, no session-event writes. When the last dream is older than `dreamAfterHours` (24h default) or memories are due for review, the injection block adds a two-line nudge. Zero cost when nothing is due; nothing to clean up on uninstall.
- **Optional visual panel**: a Settings section in DSH, plus a standalone page at `/memory-fish/panel`.

## Install

```bash
# from npm (once published)
dsh plugin --profile web add dsh-memory-fish

# or from a local clone
dsh plugin --profile web add ./dsh-memory-fish
```

Then restart DSH. Verify with a new chat: say *"remember: I prefer pnpm"* and look for a `memory_save` tool call.

Requirements: Node.js ≥ 22.19, DeepSeek Harness 0.2.x (tested on 0.2.1).

## Tools

| Tool | Purpose |
|---|---|
| `memory_save` | Save/update a memory (dedupe, salience, versioning) |
| `memory_search` | Keyword search; `asOf` for historical versions; `includeArchived` for cold storage |
| `memory_read` | Read full text (>4000 chars truncated) and reinforce |
| `memory_list` | Recent memories |
| `memory_pin` | Pin/unpin (pinned never decays) |
| `memory_forget` | Soft delete + tombstone |
| `memory_profile_save` | Write the L0 profile |
| `memory_dream` | Run the three-stage sleep; returns phases, due-review list, candidates |
| `memory_stats` | Injection tokens, counts, salience avg, due count |
| `memory_consolidate` | Merge near-duplicates, archive weak memories (dry-run supported) |

## Architecture

```
index.mjs        plugin entry: config, system-prompt injection, auto-capture, wiring
lib/config.mjs   defaults + config normalization
lib/util.mjs     tokens, bigrams/Jaccard, salience, spaced repetition, redaction
lib/store.mjs    Markdown/JSON store, journal, archive, migration
lib/inject.mjs   L0+L1 prompt block builder (budget-limited)
lib/core.mjs     saveMemoryCore: dedupe / novelty gate / versioning
lib/dream.mjs    three-stage sleep
lib/tools.mjs    model-facing tools (mutations serialized by lock)
lib/panel.mjs    local HTTP panel + API
lib/lock.mjs     cross-process write lock
lib/log.mjs      opt-in debug log
client/client.js Settings panel (browser half)
```

## Configuration

Pass config through the profile's `cordis.patch.yml`:

```yaml
- id: memory-fish
  config:
    budgetTokens: 600
    maxHotLines: 12
    autoCapture: true
    debug: false
```

Key options: `dir`, `budgetTokens`, `profileTokens`, `maxHotLines`,
`archiveAfterDays`, `dedupeThreshold`, `noopThreshold`, `reviewEnabled`,
`autoCapture`, `captureMaxChars`, `journalKeepDays`, `dreamDays`,
`panelPath`, `apiBase`, `debug`.

## Tests

```bash
npm test   # 46 assertions: capture, redaction, save/dedupe/NOOP, search,
           # asOf history, sleep phases, panel routes, lock release, budget
```

CI runs on Linux and Windows with Node 22 and 24.

## Security

Local-first, no network. Journal writes redact API keys/tokens/passwords before
hitting disk. The HTTP panel is localhost-only with same-origin checks but **no
authentication** — run DSH on a trusted machine. See [SECURITY.md](./SECURITY.md).

## License

MIT

