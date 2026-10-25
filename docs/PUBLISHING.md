# Publishing & distribution guide

Copy-paste material for releasing `dsh-memory-fish` and listing it in the DSH
ecosystem. Nothing here requires modifying the plugin itself.

## 0. Pre-flight

```bash
npm test              # 49 assertions must pass
git status            # working tree clean
git tag -fa v0.7.0 -m "v0.7.0 — C1 dream reminder, open-source ready"   # tag the metadata commit
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

- Tag: `v0.7.0`
- Title: `dsh-memory-fish v0.7.0`
- Body: paste [`../.github/RELEASE_NOTES_v0.7.0.md`](../.github/RELEASE_NOTES_v0.7.0.md)
- Attach (optional): `dsh-memory-fish.bundle` is **not** needed; the repo is self-contained.

## 2. npm

```bash
npm login            # browser device flow; needs an npm account
npm publish          # package.json already has publishConfig.access = "public"
```

Name check (2026-10-25): `dsh-memory-fish` was unclaimed on the public registry.
If it has since been taken, rename to a scoped package, e.g.
`@your-name/dsh-memory-fish`, and update `cordis.patch.yml` + README install
commands accordingly.

## 3. Plugin marketplaces / directories

Short blurb (EN, ~160 chars):

> Context-budgeted memory for DeepSeek Harness: fixed ~600-token injection,
> three-stage sleep consolidation, spaced repetition, temporal validity. Local
> files, zero dependencies.

Short blurb (中文):

> 给小肥鱼记忆插件：注入上下文恒定 ~600 tokens，三阶段睡眠整理，间隔重复，
> 时间有效性；纯本地文件、零依赖。

Longer description: reuse the "Why" + "Features" sections of
[`../README.en.md`](../README.en.md).

Submission targets:

| Directory | How |
|---|---|
| **awesome-dsh-plugin** | Open a PR adding one bullet under the memory section: `[dsh-memory-fish](https://github.com/GitHub-yxm-hub/dsh-memory-fish) — context-budgeted local memory with sleep consolidation, spaced repetition and temporal validity.` |
| **dshbase.com** | Submit via the site's "submit plugin" form; paste repo URL + short blurb + banner. |
| **dshplugin.online** | Same: repo URL, tags (`memory`, `local-first`), blurb, banner. |
| **DeepSeek Harness discussions** | Post in the "show your plugin" / memory discussion (#14 is the recurring "求一个 memory 能力" thread). |

Suggested screenshot: run DSH, open **Settings → 小肥鱼记忆** (or
`/memory-fish/panel`), capture the budget bar, hot index and dream section.
Save as `docs/panel.png` and reference it in the README.Settings panel screenshot.

## 4. Post-release checklist

- [ ] GitHub Release published from `v0.7.0`
- [ ] CI green on `main` (Actions tab)
- [ ] npm package installs: `dsh plugin --profile web add dsh-memory-fish` on a clean profile
- [ ] README renders: banner, English/Chinese links, badges
- [ ] Marketplace listings live
- [ ] Announce with a short post: what problem it solves + the 600-token promise
