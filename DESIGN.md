# 小肥鱼记忆 · 设计草案 v0.2

> 目标：一个**上下文成本恒定**的轻量本地记忆插件。
> 记忆可以无限增长，但注入上下文的部分永远是固定的一小块。
>
> 作者：铁凝 × 小肥鱼 🐟

---

## v0.9 落地变更 · 缓存契约与记忆类型

> system prompt 在「没有事件发生」时必须一个字节都不变；记忆同时拆成 事实 / 技能 / 待办。

### 1. 缓存契约（为什么注入块必须字节稳定）

服务商按**请求前缀**命中 KV cache。system prompt 是每个请求的最前缀，它改动一个字节，整段前缀缓存就失效，长会话要重新 prefill 全部历史——一次 miss 的成本远高于多注入几十 token。所以「注入块稳定」不是优化项，是设计约束。

| 注入部分 | 允许变化的时机 | 实现 |
|---|---|---|
| L0 画像 | 仅 `memory_profile_save`（人工/subagent 重写） | 实时读取；变化只发生在事件时刻 |
| L1 热索引行 | 仅刷新纪元边界 | v0.9-A 快照冻结（session/daily/live） |
| 到期阈值行 | 仅在「有 / 无到期」翻转时 | 一行布尔文案，不逐条列 |
| C1 睡梦提醒 | 仅在做梦后 / 日界 / 跨过欠梦阈值 | 日粒度文案（无小时数、无新增条数） |
| 「### 待办」块 | 仅在任务增删改时 | 实时渲染（不走快照），由显式操作触发 |
| footer 规则行 | 只在「有无待办」切换时 | 常量文案 |

规则：**注入文本只能因语义事件变化，绝不因时间流逝或每轮计数变化。**

### 2. injectionMode 语义

| 模式 | 快照何时重建 | 失效原因（reason） | 适合 |
|---|---|---|---|
| `session`（默认） | 新会话首步 / 跨本地日 / 做梦后 / 整理后 | init · session · day · dream · consolidate | 长会话，最大化缓存命中 |
| `daily` | 每个本地日首次注入 / 做梦后 / 整理后 | init · day · dream · consolidate | 一天多会话，想每天刷新索引 |
| `live` | 每次注入实时重建 | live（不落盘、不计数） | 测试 / 调试、短会话 |

实现要点：

- 快照结构 `{ day, builtAt, reason, lines, due, cold }`，落盘 `<dir>/injection-cache.json`
- 启动 `load()` 时读回磁盘快照并信任它（前提是没有更早的事件把它标脏）；重启后可复用快照，即使新会话事件触发一次重建，输出文本也不变
- 未完成首次 `load()` 前不缓存（避免把空索引冻住）
- `session` 模式在 `session/event` 里检测**新会话**（忽略 subagent）→ `invalidateInjection('session')`
- 非 `live` 模式跨本地日也会额外重建一次（`reason=day`）：同一会话内跨过日界后，下一次注入会刷新快照
- `memory_dream` / `memory_consolidate` 结束后分别标脏 `dream` / `consolidate`
- 观测：`stats.injectionRebuilds`（进程内单调不减）、`stats.lastInjectionRebuild{at,reason,day}`，由 `memory_stats` 与面板 state 暴露
- 整块硬预算：`estTokens(注入块) ≤ budgetTokens`，超出从 L1 末尾逐行删（正文固定开销不再导致越界）。**caveat**：`profileTokens` 接近 `budgetTokens` 的极端配置（如 550/600）固定文案开销仍可能略超，建议 `profileTokens ≤ budgetTokens − 150`（默认 600/200 实测成立）

### 3. kind：事实 / 技能 / 任务

| kind | 来源 | 热索引 | 待办块 | 间隔复习 | SWS 合并 / SHY 衰减 / consolidate | 去重比较 |
|---|---|---|---|---|---|---|
| `fact`（默认） | `memory_save` | ✅ | — | ✅ | ✅ | 与所有非 task 记忆比 |
| `skill` | `memory_save(kind='skill')` | — | — | ✅（只读加固） | —（v0.9-C 起） | 同上 |
| `task` | `memory_task add` | — | ✅（仅 open） | — | — | 只与 open task 比 |

