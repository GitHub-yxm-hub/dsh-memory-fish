# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [0.10.0] — 2026-10-26

### Added
- **`memory_skill` tool (12 → 13 tools).** A dedicated skill-library tool with
  `action: list | search | add | update`, registered in the mutation lock set.
  - `list` returns active skills sorted by `updated` (default 20 / max 50) with
    id / title / tags / updated / importance / hits.
  - `search` scores title (+3) / tags (+2) / content (+1), case-insensitive, and returns
    id / title / tags / updated / score / excerpt (≤200 chars) plus the reusable
    `content` (≤800 chars, `truncated` flag). A hit counts as a reuse: `hits` / `lastHit`
    are recorded and, with `reviewEnabled`, the entry is reinforced ×1.1.
  - `add` reuses `saveMemoryCore` with `kind='skill'`, so dedupe / novelty gate / NOOP /
    versioning / secret checks / `sources` normalization behave exactly like `memory_save`.
  - `update` revises a skill by id: `content` replace (default) or `append` to the old
    content (when both are given, `content` wins); `title` / `tags` replace (≤3 tags);
    `sources` union (≤5). The previous version goes to `history` (≤10) and its old file
    to `archive/`, and `validFrom` / `updated` are refreshed. Errors: `invalid_kind`
    (non-skill id), `not_found` (missing / archived), `invalid_input` (empty query,
    missing content+append, bad action), `secret_refused` on secret-looking
    title / content (secret-looking `tags` / `sources` values are filtered when updating).
- **Cache-safe reuse hint in the injected block (v0.10.0).** When at least one active
  skill exists, the block gains one fixed line (no counts, no dates, no relative time):
  `> 需要相关经验/历史做法时先用 memory_skill search 检索技能库；技能可用 memory_skill update 补充修订。`
  Its tokens are reserved out of the L1 budget, and `search` / `update` never invalidate
  the injection snapshot — revising a skill leaves the injected block byte-identical.

### Changed
- **dream Phase 6 instructions now persist with `memory_skill add`** (still compatible
  with `memory_save(kind='skill', sources)`); the report's "next step" line matches.
- Skills stay out of the hot index: the hint line is the only injected trace of the
  skill library.

### Fixed
- **`archiveContent` same-second collision (v0.10.0 polish).** Archiving the same entry
  twice within one second (now common with consecutive skill revisions) no longer
  overwrites the previous archive file — a numeric suffix is appended, so every revision
  stays recoverable.

### Design notes
- Why a dedicated skill tool but no hot-index lines: skills are long-form, low-frequency
  reusable procedures. Listing them in L1 would blow the 400-token hot-index budget and
  churn on every edit; a ~20-token fixed hint plus on-demand `search` keeps injection cost
  O(1) while making the library discoverable.
- Cache contract extension: the hint's presence is a boolean over "is there an active
  skill", never a count or timestamp, so the system prompt only changes when the first
  skill is added (or the last one is archived) — a semantic event, same class as a todo
  block appearing / disappearing.
- Revisions are versioned like memory updates: `history` (≤10) + archived old file +
  refreshed `validFrom`, so an "improved playbook" never silently erases the old one.
- `memory_skill` joins the `MUTATING` lock set because `search` updates hits / review
  state; all actions therefore serialize across processes.
- Tests: 204 assertions — 38 new (37 skill-library assertions + 1 `archiveContent`
  same-second collision regression) on top of the v0.9 suite, which stays green.

## [0.9.0] — 2026-10-26

### Added
- **Cache-aware injection snapshots (v0.9-A).** New `injectionMode`
  (`session` | `daily` | `live`, default `session`) freezes the L1 hot-index lines and
  the "reviews are due" threshold flag into a snapshot, persisted at
  `<dir>/injection-cache.json` and replayed after a restart. `session` refreshes once per
  session (new session / dream / consolidate), `daily` on each local day, `live` keeps
  the 0.8 real-time behaviour. L0 profile and the C1 nudge stay live. `memory_stats` and
  the panel API expose `injectionMode`, `injectionRebuilds`,
  `lastInjectionRebuild{at,reason,day}`, `injectionCacheDay`.
