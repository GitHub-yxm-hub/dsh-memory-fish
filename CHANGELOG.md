# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

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
