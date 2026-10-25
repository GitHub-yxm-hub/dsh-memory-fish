# dsh-memory-fish 🐟

![banner](https://raw.githubusercontent.com/GitHub-yxm-hub/dsh-memory-fish/main/docs/banner.png)

[![npm](https://img.shields.io/npm/v/dsh-memory-fish.svg)](https://www.npmjs.com/package/dsh-memory-fish)
[![CI](https://github.com/GitHub-yxm-hub/dsh-memory-fish/actions/workflows/ci.yml/badge.svg)](https://github.com/GitHub-yxm-hub/dsh-memory-fish/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

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
| L1 hot index | pinned + recent entries | per session (v0.9 snapshot) | ≤400 tok (up to 100 reserved for todos) |
| L2 warm memories | full text | on demand via tools | 0 |
| L3 cold archive | superseded/removed versions, raw journal | never | 0 |

**10 memories or 10,000 — the injected block stays the same size.** Since v0.9 the block is also frozen into a *cache-friendly snapshot* (reusable across restarts), and memories are typed as fact / skill / task — with a small live "todos" block capped at 5 lines and `taskTokens` (100 by default, reserved out of the 600). Since v0.10 the skill library has a dedicated tool (`memory_skill`), and the block carries only one fixed reuse hint for it.

## Features

- **Zero dependencies, zero servers.** Plain Markdown + JSON under `~/.dsh/memory-fish/`.
- **Fixed token budget** (600 by default), hard-enforced on the whole block before injection.
- **Write-time dedupe + novelty gate.** Similarity ≥0.92 → no-op, 0.75–0.92 → in-place update, below → new entry.
- **Automatic salience scoring** (0–10): explicit "remember this", corrections, absolutes, novelty, pins.
- **Three-stage sleep** (`memory_dream`): SWS replay & compression → SHY salience-weighted decay → REM associative links.
- **Spaced repetition**: stability, nextReview, reviews; retrieval reinforces (×1.3 search, ×1.1 read); due items are signalled by one threshold line.
- **Temporal validity**: `validFrom`/`validTo` + version history; `memory_search({ asOf: "2026-09-15" })` answers "what did we use last month".
- **Auto-capture** of conversations into a raw journal (never injected, secrets redacted, 30-day retention).
- **Dream reminder (C1)** — no scheduled tasks, no session-event writes. A day-granular nudge appears only when a dream is overdue and there is new material. Zero cost when nothing is due; nothing to clean up on uninstall.
- **Optional visual panel**: a Settings section in DSH, plus a standalone page at `/memory-fish/panel` (v0.9 adds a todos block with done/drop buttons; the budget bar follows `budgetTokens`).
- **Mental model (v0.8)**: the L0 profile is rewritten periodically — the plugin decides due-ness and writes a task file, an isolated subagent does the writing, so the main context pays almost nothing.
- **Cache-friendly injection (v0.9)**: `injectionMode` freezes the L1 hot index into a snapshot (`session` / `daily` / `live`), so the system-prompt prefix only changes on real events.
- **Typed memories & todos (v0.9)**: `kind: fact | skill | task`; the `memory_task` tool with due dates, priorities and a `remaining` loop.

## Mental models (v0.8): L0 auto-rewrite

The L0 profile is the ~200 tokens that decide how the agent talks to you. Hand-written
profiles go stale; fully automatic ones drift. v0.8 splits the work:

1. **Plugin judges due-ness** — `memory_dream` Phase 4 compares
   `stats.lastProfileRewrite` against `mentalModelEveryDays` (default 7).
2. **Plugin prepares materials** — writes `dream/YYYY-MM-DD-mental-model.md` with the
   current profile, the 20 most recent active memories (id / title / tags / 200-char
   excerpt), the last 3 dream-report summaries, and rewrite instructions.
3. **Subagent rewrites** — the main agent first calls `memory_profile_archive`
   (old profile → `profile-history/`), then hands the task file to an isolated
   `subagent`, which returns a ≤200-token profile as plain text.
4. **Main agent persists** — validates length/secrets and calls `memory_profile_save`,
   which stamps `stats.lastProfileRewrite` so the next dream knows it is not due.

The dream report gains `## 🧠 Mental model（Phase 4 · L0 画像自动重写）` with
`画像到期：是/否` and the task-file path. Why a subagent and not plugin-internal LLM
calls: the plugin has no LLM dependency and should not add token cost; why not the main
session: rewriting means reading lots of memories, which is expensive in the main context.

Safety: only L0 changes (L1/L2 memories are never touched), old profiles are archived
and rollback-able, secrets are refused, and `clampToBudget` guarantees the token budget.

## Cache-friendly injection & memory kinds (v0.9)

### Why the cache matters

The system prompt is the prefix of every request. Change one byte and the provider's
**KV prefix cache** is invalidated — a long session has to re-prefill its whole history,
which costs far more than a few dozen extra tokens. v0.8.1 made the block byte-stable
(day-granular C1 nudge, no per-item `⏰`, a single threshold line). v0.9 goes one step
further and freezes the L1 hot index into an explicit *injection snapshot*.

### `injectionMode` (v0.9-A)

| Mode | Behaviour | Best for |
|---|---|---|
| `session` (default) | build once per session; frozen until a new session / dream / consolidate | long sessions, maximum cache hits |
| `daily` | rebuild on the first injection of each local day | many sessions per day, fresh index daily |
| `live` | rebuild on every injection (= 0.8 behaviour) | tests, debugging, short sessions |

- The snapshot is persisted at `<dir>/injection-cache.json` and replayed on restart; if a
  new-session event still triggers one rebuild, the rendered text is identical, so the
  prompt prefix keeps hitting.
- Invalidation reasons are observable: `init` / `session` / `day` / `dream` / `consolidate`;
  non-`live` modes also rebuild once when the local day changes (`reason=day`).
- Observability: `memory_stats` exposes `injectionMode`, `injectionRebuilds`,
  `lastInjectionRebuild{at,reason,day}`, `injectionCacheDay`; the panel shows the rebuild
  count and latest reason.
- Frozen: the L1 hot-index lines and the "reviews are due" threshold. L0 profile and the
  C1 nudge stay live (profile edits take effect immediately; the C1 text is day-granular
  and only changes on events / day boundaries / crossing the overdue threshold).
- Hard budget guard: `estTokens(block) ≤ budgetTokens`, trimming L1 lines from the end
  when the fixed text overhead would overflow. **Caveat:** extreme configs where
  `profileTokens` approaches `budgetTokens` (e.g. 550/600) can still overshoot on the
  fixed text; keep `profileTokens ≤ budgetTokens − 150` (the default 600/200 holds in
  testing).

### Memory kinds & todos (v0.9-B)

| kind | What it is | In hot index | Spaced repetition | Merged/decayed | In todos block |
|---|---|---|---|---|---|
| `fact` (default) | facts, preferences, decisions, troubleshooting conclusions | yes | yes | yes | no |
| `skill` | distilled skills / playbooks | no | yes (on read) | no (since v0.9-C) | no |
| `task` | todo task | no | no | no | yes (when open) |

New `memory_task` tool (11 → 12 tools):

| action | Purpose |
|---|---|
| `add` | create: `title` / `content` / `dueAt` (`YYYY-MM-DD`, local day) / `priority` (1–5, default 3) / `note`; open tasks with similarity ≥0.75 merge in place |
| `done` | mark complete (open only), records `doneAt`; optional `note` is appended to the task note (`old \| new`) and used as Phase 6 material |
| `drop` | drop (open only) |
| `list` | sort by overdue → `dueAt` → `priority`, plus `remaining` (open summaries) |

Every write action returns `remaining`, closing the "what's left after I finish this" loop.

A live `### 待办` block is injected between the profile and the hot index (it is **not**
part of the L1 snapshot):

```text
### 待办
- ⏰ 10-20 upgrade Node
- · 10-28 write v0.9 acceptance report
- · clean up temporary desktop files
- …另有 2 个（memory_task list）
```

Rules:

- open tasks only, max 5 lines; overflow prints `- …另有 N 个（memory_task list）`
- overdue → `⏰ MM-DD`, has deadline → `· MM-DD`, no deadline → `· title`
- the block itself is capped by `taskTokens` (default 100, reserved out of the L1 budget)
- when tasks exist, the footer gains
  `> 完成待办后用 memory_task done 标记，并查看剩余。`
- tasks skip memory dedupe (they only compare against open tasks), spaced repetition,
  decay/archival and the hot index

Also new: `memory_list` accepts `kind` (`fact | skill | task`, default all);
`memory_search` / `memory_read` / `memory_list` return
`kind` / `taskStatus` / `dueAt` / `sources`; `memory_stats` adds `tasksOpen`,
`tasksOverdue`, `taskTokens`, `kindCounts`, `skillExtraction`, `lastSkillExtract`; the
standalone panel renders a "待办（open task）" section with done/drop buttons; frontmatter
gains `kind:` / `task_status:` / `due_at:` / `done_at:` / `priority:` / `note:` (old data
migrates to `fact`).

### Skill distillation & provenance (v0.9-C)

**The `skill` kind.** `memory_save({ kind: 'skill' })` stores a distilled skill. Skills
skip the hot index, the todos block, the dream SWS merge / SHY decay and
`memory_consolidate` merging/archival — a skill is a distillation product whose lifecycle
is driven by explicit actions. Updates never **downgrade** a kind: a skill is not
overwritten by a same-topic fact, while fact → skill is allowed.

**`sources` provenance.** `memory_save` takes an optional `sources` array of task/memory
ids (deduped, at most 5 kept); updating an entry unions the new ids with the old ones and
keeps the latest 5. They are stored in the `sources:` frontmatter line and returned by
`memory_read` / `memory_search` / `memory_list`. It is just a "where did this come from"
pointer — no graph traversal. Secret-looking `sources` values are filtered out; the NOOP
(exact duplicate) branch writes no content but still merges new `sources` into the
existing entry (provenance is not lost).

**dream Phase 6 · skill distillation.** `memory_dream` checks for tasks completed since
the last distillation (`stats.lastSkillExtract`; only `status=active` done tasks count):

- **Some** → writes `dream/YYYY-MM-DD-skill-task.md` with:
  - up to 10 recently completed tasks (id / title / content / note / done time; the note
    is `add`'s note plus the `done` completion note)
  - up to 15 related active fact memories (shared task tags first, then most recent)
  - the last 3 dream-report summaries
  - distillation instructions for the subagent (1–3 skills, `TITLE:` / `SKILL:` /
    `TAGS:` / `SOURCES:` format, ≤200 tokens each)
- the dream report gains `## 🧠 Phase 6 · Skill 提炼`:
  `技能提炼：是 → 任务文件：…` or `技能提炼：否（无新完成的待办任务…）`
- the main agent hands the task file to a subagent, then persists each result with
  `memory_save(kind='skill', sources=[task id])`
- `stats.lastSkillExtract` is stamped **only when a task file was actually written**, so
  the same batch is not distilled twice; `skillExtraction: false` disables the phase and
  the report section disappears entirely
- the other dream materials (SWS merge, SHY decay, Phase 4 profile) also only use facts;
  tasks and skills are excluded

Design details are in [DESIGN.md](./DESIGN.md) under "v0.9 cache contract & memory kinds";
the append-only (tail) injection feasibility study is archived at
[docs/DSH-APPEND-INJECTION.md](./docs/DSH-APPEND-INJECTION.md) — decision: not for v0.9,
optional in v0.10.

## Skill library (v0.10): search, reuse, revise

v0.9 made skills a distinct kind, but they were only reachable through `memory_search`:
the model would rarely think to reuse them, and there was no explicit revision entry point.
v0.10 closes the loop with **a dedicated tool + one fixed hint line in the injected block +
versioned revisions** — without breaking the cache contract.

### The 13th tool: `memory_skill`

| action | What it does |
|---|---|
| `list` | All active skills sorted by `updated` (default 20 / max 50): id / title / tags / updated / importance / hits |
| `search` | Case-insensitive keyword match on title (+3) / tags (+2) / content (+1); returns id / title / tags / updated / score / excerpt (≤200 chars) and the reusable `content` (≤800 chars, `truncated` flag). A hit counts as a reuse (records `hits`, reinforces ×1.1 when `reviewEnabled`) |
| `add` | New skill: reuses `memory_save`'s dedupe / novelty gate / NOOP / versioning / secret checks (`kind='skill'` fixed); `sources` point back to the originating tasks |
| `update` | Revise by id: `content` replace (default) or `append` to the old content (when both are given, `content` wins); `title` / `tags` replace (≤3 tags); `sources` union (≤5). The old version goes to `history` (≤10) and its old file to `archive/`; `validFrom` / `updated` are refreshed |

Error semantics: non-skill id → `invalid_kind`; missing / archived → `not_found`; empty
query, missing content+append, bad action → `invalid_input`; secret-looking
title / content → `secret_refused` (on update, secret-looking `tags` / `sources` values are
filtered). Every action serializes through the write lock (`search` updates hits / review
state).

### The fixed reuse hint (cache-safe)

When at least one active skill exists, the injected block gains one fixed line (no counts,
no dates, no relative time):

```text
> 需要相关经验/历史做法时先用 memory_skill search 检索技能库；技能可用 memory_skill update 补充修订。
```

- It is a pointer, not a listing: `search` / `update` never rebuild the injection snapshot,
  and revising skill content leaves the injected block byte-identical (skills are not
  injected)
- The line only appears / disappears when the library goes from empty to non-empty (or the
  last active skill is archived) — a semantic event, same class as a todo block appearing
- Its tokens are reserved out of the L1 budget (like the reminder / todo blocks), so the
  whole block stays ≤ `budgetTokens`

### dream Phase 6 update

Phase 6 task-file instructions now persist with **`memory_skill add`** (still compatible
with `memory_save(kind='skill', sources)`); the report's "next step" line matches.

Design details are in [DESIGN.md](./DESIGN.md) under "v0.10 skill library & reuse".

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

The plugin registers 13 model tools (mutations are serialized by a cross-process lock):

| Tool | Purpose |
|---|---|
| `memory_save` | Save/update a memory (dedupe, salience, versioning); `kind` is `fact` (default) or `skill`; optional `sources` provenance ids (≤5, union on update) |
| `memory_search` | Keyword search; `asOf` for historical versions; `includeArchived` for cold storage; results carry `kind` / `taskStatus` / `dueAt` / `sources` |
| `memory_read` | Read full text (>4000 chars truncated) and reinforce; returns `kind` / `sources`; tasks are not reinforced |
| `memory_list` | Recent memories; filter by `kind` (fact / skill / task); returns `sources` |
| `memory_task` | Todos: add / done / drop / list; `done` accepts a completion note (used as Phase 6 material) |
| `memory_skill` | Skill library: list / search / add / update; search returns reusable content + score, update supports replace / append and keeps history (v0.10) |
| `memory_pin` | Pin/unpin (pinned never decays) |
| `memory_forget` | Soft delete + tombstone |
| `memory_profile_save` | Write the L0 profile (hard-clamped to `profileTokens`, secrets refused, stamps rewrite time) |
| `memory_profile_archive` | Copy the current profile to `profile-history/` before a rewrite |
| `memory_dream` | Run the three-stage sleep; returns phases, due-review list, candidates, mental-model task, skill-distillation task |
| `memory_stats` | Injection tokens, counts, salience avg, due count, injection rebuilds, todos, kind counts, skill extraction status |
| `memory_consolidate` | Merge near-duplicates, archive weak memories (dry-run supported; tasks/skills excluded) |

## Data location

```
~/.dsh/memory-fish/
├── profile.md           # L0 (≤200 tok, always injected)
├── profile-history/     # v0.8: snapshots of the old profile before each rewrite
├── index.json           # metadata index (rebuildable)
├── memories/            # L2: one Markdown per memory (kind/task/skill frontmatter)
├── archive/             # L3: superseded / removed originals (incl. pre-revision skill versions)
├── journal/             # auto-captured raw conversations (per-day jsonl, never injected)
├── dream/               # dream reports (per-day md) + *-mental-model.md + *-skill-task.md
├── injection-cache.json # v0.9: L1 injection snapshot (replayed on restart)
└── stats.json           # counters (incl. lastProfileRewrite / injectionRebuilds / lastSkillExtract)
```

Everything is human-readable, git-able and hand-editable. A lost index is rebuilt from
`memories/*.md`.

## Architecture

```
index.mjs        plugin entry: config, system-prompt injection, auto-capture, session epochs, wiring
lib/config.mjs   defaults + config normalization (injectionMode allow-list)
lib/util.mjs     tokens, bigrams/Jaccard, salience, spaced repetition, redaction
lib/store.mjs    Markdown/JSON store, journal, archive, migration, injection snapshots, task files
lib/inject.mjs   profile + todos + skill hint + hot-index block builder (snapshot + hard budget)
lib/core.mjs     saveMemoryCore (kind/sources) / taskCore / skillCore: dedupe / novelty gate / versioning / todos / skill library
lib/dream.mjs    three-stage sleep + Phase 4 profile rewrite + Phase 6 skill distillation
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
    injectionMode: session   # v0.9: session | daily | live
    taskTokens: 100          # v0.9: todos block budget (reserved out of 600)
    skillExtraction: true    # v0.9-C: dream Phase 6 skill distillation
    autoCapture: true
    debug: false
```

Key options: `dir`, `budgetTokens`, `profileTokens`, `maxHotLines`, `injectionMode`,
`taskTokens`, `skillExtraction`, `archiveAfterDays`, `dedupeThreshold`, `noopThreshold`,
`reviewEnabled`, `autoCapture`, `captureMaxChars`, `journalKeepDays`, `dreamDays`,
`dreamReminder`, `dreamAfterHours`, `mentalModel`, `mentalModelEveryDays`, `panelPath`,
`apiBase`, `debug`. An invalid `injectionMode` falls back to `session`.

## Tests

```bash
npm test   # 204 assertions: capture, redaction, save/dedupe/NOOP, search,
           # asOf history, sleep phases + Phase 4 mental model + Phase 6 skill
           # distillation (due/task file/material caps/lastSkillExtract/disabled),
           # skill kind + no kind downgrade, sources provenance round-trip/union/
           # NOOP merge/secret filter, note secret refusal, injection snapshot modes
           # (session/daily/live, day-boundary rebuild, restart reuse, rebuild
           # reasons/counters), hard-budget pressure, kind/todo lifecycle and
           # injection, budget integration, byte-stable injection (cache friendly),
           # v0.10 skill library (list/search scoring and reuse accounting,
           # excerpt/content caps, add dedupe reuse, update replace/append/history/
           # archive/error codes, same-second archive collision regression,
           # hint presence and byte stability, budget with hint),
           # panel routes + configurable budget + todo buttons, lock release
```

CI runs on Linux and Windows with Node 22 and 24.

## Security

Local-first, no network. Journal writes redact API keys/tokens/passwords before
hitting disk. `memory_task` notes (`add` / `done` `note`) are checked against the secret
patterns and refused with `secret_refused`; secret-looking values in `memory_save`
`sources` are filtered out. `memory_skill` add/update checks title / content against the
same secret patterns and refuses them; secret-looking `sources` values (and `tags` on
update) are filtered out. The HTTP panel is localhost-only with same-origin checks but
**no authentication** — run DSH on a trusted machine. See [SECURITY.md](./SECURITY.md).

## License

MIT