- **Memory kinds (v0.9-B).** Every entry gets `kind: 'fact' | 'skill' | 'task'`
  (`fact` default; old data migrated). Tasks are excluded from the hot index, spaced
  repetition, decay/archival and consolidation; skills are excluded from the hot index.
- **`memory_task` tool (11 → 12 tools).** Actions `add | done | drop | list`; `dueAt` is a
  local `YYYY-MM-DD` (invalid input → `invalid_input`), `priority` 1–5 (default 3),
  optional `note`; `done` accepts an extra `note` that is appended to the task note
  (`old | new`) and later used as Phase 6 material; open tasks with similarity ≥
  `dedupeThreshold` merge in place; `done`/`drop` only apply to open tasks. Every write
  action returns `remaining` (still-open summaries) for a "what's left" loop.
- **Injected `### 待办` block (v0.9-B).** Rendered live (not part of the L1 snapshot)
  between profile and hot index: open tasks only, max 5 lines, overdue as `- ⏰ MM-DD …`,
  due tasks as `- · MM-DD …`, no-deadline as `- · …`; overflow prints
  `- …另有 N 个（memory_task list）`. Budget: new `taskTokens` (default 100), reserved out
  of the L1 budget. When tasks exist the footer gains
  `> 完成待办后用 memory_task done 标记，并查看剩余。`
- **Skill kind with no-downgrade updates (v0.9-C).** `memory_save` accepts
  `kind: 'skill'`. Skills skip the hot index, the todos block, dream's SWS merge / SHY
  decay and `memory_consolidate` merging/archival. Same-topic updates never downgrade a
  kind: a skill is not overwritten by a same-topic fact, while fact → skill is allowed.
  Dream materials (SWS/SHY, Phase 4 profile, Phase 6 related memories) only use facts.
- **Provenance `sources` (v0.9-C).** `memory_save` takes an optional `sources` array of
  task/memory ids (deduped, at most 5 kept); updating an entry unions the new ids with the
  old ones and keeps the latest 5. Persisted as the `sources:` frontmatter line and
  returned by `memory_read` / `memory_search` / `memory_list` (and by `memory_save`).
- **dream Phase 6 · skill distillation (v0.9-C).** When tasks were completed after
  `stats.lastSkillExtract`, `memory_dream` writes `dream/YYYY-MM-DD-skill-task.md`:
  up to 10 recently completed tasks (id / title / content / note / done time), up to 15
  related active fact memories (shared task tags first, then most recently updated), the
  last 3 dream-report summaries, and instructions for a subagent (1–3 skills in
  `TITLE:` / `SKILL:` / `TAGS:` / `SOURCES:` format, ≤200 tokens each). The dream report
  gains `## 🧠 Phase 6 · Skill 提炼` (`技能提炼：是/否` → task path). The main agent
  hands the file to a subagent and persists the results with
  `memory_save(kind='skill', sources=[task id])`. `stats.lastSkillExtract` is stamped only
  when a task file was actually written; `skillExtraction: false` hides the whole phase.
- `memory_list` gains `kind` filtering (`fact | skill | task`, default all);
  `memory_search` / `memory_read` / `memory_list` results carry
  `kind` / `taskStatus` / `dueAt` / `sources`; `memory_stats` adds `tasksOpen`,
  `tasksOverdue`, `taskTokens`, `kindCounts`, `skillExtraction`, `lastSkillExtract`; the
  panel state adds `tasks/tasksOpen/tasksOverdue`, the standalone page renders a
  「待办（open task）」 section with done/drop buttons (`taskDone` / `taskDrop` actions),
  and its latest-report picker ignores `*-mental-model.md` / `*-skill-task.md` task files.

### Changed
- The injected block is now rendered once per injection epoch (see `injectionMode`);
  L1 rows and the due threshold no longer re-render every turn. `buildInjection` still
  keeps L0 and the C1 nudge real-time.