kind 更新规则（v0.9-C）：同主题更新时 **kind 不降级**——skill 不会被 fact 覆盖，fact → skill 允许升级；新条目按本次 `kind` 落库。

任务生命周期：`open → done | dropped`（单向；`doneAt` 记录时刻）。`memory_task list` 按 逾期 → `dueAt` → `priority` 排序；所有写操作返回 `remaining`，形成「做完看还剩什么」的闭环。

任务字段：`taskStatus`（open / done / dropped）、`dueAt`（本地 `YYYY-MM-DD`，非法输入 `invalid_input`）、`doneAt`、`priority`（1–5，默认 3）、`note`。frontmatter：`kind:` / `task_status:` / `due_at:` / `done_at:` / `priority:` / `note:`；旧数据迁移默认 `fact`，task 缺省字段就地补齐且**不初始化复习字段**。

### 4. 「### 待办」注入块

- 只列 open task；固定最多 5 行，超出 `- …另有 N 个（memory_task list）`
- 格式：逾期 `- ⏰ MM-DD 标题`、有截止 `- · MM-DD 标题`、无截止 `- · 标题`
- 预算 `taskTokens`（默认 100）：块自身超预算时从末尾裁行并累计溢出计数
- 这部分预算从 L1 可用预算里扣（`budgetTokens - profileTokens - 提醒 - 待办`）
- 有待办时 footer 增加 `> 完成待办后用 memory_task done 标记，并查看剩余。`
- 待办块实时渲染 ⇒ 任务变化**不会**重建 L1 快照；两者叠加若超整块预算，由整块硬守卫兜底裁 L1 行

### 5. 尾部 append 调研结论（v0.9 不搬）

调研（详见 [docs/DSH-APPEND-INJECTION.md](./docs/DSH-APPEND-INJECTION.md)）：DSH 有公开 API 在会话尾部 append sourced `user/message`，且不失效 KV 前缀——`agent.inject()` 或 `agent/pre-step` 瀑布监听器 + `createUserMessage()`（官方 `dsh-agent-instructions` 的 `<system-reminder>` 就是这么做的）。

v0.9 的决定：**仍用 system prompt + 快照，不引入 tail 注入**。理由：快照冻结后，会话内残留的翻转点只剩「会话中途做梦」（C1 行消失）、跨日 `daily` 重建各一次，以及极端情况下跨过 `dreamAfterHours` 阈值的一次；收益不足以引入新 API 面、去重状态与 subagent 过滤成本。v0.10 可选 `reminderDelivery: 'inline' | 'tail'`（默认 inline，tail 默认关）。

### 6. skill 提炼与溯源（v0.9-C）

#### 6.1 轻量溯源 `sources`

- `memory_save` 可选 `sources`：字符串 id 数组，去重后保留最近 5 个；落盘为 frontmatter 的 `sources:`（逗号风格）
- 更新已有条目 → 新 id 与旧 `sources` 取并集，再保留最近 5 个
- 疑似密钥值会被过滤（不写盘、不返回）；note 字段（`memory_task` 的 `add` / `done`）命中密钥检测则直接 `secret_refused`
- 完全重复（NOOP）不写正文，但新 `sources` 仍合并进旧条目并返回（溯源不丢）
- `memory_read` / `memory_search` / `memory_list` 返回值都带 `sources`（`memory_save` 也返回）
- 只是"这条记忆从哪来"的指针：不做图遍历、不校验 id 是否存在（可以指向已归档/已删除的 task）
- skill 用它指回来源 task（Phase 6 落盘时 `sources=[task id]`）

#### 6.2 kind 生命周期补充

