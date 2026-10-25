# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

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
