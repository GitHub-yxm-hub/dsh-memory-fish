# Publishing & distribution guide

Copy-paste material for releasing `dsh-memory-fish` and listing it in the DSH
ecosystem. Nothing here requires modifying the plugin itself.

> Status (2026-10-26): repo **v0.10.0**; **npm `latest` = 0.10.0**（2026-10-26 发布，
> tarball shasum `7cbfc216…`）。0.8.x / 0.9.0 未发布（直接跳过）。后续发版的 tag / push /
> publish / 2FA 仍由维护者本地执行；agent 会话不要执行 publish。

## 0. Pre-flight

```bash
cd projects/memory-fish
npm test              # 204 assertions must pass
node --check index.mjs
git status            # working tree clean
```

Then, as the maintainer:

```bash
git tag -a v0.10.0 -m "v0.10.0 — skill library (memory_skill), cache-safe reuse hint, skill revisions"
git push origin main --tags
```

Optional: set the repository social preview to [`docs/banner.png`](../docs/banner.png)
(GitHub → Settings → General → Social preview).

Repository topics (Settings → General → Topics):

```
dsh, dsh-plugin, deepseek-harness, memory, local-first, token-budget,
spaced-repetition, sleep-consolidation, ai-agent, markdown
```

## 1. GitHub Release

- Tag: `v0.10.0`
- Title: `dsh-memory-fish v0.10.0`
- Body: paste the `[0.10.0]` section from [`../CHANGELOG.md`](../CHANGELOG.md)
  (the older `.github/RELEASE_NOTES_v0.7.0.md` is a format reference only)
- Attach (optional): `dsh-memory-fish.bundle` is **not** needed; the repo is self-contained.

## 2. npm

Publishing requires the maintainer's npm account (and a 2FA/OTP code if enabled on
the account). Run it yourself — not from an agent session.

```bash
npm login            # browser device flow; needs your npm account (+ 2FA if enabled)
npm publish          # package.json already has publishConfig.access = "public"
npm view dsh-memory-fish version   # should print 0.10.0 after publishing
```

Current registry state (2026-10-26): `npm view dsh-memory-fish version` still reports
`0.7.0`; 0.8.x, 0.9.0 and 0.10.0 are **not published yet**. The name was unclaimed when
checked on 2026-10-25; if it has since been taken, rename to a scoped package (e.g.
`@your-name/dsh-memory-fish`) and update `cordis.patch.yml` + README install commands.

## 3. Plugin marketplaces / directories

Short blurb (EN, ~220 chars):

> Context-budgeted memory for DeepSeek Harness: fixed ~600-token injection frozen into
> cache-friendly snapshots, three-stage sleep consolidation, spaced repetition, temporal
> validity, typed memories (fact/skill/task), lightweight todos and a searchable skill
> library with revision history. Local files, zero deps.

Short blurb (中文):

> 小肥鱼记忆插件：注入上下文恒定 ~600 tokens 且缓存友好（注入快照），三阶段睡眠整理、
> 间隔重复、时间有效性，记忆分事实/技能/待办三类，带待办任务与可检索、可修订的技能库；
> 纯本地文件、零依赖。

Longer description: reuse the "Why" + "Features" sections of
[`../README.en.md`](../README.en.md).

Submission targets:

| Directory | How |
|---|---|
| **awesome-dsh-plugin** | Open a PR adding one bullet under the memory section: `[dsh-memory-fish](https://github.com/GitHub-yxm-hub/dsh-memory-fish) — context-budgeted local memory with cache-friendly injection, sleep consolidation, spaced repetition, temporal validity, typed memories (fact/skill/task) and a searchable skill library.` |
| **dshbase.com** | Submit via the site's "submit plugin" form; paste repo URL + short blurb + banner. |
| **dshplugin.online** | Same: repo URL, tags (`memory`, `local-first`), blurb, banner. |
| **DeepSeek Harness discussions** | Post in the "show your plugin" / memory discussion (#14 is the recurring "求一个 memory 能力" thread). |

Suggested screenshot: run DSH, open **Settings → 小肥鱼记忆** (or
`/memory-fish/panel`), capture the budget bar, hot index, todos block and dream section;
a `memory_skill search` result makes a good second screenshot.
Save as `docs/panel.png` and reference it in the README.

## 4. Post-release checklist

- [ ] `v0.10.0` tag pushed and GitHub Release published
- [ ] CI green on `main` (Actions tab)
- [ ] npm: `npm view dsh-memory-fish version` → `0.10.0`
- [ ] npm install works on a clean profile: `dsh plugin --profile web add dsh-memory-fish`
- [ ] README renders: banner, English/Chinese links, badges (npm badge flips to 0.10.0)
- [ ] Marketplace listings live
- [ ] Announce with a short post: what problem it solves + the 600-token promise