- `skill`：不进热索引 / 待办块；不参与 SWS 合并、SHY 衰减、`memory_consolidate` 合并与归档
- **不降级**：同主题更新时 skill 不会被 fact 覆盖；fact → skill 允许升级
- dream 的材料统一只取 fact：SWS 合并、SHY 衰减、Phase 4 画像材料、Phase 6 相关记忆
- **已知限制**：Phase 3 · REM 仍会对 task / skill 建 `links`。links 不进注入、不占预算，只落在 L2 数据结构里；要收紧可以后续加 kind 过滤

#### 6.3 Phase 6 · Skill 提炼流程

| 步骤 | 谁做 | 做什么 |
|---|---|---|
| 1. 判到期 | 插件 | `skillExtraction !== false` 且存在 `status=active`、`taskStatus=done`、`doneAt > stats.lastSkillExtract` 的 task（缺 `doneAt` 保守算新） |
| 2. 备材料 | 插件 | 完成任务 ≤10（id / 标题 / 内容 / 备注 / 完成时间；备注 = `add` 的 note + `done` 追加的完成备注，`旧 \| 新`）+ 相关活跃 fact ≤15（任务标签共现优先，其次最近更新）+ 最近 3 天睡梦摘要 + subagent 指令 |
| 3. 写任务文件 | 插件 | `dream/YYYY-MM-DD-skill-task.md`；**只有写成功才**更新 `stats.lastSkillExtract`（避免每晚重复生成） |
| 4. 报告 | 插件 | `## 🧠 Phase 6 · Skill 提炼`：`技能提炼：是 → 任务文件：…` / `技能提炼：否（无新完成的待办任务…）`；`skillExtraction: false` 时整节不出现 |
| 5. 提炼 | subagent | 读任务文件，产出 1–3 条 skill（`TITLE:` / `SKILL:` / `TAGS:` / `SOURCES:`，中文祈使句，≤200 tokens/条，不调工具） |
| 6. 落盘 | 主 agent | 逐条 `memory_save(kind='skill', sources=[task id])`，再 `memory_consolidate` 收尾 |

`memory_dream` 返回值新增 `skillExtraction {enabled, due, taskFile, completedCount}`；`completedCount` 是"新完成"总数（材料最多取 10 条）。

为什么还是 subagent：与 Phase 4 相同——插件没有 LLM 依赖、不该引入 token 成本；主会话提炼要读大量材料，太贵。插件只负责"到期判断 + 材料 + 磁盘 I/O"。

#### 6.4 C1 为什么没冻结进快照（附 v0.10 备选）

v0.9-A 冻结的是 L1 热索引行 + 到期阈值；C1 提醒仍实时渲染。原因：C1 文案已是日粒度（`欠梦（上次整理 YYYY-MM-DD）`），不含小时数 / 新增计数，只在「做梦 / 日界 / 跨过 `dreamAfterHours`」时变化，已足够稳定；而冻结 C1 会带来"做完梦提醒仍显示"的陈旧问题（需要额外状态去同步）。

代价是会话内仍可能有 1–2 次前缀翻转：会话中途完成一次 `memory_dream`（C1 行从有到无）、极端情况下跨过 `dreamAfterHours` 阈值。若长会话占比高，v0.10 可选二选一：① 把 C1 并入注入快照（会话内彻底冻结）；② `reminderDelivery: 'tail'`，把提醒搬到会话尾部 append（DSH 公开 API：`agent/pre-step` + `createUserMessage`，不失效 KV 前缀，见 [docs/DSH-APPEND-INJECTION.md](./docs/DSH-APPEND-INJECTION.md)）。

## v0.8 落地变更 · Mental model（L0 画像自动重写）

> 借鉴 Hindsight 的 mental models：为长期问题维护一份自动重写的答案，读的时候零 LLM。

L0 画像是"每次会话都常驻、决定 agent 怎么和用户说话"的那 200 tokens。手写会过期，全自动又容易跑偏。v0.8 的分工：