- `memory_save` accepts `kind` (`fact` default, `skill`) and `sources`; `task` entries can
  only be created through `memory_task`. Frontmatter: `kind`, `task_status`, `due_at`,
  `done_at`, `priority`, `note`, `sources`.
- Dream phases and consolidation now skip non-fact material: `task` / `skill` entries are
  neither merged nor decayed, and Phase 4 / Phase 6 materials only pick facts.
- `memory_dream` returns `skillExtraction {enabled, due, taskFile, completedCount}` and its
  report may include the `🧠 Phase 6 · Skill 提炼` section.

### Fixed
- **Whole-block hard budget guard.** The v0.8 builder could exceed `budgetTokens` because
  of fixed text overhead (header, footer rules, threshold line); v0.9 renders the block
  and trims L1 lines from the end until `estTokens(block) ≤ budgetTokens`. Caveat: when
  `profileTokens` is close to `budgetTokens` (e.g. 550/600) the fixed text can still
  overshoot; keep `profileTokens ≤ budgetTokens − 150` (the default 600/200 holds in
  testing).
- **Secret hygiene for task notes (v0.9.0 polish).** `memory_task` checks `note` on both
  `add` and `done` against `SECRET_RE`; a hit returns `secret_refused` instead of writing
  the secret to disk (notes are also embedded in Phase 6 task materials).
- **`sources` filtering and NOOP merge (v0.9.0 polish).** `memory_save` drops
  secret-looking `sources` values before persisting; the NOOP (exact duplicate) branch
  writes no content but still merges the new `sources` into the existing entry and returns
  them, so provenance is not lost.
- **Panel budget bar follows config (v0.9.0 polish).** It now uses `budget` from the panel
  state instead of a hardcoded 600, so custom `budgetTokens` renders correctly.
- Injection rebuild counters are monotonic inside a process: mutating-tool `withLock` →
  `load()` re-reads `stats.json` but no longer resets `injectionRebuilds` /
  `lastInjectionRebuild` (the newest rebuild wins).

### Design notes
- The cache contract is explicit now: the system prompt may only change on semantic
  events (dream, consolidate, profile rewrite, day boundary) — never per turn or per
  counters. v0.8.1 removed the per-turn churn; v0.9-A makes the remaining freeze
  explicit and observable.
- Snapshot replay on restart: the on-disk snapshot is restored on `load()`, so a clean
  restart does not change the rendered block; a new-session invalidation re-renders the
  same text, keeping the provider prefix cache warm (the local rebuild count may bump).
- Todo block is intentionally *outside* the snapshot: adding/completing a task is an
  explicit user action, and the block stays small and bounded (`taskTokens`); the
  whole-block guard still trims the frozen L1 rows if the combination would overflow.
- **Phase 6 follows the Phase 4 split:** the plugin only judges due-ness, prepares
  materials and stamps `lastSkillExtract`; an isolated subagent does the extraction; the
  main agent persists via `memory_save(kind='skill', sources=…)`. The plugin never calls
  an LLM.
- **`sources` is a pointer, not a graph:** ids are not validated (they may point at
  archived entries), no traversal is done, and the list is capped at 5.
- **Known limitation:** Phase 3 · REM still builds `links` for task/skill entries. Links
  are never injected and don't touch the token budget, so this only affects the L2 data
  structure; a kind filter can be added later.
- **C1 stays real-time** (not frozen in the snapshot): its text is day-granular and only
  changes on a dream, a day boundary, or crossing `dreamAfterHours`. Residual mid-session
  prefix flips are a completed dream and the threshold crossing; the v0.10
  `reminderDelivery: 'tail'` option (see `docs/DSH-APPEND-INJECTION.md`) is the alternative
  to freezing C1.
