# 小肥鱼记忆 · dsh-memory-fish

![banner](https://raw.githubusercontent.com/GitHub-yxm-hub/dsh-memory-fish/main/docs/banner.png)

[![npm](https://img.shields.io/npm/v/dsh-memory-fish.svg)](https://www.npmjs.com/package/dsh-memory-fish)
[![CI](https://github.com/GitHub-yxm-hub/dsh-memory-fish/actions/workflows/ci.yml/badge.svg)](https://github.com/GitHub-yxm-hub/dsh-memory-fish/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> 上下文成本恒定的本地记忆插件。记忆可以无限长，注入永远只有 ~600 tokens。
> 它会睡觉、会复习，也记得住"上个月我们用的什么方案"。

[English](./README.en.md) · [设计](./DESIGN.md) · [调研](./RESEARCH.md) · [更新日志](./CHANGELOG.md) · [安全](./SECURITY.md)

## 它解决什么

现有记忆插件的通病：记忆越多 → 索引越长 → 每次会话注入越多 → 又贵又慢。

小肥鱼记忆把「存储」和「注入」拆开：

| 层 | 内容 | 注入 | 预算 |
|---|---|---|---|
| L0 画像 | 你是谁、偏好、硬约束（v0.8 起自动重写） | 每次会话 | ≤200 tok |
| L1 热索引 | 置顶 + 最近 10–20 条标题 | 每会话（v0.9 快照冻结） | ≤400 tok（有待办时让出最多 100） |
| L2 温记忆 | 完整正文 | 按需工具读取 | 0 |
| L3 冷档案 | 压缩前原文、被替代版本 | 从不注入 | 0 |

记住 10 条和记住 1000 条，注入成本一样。v0.9 起注入块还会冻结成**缓存友好的快照**（重启可复用），记忆也分成 事实 / 技能 / 待办 三类——另有一小块「待办」实时注入，最多 5 行，预算 `taskTokens`（默认 100，从 600 里扣）。

## 防膨胀机制

- **写入即去重**：字符 bigram Jaccard ≥ 0.75 判定同主题，原地更新，旧版本进冷档案
- **规则压缩**：`memory_consolidate` 合并近似条目（不调 LLM，零额外 token）
- **衰减归档**：60 天未更新、未置顶、低重要度 → 归档（可检索，不删除）
- **硬预算**：整块注入 ≤ `budgetTokens`（v0.9 起是整块硬守卫，正文固定开销不再把注入撑爆）；待办块另受 `taskTokens` 约束
- **缓存稳定**（v0.8.1 起）：注入文本只在语义事件时变化，不因时间流逝或每轮计数而变

## v0.2 新功能

### 自动捕获（默认开）
每次会话的 user / assistant 消息自动追加到 `journal/YYYY-MM-DD.jsonl`（L3 原始层，**永不注入**，单条最多 4000 字符）。子代理会话默认跳过。捕获只是落盘，不产生任何上下文成本。

### 睡梦机制
每天 23:30 定时触发（也可手动 `memory_dream`）：
1. 回顾最近 N 天的全部对话 journal
2. 按线索词（记住/我喜欢/统一用/以后都/约定…）提炼候选，相似候选自动去重
3. 生成 `dream/YYYY-MM-DD.md` 报告
4. Agent 逐条判断后 `memory_save` 值得留下的，再 `memory_consolidate`

### 可视化面板
宿主 webServer 上的本地页面：`/memory-fish/panel`
- 注入 token 预算条、活跃/归档/置顶/今日对话/候选线索卡片（v0.9 起还有待办卡与注入重建观测）
- 画像编辑、记忆搜索、置顶/遗忘
- 一键「现在做梦」「整理记忆」、查看最近睡梦报告
- v0.9-B 起独立面板有「待办（open task）」区块，可完成 / 丢弃

同源校验：拒绝跨站请求（Origin/Host/Sec-Fetch-Site），只允许 localhost / 本机 IP。

## v0.4 生理学调优（P0/P1/P2）

### 三阶段睡眠（P0）
`memory_dream` 现在按睡眠分期跑完整流程：
1. **SWS 慢波**：重放 journal，合并相似记忆（原文进 archive）
2. **SHY 稳态**：按显著性加权衰减，长期低分记忆降级归档
3. **REM**：为共享标签/相似的记忆建立「相关链接」，不改内容

报告写到 `dream/YYYY-MM-DD.md`，包含三阶段明细 + 待复习清单 + 候选记忆。v0.8 起还有 **Phase 4 · Mental model**（见下）。

### 睡梦提醒（C1：不依赖宿主调度器）
插件**不创建任何定时任务**，也不写宿主的 session 事件日志。它只在注入块里按需提醒：

```
### 睡梦
- 欠梦（上次整理 2026-10-24）→ 建议先 memory_dream 做三阶段整理
```

文案是**日粒度**的（v0.8.1 起不写小时数/新增条数，避免欠梦期间每轮注入都变、把前缀缓存刷掉）。

判断条件：`dreamReminder: true`（默认）且（距上次做梦 ≥ `dreamAfterHours`（默认 24）**或**有到期复习），并且确实有新对话或复习项。没有就完全不出现，零 token 成本。

好处：新会话也有效、卸载后零残留、不依赖 `dsh-schedule` 的内部协议。

### 间隔重复（P1）
每条记忆维护 `stability`（能记多久）、`nextReview`（下次复习日）、`reviews`：
- 新记忆按重要度给初始稳定性（约 8–13 天）
- `memory_search` / `memory_read` 命中即加固（稳定性 ×1.3 / ×1.1），这就是提取练习效应
- 到期条目由注入块里的一行阈值文案提示（v0.8.1 起不再逐条标 `⏰`，睡眠报告里仍列成待复习清单）

### 显著性 + 新颖性门控（P2）
- 写入时自动打分（0–10）：明说「记住」+4、纠正 +2、绝对化措辞 +1、新颖度 +0~2、置顶 +1
- 相似度 ≥0.92 → **NOOP**：完全重复不写，只记一次复习
- 0.75–0.92 → 原地更新；<0.75 → 新增

## v0.5 时间有效性（P3）

每条记忆带有效期：`validFrom` / `validTo`，同主题内容变化时：

- 旧版本封存进 `history`（含自己的 validFrom → validTo），当前版本换新有效期
- `memory_search` 默认只返回**当前有效**版本
- `memory_search({ asOf: "2026-09-15" })` 按时间点查当时有效的版本 —— 能回答"上个月我们用什么方案"
- 历史版本不参与复习加固，避免旧事实被强化

## v0.8 Mental model：L0 画像自动重写

L0 画像是决定"agent 怎么和你说话"的那 200 tokens。手写会过期，全自动又容易跑偏，所以 v0.8 把工作拆成三段：

1. **插件判断到期**：`memory_dream` 的 Phase 4 检查 `stats.lastProfileRewrite`，超过 `mentalModelEveryDays`（默认 7 天）或从未重写过，就算到期
2. **插件准备材料**：写 `dream/YYYY-MM-DD-mental-model.md`，内含当前画像、最近 20 条活跃记忆（id / 标题 / 标签 / 正文前 200 字）、最近 3 天睡梦摘要，以及给 subagent 的指令
3. **subagent 重写**：主 agent 先 `memory_profile_archive` 归档旧画像，再用 `subagent` 读任务文件、写出 ≤200 tokens 的新画像并返回（独立上下文，主上下文几乎零成本），最后校验长度/密钥 → `memory_profile_save` 落盘，`stats.lastProfileRewrite` 自动更新

睡梦报告里会多一节：

```
## 🧠 Mental model（Phase 4 · L0 画像自动重写）
- 画像到期：是 → 任务文件：~/.dsh/memory-fish/dream/2026-10-25-mental-model.md
```

为什么不是插件自己调 LLM（插件没有 LLM 依赖，也不该引入 token 成本），也不是主会话自己写（要读大量记忆，主上下文太贵）—— 这是 DSH 的能力边界决定的：插件跑在 host 进程里不能 spawn subagent，只有 agent 轮次能调 `subagent`。

安全边界：
- 只改 L0，**绝不删除或覆盖 L1/L2 记忆**
- 旧画像先归档到 `profile-history/`，随时可回滚
- `memory_profile_save` 内置密钥拦截 + `clampToBudget` 硬截断，画像永远不会撑爆 200 token 预算

## v0.9 缓存友好注入与记忆类型

### 为什么在意「缓存」

system prompt 是每个请求的最前缀。它每变一个字节，服务商的 **KV 前缀缓存**就整段失效，长会话要重新 prefill 全部历史——一次 miss 可能比多注入几百 token 还贵。

所以 v0.8.1 先把注入块改成**字节稳定**：C1 欠梦提醒只到「天」粒度（不写小时数/新增条数）、去掉逐条 `⏰` 标记、到期改一行阈值文案。v0.9 在此基础上再进一步：把 L1 热索引冻结成显式的「注入快照」。

### v0.9-A：注入快照 `injectionMode`

| 模式 | 行为 | 适合 |
|---|---|---|
| `session`（默认） | 每个会话构建一次，会话内不变；新会话 / 做梦 / 整理时失效重建 | 长会话，最大化缓存命中 |
| `daily` | 每天第一次注入时重建 | 一天开很多会话，想每天看到新索引 |
| `live` | 每次注入实时重建（= 0.8 的行为） | 测试、调试、短会话 |

- 快照落盘在 `<dir>/injection-cache.json`，重启后可复用；即便因新会话事件触发一次重建，渲染出的文本也保持不变，前缀缓存仍然命中
- 失效原因可见：`init` / `session` / `day` / `dream` / `consolidate`
- 观测：`memory_stats` 的 `injectionMode` / `injectionRebuilds` / `lastInjectionRebuild{at,reason,day}` / `injectionCacheDay`；面板显示重建次数与最近原因
- 冻结范围是 **L1 热索引行 + 「有记忆到期」阈值**；L0 画像和 C1 提醒仍实时（画像改动立即生效；C1 文案是日粒度、不含计数，只在事件/日界/跨过欠梦阈值时变化）
- 整块硬预算守卫：`estTokens(注入块) ≤ budgetTokens`，超出从 L1 末尾逐行裁剪

### v0.9-B：记忆类型与待办

`kind` 把记忆分三类：

| kind | 是什么 | 进热索引 | 参与间隔复习 | 参与合并/衰减 | 进待办块 |
|---|---|---|---|---|---|
| `fact`（默认） | 事实、偏好、决策、排障结论 | 是 | 是 | 是 | 否 |
| `skill` | 从任务闭环里提炼的技能/套路 | 否 | 是（只读时加固） | 否（v0.9-C 起） | 否 |
| `task` | 待办任务 | 否 | 否 | 否 | 是（open） |

新工具 `memory_task`（工具数 11 → 12）：

| action | 作用 |
|---|---|
| `add` | 建任务：`title` / `content` / `dueAt`（`YYYY-MM-DD` 本地日）/ `priority`（1–5，默认 3）/ `note`；同主题 open 任务相似度 ≥0.75 会原地合并更新 |
| `done` | 标记完成（只能对 open 操作），记录 `doneAt` |
| `drop` | 丢弃（只能对 open 操作） |
| `list` | 按 逾期 → `dueAt` → `priority` 排序，附 `remaining`（剩余 open 摘要） |

所有写操作都返回 `remaining`，形成「做完看还剩什么」的闭环。

注入块在画像之后、热索引之前新增「### 待办」（**实时**渲染，不走 L1 快照）：

```text
### 待办
- ⏰ 10-20 升级 Node 版本
- · 10-28 写 v0.9 验收报告
- · 清理桌面临时文件
- …另有 2 个（memory_task list）
```

规则：

- 只列 open task，最多 5 行；超出显示 `- …另有 N 个（memory_task list）`
- 逾期用 `⏰ MM-DD`，有截止用 `· MM-DD`，无截止用 `· 标题`
- 块本身受 `taskTokens`（默认 100）约束，超长标题会被裁；这部分预算从 L1 可用预算里扣
- 有待办时 footer 多一行 `> 完成待办后用 memory_task done 标记，并查看剩余。`
- task 不参与记忆去重（只和 open task 比）、不参与间隔复习、不参与衰减归档、不进热索引

其它配套：

- `memory_list` 支持 `kind: fact | skill | task` 过滤（默认 all）
- `memory_search` / `memory_read` / `memory_list` 结果带 `kind` / `taskStatus` / `dueAt` / `sources`
- `memory_stats` 增加 `tasksOpen` / `tasksOverdue` / `taskTokens` / `kindCounts` / `skillExtraction` / `lastSkillExtract`
- 独立面板新增「待办（open task）」区块，可一键完成 / 丢弃
- frontmatter 增加 `kind:` / `task_status:` / `due_at:` / `done_at:` / `priority:` / `note:`；旧数据自动迁移成 `fact`

### v0.9-C：技能提炼与轻量溯源

**skill 类型**：`memory_save({ kind: 'skill' })` 落库。skill 不进热索引、不进待办块，也不参与 dream 的 SWS 合并 / SHY 衰减和 `memory_consolidate` 的合并归档——它是提炼产物，去留由显式操作决定。同主题更新时 **kind 不降级**：skill 不会被 fact 覆盖，fact → skill 可以升级。

**sources 轻量溯源**：`memory_save` 新增可选 `sources`（task / memory id 数组，自动去重，最多保留 5 个）；更新已有条目时与旧值取并集、保留最近 5 个。落进 frontmatter `sources:`，`memory_read` / `memory_search` / `memory_list` 都会返回。它只是"这条记忆从哪来"的指针，不做图遍历。

**dream Phase 6 · Skill 提炼**：`memory_dream` 检查「自上次提炼（`stats.lastSkillExtract`）之后新完成的 task」（只看 `status=active` 的 done task）：

- **有** → 生成 `dream/YYYY-MM-DD-skill-task.md`，材料包括：
  - 最近完成的任务 ≤10 条（id / 标题 / 内容 / 备注 / 完成时间）
  - 相关活跃 fact 记忆 ≤15 条（任务标签共现优先，其次最近更新）
  - 最近 3 天睡梦摘要
  - 给 subagent 的提炼指令（提炼 1–3 条，`TITLE:` / `SKILL:` / `TAGS:` / `SOURCES:` 格式，≤200 tokens/条）
- 报告增加 `## 🧠 Phase 6 · Skill 提炼`：`技能提炼：是 → 任务文件：…` 或 `技能提炼：否（无新完成的待办任务…）`
- 主 agent 用 subagent 按任务文件提炼，再逐条 `memory_save(kind='skill', sources=[task id])` 落盘
- 只有**实际生成**任务文件才更新 `stats.lastSkillExtract`，避免每晚重复生成；`skillExtraction: false` 关闭后报告整节不出现
- dream 的其它材料（SWS 合并、SHY 衰减、Phase 4 画像）同样只看 fact，task / skill 不参与

设计细节见 [DESIGN.md](./DESIGN.md) 的「v0.9 缓存契约与记忆类型」；尾部注入（append sourced `user/message`）可行性调研见 [docs/DSH-APPEND-INJECTION.md](./docs/DSH-APPEND-INJECTION.md)（结论：v0.9 不搬，v0.10 可选）。

## 工具（12 个）

插件注册 12 个模型工具（写操作串行加锁）：

| 工具 | 作用 |
|---|---|
| `memory_save` | 保存/原地更新（自动去重、拒存密钥）；`kind` 可选 `fact`（默认）/ `skill`；`sources` 溯源 id（≤5，更新取并集） |
| `memory_search` | 本地关键词检索（含归档，可选）；结果带 `kind` / `taskStatus` / `dueAt` / `sources` |
| `memory_read` | 读全文（>4000 字符截断）；带 `kind` / `sources`；task 不触发复习加固 |
| `memory_list` | 最近记忆；`kind` 可按 fact / skill / task 过滤；带 `sources` |
| `memory_task` | 待办：add / done / drop / list（v0.9-B） |
| `memory_pin` | 置顶/取消（置顶不参与衰减） |
| `memory_forget` | 软删除 + 墓碑 |
| `memory_profile_save` | 写 L0 画像（超长硬截断、拒密钥，记录重写时间） |
| `memory_profile_archive` | 归档当前画像到 `profile-history/`（重写前调用，可回滚） |
| `memory_dream` | 睡梦：三阶段 + Phase 4 画像重写 + Phase 6 技能提炼任务 |
| `memory_stats` | 注入 token / 条数 / 磁盘占用 / 注入重建 / 待办与类型构成 / skill 提炼观测 |
| `memory_consolidate` | 手动整理（dry-run 可选；task / skill 不参与） |

## 数据位置

```
~/.dsh/memory-fish/
├── profile.md           # L0（≤200 tok，常驻注入）
├── profile-history/     # v0.8：每次重写前的旧画像快照，可回滚
├── index.json           # 元数据索引（可重建）
├── memories/            # L2：每条一个 Markdown（含 kind/task frontmatter）
├── archive/             # L3：旧版本、被替代、被遗忘的原文
├── journal/             # 自动捕获的原始对话（按天 jsonl，永不注入）
├── dream/               # 睡梦报告（按天 md）+ 画像重写任务（*-mental-model.md）+ 技能提炼任务（*-skill-task.md）
├── injection-cache.json # v0.9：L1 注入快照（重启复用；删掉只会重建一次）
└── stats.json           # 计数（含 lastProfileRewrite / injectionRebuilds / lastSkillExtract）
```

全部人类可读、可 git、可手改。索引丢失会从 `memories/*.md` 自动重建。

## 安装

注册进 DSH profile：

1. 把本目录复制到 `<profile>/node_modules/dsh-memory-fish/`
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 加入 `"dsh-memory-fish"`，
   并在 `dependencies` 加入 `"dsh-memory-fish": "file:projects/memory-fish"`
3. 重启 DSH（或等待 profile 热加载）

## 配置

配置写在 profile 的 `cordis.patch.yml`：

```yaml
- id: memory-fish
  config:
    budgetTokens: 600
    maxHotLines: 12
    injectionMode: session   # v0.9：session | daily | live
    taskTokens: 100          # v0.9：待办块预算（从 600 里扣）
    skillExtraction: true    # v0.9-C：dream Phase 6 技能提炼
    autoCapture: true
```

常用项：`dir`、`budgetTokens`、`profileTokens`、`maxHotLines`、`injectionMode`、`taskTokens`、`skillExtraction`、`archiveAfterDays`、`dedupeThreshold`、`noopThreshold`、`reviewEnabled`、`autoCapture`、`captureMaxChars`、`journalKeepDays`、`dreamDays`、`dreamReminder`、`dreamAfterHours`、`mentalModel`、`mentalModelEveryDays`、`panelPath`、`apiBase`、`debug`。非法 `injectionMode` 会回落 `session`。

## 代码结构

```
index.mjs        插件入口：配置、注入、自动捕获、会话纪元、装配
lib/config.mjs   默认值 + 配置校验（injectionMode 白名单）
lib/util.mjs     token 估算、bigram/Jaccard、显著性、间隔重复、脱敏
lib/store.mjs    Markdown/JSON 存储、journal、归档、迁移、注入快照、任务文件
lib/inject.mjs   画像 + 待办 + 热索引注入块（快照 + 硬预算）
lib/core.mjs     saveMemoryCore（kind/sources）/ taskCore：去重 / 门控 / 版本 / 待办
lib/dream.mjs    三阶段睡眠 + Phase 4 画像重写 + Phase 6 技能提炼
lib/tools.mjs    模型工具（写操作加锁串行）
lib/panel.mjs    本地 HTTP 面板 + API
lib/lock.mjs     跨进程写锁
lib/log.mjs      可选调试日志
client/client.js 设置页面板（浏览器半）
```

## 测试

```bash
npm test   # 164 项断言：捕获、脱敏、保存/去重/NOOP、检索、asOf 历史、
           # 睡眠三阶段 + Phase 4 画像重写 + Phase 6 技能提炼（到期判定/任务文件/
           # 材料上限/lastSkillExtract/关闭）、skill 类型与 kind 不降级、sources 溯源
           # 往返与并集、注入快照三模式（session/daily/live、重启复用、重建原因与计数）、
           # 硬预算压力、kind/待办生命周期与注入、预算整合、注入块字节稳定（缓存友好）、
           # 面板路由/待办按钮、锁释放
```

CI 在 Linux / Windows × Node 22 / 24 上跑。

## 安全

本地优先、无网络。journal 落盘前会脱敏密钥；HTTP 面板仅限 localhost 且有同源校验，但**没有鉴权**——请只在可信机器上运行。详见 [SECURITY.md](./SECURITY.md)。

## 设计

见 [DESIGN.md](./DESIGN.md)。

## License

MIT