| 角色 | 负责 |
|---|---|
| **规则（插件）** | 判断到期（`stats.lastProfileRewrite` + `mentalModelEveryDays`）、准备材料、写任务文件、归档旧画像、硬截断校验预算 |
| **LLM（subagent）** | 读任务文件 → 写出 ≤200 tokens 的新画像 → 返回文本 |
| **主 agent** | 先 `memory_profile_archive`，再把任务文件路径交给 subagent，最后 `memory_profile_save` 落盘 |

为什么是 subagent：

- 插件内直接调 LLM：插件没有 LLM 服务依赖，也不该引入 token 成本；宿主 API 不保证稳定。
- 主会话自己写：画像重写要读大量记忆，占用主上下文，很贵。
- **subagent**：独立上下文、可读文件、可调工具，只把最终画像带回 —— 主上下文几乎零成本。

安全边界：只改 L0，绝不删/改 L1/L2；旧画像进 `profile-history/` 可回滚；`SECRET_RE` 拦密钥；`clampToBudget` 硬保证预算。

## v0.2 落地变更

- **自动捕获**：`session/event` 把 user/assistant 消息追加到 `journal/YYYY-MM-DD.jsonl`（L3 原始层，永不注入）。单条截断 4000 字符，子代理会话默认跳过。捕获零上下文成本。
- **睡梦机制**：`memory_dream` 回顾最近 N 天 journal，按线索词提炼候选 + 相似去重，生成 `dream/YYYY-MM-DD.md`；每天 23:30 定时任务驱动 Agent 复盘并落库，再 `memory_consolidate`。
- **可视化面板**：`GET /memory-fish/panel`（同源校验）+ `/memory-fish/api/state`、`/memory-fish/api/action`。展示预算条、条数卡片、画像编辑、记忆检索/置顶/遗忘、一键做梦/整理、最近睡梦报告。无构建步骤，纯 HTML。
- **代码已按模块拆分函数**：`saveMemoryCore`（工具/面板/做梦共用）、`buildDream`、`registerPanelRoutes`、`runPanelAction`、`trustedRequest`。

## 0. 一句话设计

> **记忆的存储量是 O(∞)，注入成本是 O(1)，检索成本只在需要时发生。**

现有的记忆插件（Claude Code 式、Markdown 索引式、知识图谱式）通病是：
记忆越多 → 索引越长 → 每次会话注入越多 → 上下文越来越贵、越来越慢。

我们要反过来：**记忆越多，系统越会"压缩"，注入部分永远只有几百 token。**

---

## 1. 目标 / 非目标

### 目标
- 跨会话记住铁凝的偏好、决策、结论
- 注入 token 有**硬预算**（默认 ~600 tokens），不随记忆数量增长
- 零服务端、零外部进程、零 embedding API、零额外 LLM 调用（可选增强除外）
- 记忆**人类可读**（Markdown），可 git 管理、可手工编辑、可一键删除
- 支持遗忘、纠错、覆盖（不是只增不减）

### 非目标
- 不做知识图谱 / 向量数据库 / RAG 平台
- 不自动捕获每句对话（那会迅速变成垃圾场）
- 不做多设备同步
- 不替换系统提示里的其他上下文

---

## 2. 成本模型（先算账，再设计）

一次会话的记忆注入成本 = `L0 + L1`，必须恒定。

| 层 | 内容 | 注入 | 预算 |
|---|---|---|---|
| **L0 画像** | 用户是谁、人设、沟通偏好、硬约束 | 每次会话 | ≤ 200 tokens |
| **L1 热索引** | 置顶记忆 + 最近 N 条的一行摘要 | 每次会话 | ≤ 400 tokens |
| **L2 温记忆** | 完整记忆正文 | 按需工具读取 | 0（常驻） |
| **L3 冷档案** | 归档、原始事件、被压缩的细节 | 只有 grep 命令能碰到 | 0 |

**换算**：中文标题 + 日期 + 标签 ≈ 25–30 tokens/行 → L1 预算 400 tokens ≈ **12–15 行**。
所以"热索引"最多 15 条：置顶 5 条 + 最近 10 条。其余全部沉到 L2/L3。