- Tests: 166 assertions — snapshot modes (session/daily/live, day-boundary rebuild,
  restart reuse, rebuild reasons/counters), hard-budget pressure (30 long titles), kind
  migration and no-downgrade, todo lifecycle/injection/overflow + `done` note append,
  Phase 6 due/task-file/materials/`lastSkillExtract`/disabled, sources round-trip/union/
  NOOP merge/secret filter, note secret refusal, dream material exclusions, budget
  integration, panel todo routes + configurable budget, plus all previous suites green.

## [0.8.1] — 2026-10-26

### Fixed
- **KV-prefix-cache churn in the injected block.** The C1 dream nudge used to
  print `距上次做梦 N 小时 · 新增对话 M 条`, so while a dream was overdue the
  system-prompt prefix changed on *every* turn (each captured message bumped the
  counter) and invalidated the whole prompt cache each request. The reminder is
  now day-stable: `欠梦（上次整理 2026-10-24）→ 建议先 memory_dream…` — it only
  changes when a dream actually runs.
- **Per-item `⏰` markers removed from the hot index.** A `memory_search` /
  `memory_read` reinforcement could flip a marker and rewrite the prefix; the
  hot index is now purely `★` / `·`, and due reviews are signalled by one
  threshold line (`> ⏰ 有记忆到期该复习…`) that only appears or disappears.
- Tests: 69 assertions — added byte-identical-render and no-per-turn-counter
  assertions.

## [0.8.0] — 2026-10-25

### Added
- **Mental model: L0 profile auto-rewrite, subagent-driven.** `buildDream` gained
  **Phase 4 · Mental model**: when `stats.lastProfileRewrite` is missing or older
  than `mentalModelEveryDays` (default 7 days), it writes
  `dream/YYYY-MM-DD-mental-model.md` containing the current profile, the 20 most
  recent active memories (`id` / title / tags / 200-char excerpt), the last 3
  dream-report summaries, and the rewrite instructions for the subagent. The dream
  report gains a `🧠 Phase 4 · Mental model` section (`画像到期：是/否` + task path).
- `memory_profile_archive` tool: copies the current `profile.md` to
  `profile-history/YYYYMMDD-HHmmss.md` before a rewrite (rollback history).
- `memory_profile_save` now **hard-clamps** content to `profileTokens` with the new
  `clampToBudget` (binary-search prefix cut, budget guaranteed including the
  truncation marker) and records `stats.lastProfileRewrite` /
  `stats.profileRewrites`, so the next dream can judge due-ness.
- `memory_dream` returns `mentalModel {enabled, due, everyDays, lastRewrite,
  daysSince, taskFile}`; `memory_stats` adds `mentalModel`, `lastProfileRewrite`,
  `profileRewrites`, `profileRewriteDue`, `mentalModelEveryDays`, `profileTokens`.
- Panel API (`/memory-fish/api/state`) exposes `lastProfileRewrite`,
  `profileRewrites`, `profileDue`; the panel shows the last rewrite date.
- Config: `mentalModel` (default `true`), `mentalModelEveryDays` (default `7`);
  new data directory `profile-history/`.
- Tests: 64 assertions — Phase 4 due / not-due / disabled, task-file contents,
  archive equality, hard truncation, rewrite timestamp (all previous tests green).

### Design notes
- The rewrite itself runs in an **isolated subagent** that reads the task file, so
  the main context pays almost nothing; the plugin never calls an LLM. The plugin's
  job is only due-ness + materials + disk I/O.
- Only L0 changes: L1/L2 memories are never touched, old profiles are archived and
  therefore rollback-able.

## [0.7.0] — 2026-10-25

### Added
- **Dream reminder (C1)** — no scheduler dependency, no session-event writes.
  `buildInjection` now computes whether a dream is due (`dreamAfterHours`, default
  24) or memories are due for review, and appends a two-line `### 睡梦` nudge to
  the injected block. Zero cost when nothing is due; nothing to initialize on
  install or clean up on uninstall.
- Config: `dreamReminder` (default `true`), `dreamAfterHours` (default `24`).
- `stats.capturedSinceDream` tracks new journal records since the last dream and
  resets after `memory_dream`.