L2/L3 不是删除，是"按需可取"——一次 `memory_search` 的成本只在真正需要时付。

> 关键点：注入放在 **session start**（稳定前缀），不随每轮消息变化。
> 稳定前缀能命中服务商的 prompt cache，实际成本远低于账面 token。

---

## 3. 四层架构

```
┌─────────────────────────────────────────────┐
│ L0 画像 (≤200 tok, 常驻)                      │
│   "铁凝：写代码/折腾电脑/关注新技术。             │
│    自称小肥鱼。中文轻松语气。"                    │
├─────────────────────────────────────────────┤
│ L1 热索引 (≤400 tok, 常驻)                     │
│   ★ 置顶：沟通偏好、项目约定（5 条）              │
│   · 最近 10 条：标题 + 日期 + 2 个标签           │
│   → 冷区还有 37 条，memory_search 可查          │
├─────────────────────────────────────────────┤
│ L2 温记忆 (磁盘, 按需)                          │
│   每条 2–5 句，带来源、日期、重要度、失效时间        │
├─────────────────────────────────────────────┤
│ L3 冷档案 (磁盘, 极少触碰)                       │
│   被合并的旧版本、被衰减的条目、压缩前的原始记录      │
└─────────────────────────────────────────────┘
```

**晋升 / 降级规则**
- 用户说"记住这个"或记忆被检索≥3 次 → 重要度↑，可晋升到 L1
- 30 天未被检索且重要度低 → 降级到 L3（归档，不删除）
- 同一主题出现新结论 → 旧条目标记 `superseded`，移出 L1，新旧之间保留链接

---

## 4. 防膨胀的六个机制

### 4.1 写入门槛（Gate）
不是所有对话都值得记。只在**结论时刻**写：
- 用户明确表达偏好/纠正（最高价值）
- 做出决策并说明理由
- 排障闭环（错误 → 根因 → 修复）
- 关键数字/ID/路径

不写：临时状态、进行中的调试、仓库里能读到的、模型猜测。

### 4.2 写入即去重（Dedupe）
保存前做**字符 bigram Jaccard 相似度**（本地、零依赖）：
- 相似度 > 0.75 → 判定同主题，**原地更新**（保留历史版本到 L3）
- 相似度 0.4–0.75 → 作为"相关记忆"链接，不新增
- 否则新增

> 这是控制增长的**第一道闸门**：重复才是膨胀的主因，而不是数量。

### 4.3 定期压缩（Consolidation）
触发条件（任一）：L1 超过预算 / 新增 20 条 / 每周一次 / 用户手动 `/memory-consolidate`
动作：
1. 聚类（同标签或相似度 > 0.5）
2. 每簇合并成一条"主题记忆"（保留要点 + 时间线）
3. 合并前的原文全部进 L3 冷档案（可回溯）
4. 重新生成 L1（只保留置顶 + 最近）

压缩用**纯规则**（标题/标签/时间/相似度），不调 LLM —— 零额外 token。
如果以后想要更聪明的合并，可以挂一个"可选：用便宜模型压缩"的开关，默认关闭。

### 4.4 衰减（Decay）
每条记忆维护 `score = importance × recency × (1 + hits)`
- `importance`：用户明说 5，决策 4，偏好 3，结论 2
- `recency`：指数衰减，半衰期 30 天
- `hits`：被检索次数

score 低于阈值的条目移出 L1 → L3。**只降级不删除**，除非用户明确"忘掉"。

### 4.5 预算守卫（Budget Guard）
- 注入前统计 L0+L1 估算 token，超预算则自动执行压缩/裁剪
- 每次注入后记录：`injected_tokens`，写进统计文件
- 提供 `memory_stats` 工具：看记忆总数、L1 占多少 token、本月开销趋势

### 4.6 冷热分离的检索
- 常驻只有 L1
- L2/L3 用 `memory_search`（BM25 + 字符 bigram，中文友好），**本地同步计算，<5ms**
- `memory_read` 按 id 取全文，支持截断
- 不做"每轮自动召回"（那会把上下文预算交给不可控的相关性判断）；需要时我只花一次工具调用

---

## 5. 存储格式（人类可读 + 机器可查）

```
memory/
├── profile.md                 # L0，手写/我维护，很小
├── index.json                 # L1 的机器索引 + 每条元数据（可重建）
├── hot/                       # 置顶与近期（软链或副本）
├── memories/
│   └── 20261025-213821-prefer-pnpm.md
├── archive/                   # L3：压缩前原文、被替代版本
│   └── 20261025-213821-prefer-pnpm.md.1
└── stats.json                 # token 账本
```

单条记忆格式（Markdown + frontmatter）：
```markdown
---
id: 20261025-213821-prefer-pnpm
created: 2026-10-25T21:38:21+08:00
importance: 4
hits: 0
supersedes: 20260910-120000-use-npm
tags: [工具链, 包管理]
status: active        # active | superseded | archived
---
# 用 pnpm，不用 npm

这个项目统一用 pnpm（锁文件为 pnpm-lock.yaml）。
理由：磁盘占用小、hoisted linker 与 DSH profile 兼容。
```

**为什么不用 SQLite**：Markdown 可读、可 diff、可手工修、可 git；检索靠启动时构建内存索引（1 万条 ≈ 几 MB，毫秒级）。SQLite 作为可选加速层以后再加。

---

## 6. 工具面

| 工具 | 作用 | 成本 |
|---|---|---|
| `memory_save` | 保存/更新（自动去重），带门槛提示 | 一次调用 |
| `memory_search` | 本地关键词检索（L2+L3） | 毫秒级 |
| `memory_read` | 读全文（超长截断 + 给路径） | 一次调用 |
| `memory_list` | 最近 N 条（默认 8） | 一次调用 |
| `memory_pin` | 置顶/取消置顶（进 L1 头部） | 一次调用 |
| `memory_forget` | 遗忘（软删除 + tombstone，防复活） | 一次调用 |
| `memory_stats` | 预算与增长统计 | 一次调用 |
| `memory_consolidate` | 手动触发压缩（定期任务也会调） | 纯本地 |

---

## 7. 失败模式与对策

| 失败模式 | 对策 |
|---|---|
| 记忆越存越多，索引爆炸 | L1 硬预算 + 自动压缩 + 衰减 |
| 同一件事存了 5 遍 | 写入去重（相似度阈值） |
| 过期事实被当成现状 | 有效期字段 + supersede 链 + 状态可见 |
| 注入内容污染系统提示 | 注入块单独成节、可关闭、标注来源与日期 |
| 模型编造记忆 | 只允许工具写入；每条带来源会话 id |
| 删不掉 / 越删越乱 | 软删除 + tombstone + 冷档案可追溯 |
| 检索不准 | 关键词 + 标签 + 标题加权；不追求语义搜索 |

---

## 8. 路线图

- **M0 骨架（今晚）**：目录结构 + profile.md + index.json + `memory_save/search/read/list` + 注入 L0/L1 + 预算守卫
- **M1 防膨胀**：去重、pin、forget、stats、压缩（规则版）
- **M2 自动化**：定时压缩任务、衰减计算、冷热迁移
- **M3 体验**：Memory 面板（查看/编辑/统计）、导出/备份
- **M4 打磨**：测试（node:test）、错误处理、与 fooxe 插件共存/替代策略

---

## 9. 待铁凝拍板的决策

1. **名字**：`dsh-memory-fish` / `小肥鱼记忆` / 其他？
2. **自动捕获**：默认**不自动**（只在我判断值得记时写）还是允许"每轮对话后自动摘要"？
   - 自动更省事，但增长快、噪音多；建议先手动，稳定后再加开关。
3. **L1 预算**：400 tokens（≈13 行）够不够？还是 600？
4. **是否要可视化面板**：M3 才有，先命令行/文件能不能接受？
5. **和现有 `@fooxe/dsh-memory` 的关系**：先共存对比，还是直接替换？