- Tests: reminder appears when due, disappears after a dream (51 assertions).

### Branding
- New mark: a chubby fish whose body is a memory core — three memory strata,
  a small neural net, RAM-style belly pins, and a puzzle-piece dorsal fin for
  "plugin". Deliberately not the DeepSeek whale.
- `docs/logo.png` (with background), `docs/logo-transparent.png`,
  `docs/banner.png` (1280×640 social preview), `icon.svg` (plugin icon),
  regenerable with `python docs/make-art.py`.

## [0.6.0] — 2026-10-25

### Changed
- **Split the single-file implementation into modules** under `lib/`:
  `config`, `util`, `store`, `inject`, `core`, `dream`, `panel`, `tools`, `lock`, `log`.
  Entry point is now `index.mjs`. No behavior change intended.
- `package.json`: `engines`, `scripts`, `repository`/`homepage`/`bugs` metadata,
  `files` whitelist, English description, version bump.

### Added
- **Secret redaction for journal capture** (`redactSecrets`): message text is
  filtered before it is appended to `journal/*.jsonl`, both at the call site and
  inside `Store.appendJournal`. `[REDACTED]` marker on hit.
- **Cross-process write lock** (`lib/lock.mjs`): mutating tools acquire
  `<dir>/.index.lock`, break stale locks after 15 s, time out after 5 s.
  Mutating tool calls also re-read the index under the lock.
- **Optional debug logging** (`lib/log.mjs`, config `debug: true`) to
  `<dir>/debug.log`, 1 MB rotation, no-op by default.
- **Config normalization** (`resolveConfig`): unknown keys ignored, numeric
  fields coerced, `debug` added.
- `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, `.gitignore`, CI workflow,
  English README.
- Tests: journal redaction, lock release, P3 temporal assertions (46 total).

### Fixed
- `memory_search` no longer returns values with `undefined` fields (lossless JSON).
- Historical versions are excluded from spaced-repetition reinforcement.

## [0.5.0] — 2026-10-25

### Added
- **Temporal validity (P3)**: `validFrom` / `validTo` / `history` per memory.
  Same-topic updates seal the previous version into history (max 10).
- `memory_search({ asOf })` returns the version valid at that point in time;
  default searches only current versions. Historical matches carry
  `historical: true` and are not reinforced.
- Migration for pre-0.5 entries.

## [0.4.0] — 2026-10-25

### Added
- **Three-stage sleep (P0)**: SWS replay/compression, SHY salience-weighted
  decay, REM associative links. Report includes all three phases.
- **Spaced repetition (P1)**: `stability`, `lastReview`, `nextReview`, `reviews`.
  Search reinforces ×1.3, read ×1.1; due items marked `⏰` and listed in the
  dream report.
- **Salience + novelty gate (P2)**: automatic 0–10 salience score, NOOP above
  0.92 similarity, update between 0.75 and 0.92, insert below 0.75.
- L1 hot index capped at 12 lines (working-memory calibration).

## [0.3.0] — 2026-10-25

### Added
- Client plugin: a **「小肥鱼记忆」 section in DSH Settings** (React panel).
  Standalone `/memory-fish/panel` page kept as fallback.

## [0.2.0] — 2026-10-25

### Added
- **Auto-capture** of user/assistant messages into `journal/YYYY-MM-DD.jsonl`
  (never injected; 30-day retention; subagent sessions skipped).
- **Sleep mechanism (`memory_dream`)**: reviews the journal, extracts
  candidate memories via cue words, writes `dream/YYYY-MM-DD.md`.
- **Visual panel** at `/memory-fish/panel` with budget bar, profile editor,
  search, pin/forget, dream/consolidate, reports.
- Host routes with same-origin guard.

## [0.1.0] — 2026-10-25

### Added
- Initial release: L0–L3 layered memory, 600-token injection budget,
  write-time dedupe, decay/archival, secret refusal, nine tools,
  Markdown/JSON storage, Settings-free first version.
