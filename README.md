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
| L1 热索引 | 置顶 + 最近 10–20 条标题 | 每次会话 | ≤400 tok |
| L2 温记忆 | 完整正文 | 按需工具读取 | 0 |
| L3 冷档案 | 压缩前原文、被替代版本 | 从不注入 | 0 |

记住 10 条和记住 1000 条，注入成本一样。

## 防膨胀机制

- **写入即去重**：字符 bigram Jaccard ≥ 0.75 判定同主题，原地更新，旧版本进冷档案
- **规则压缩**：`memory_consolidate` 合并近似条目（不调 LLM，零额外 token）
- **衰减归档**：60 天未更新、未置顶、低重要度 → 归档（可检索，不删除）
- **硬预算**：注入前按 token 预算裁剪，超了就少注入几行

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
- 注入 token 预算条、活跃/归档/置顶/今日对话/候选线索卡片
- 画像编辑、记忆搜索、置顶/遗忘
- 一键「现在做梦」「整理记忆」、查看最近睡梦报告

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
- 距上次做梦 26 小时 · 新增对话 12 条 → 建议先 memory_dream 做三阶段整理
```

判断条件：`dreamReminder: true`（默认）且（距上次做梦 ≥ `dreamAfterHours`（默认 24）**或**有到期复习），并且确实有新对话或复习项。没有就完全不出现，零 token 成本。

好处：新会话也有效、卸载后零残留、不依赖 `dsh-schedule` 的内部协议。

### 间隔重复（P1）
每条记忆维护 `stability`（能记多久）、`nextReview`（下次复习日）、`reviews`：
- 新记忆按重要度给初始稳定性（约 8–13 天）
- `memory_search` / `memory_read` 命中即加固（稳定性 ×1.3 / ×1.1），这就是提取练习效应
- 到期条目在热索引里标 `⏰`，睡眠报告里列成待复习清单

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
## 🧠 Phase 4 · Mental model（L0 画像自动重写）
- 画像到期：是 → 任务文件：~/.dsh/memory-fish/dream/2026-10-25-mental-model.md
```

为什么不是插件自己调 LLM（插件没有 LLM 依赖，也不该引入 token 成本），也不是主会话自己写（要读大量记忆，主上下文太贵）—— 这是 DSH 的能力边界决定的：插件跑在 host 进程里不能 spawn subagent，只有 agent 轮次能调 `subagent`。

安全边界：
- 只改 L0，**绝不删除或覆盖 L1/L2 记忆**
- 旧画像先归档到 `profile-history/`，随时可回滚
- `memory_profile_save` 内置密钥拦截 + `clampToBudget` 硬截断，画像永远不会撑爆 200 token 预算

## 工具

| 工具 | 作用 |
|---|---|
| `memory_save` | 保存/原地更新（自动去重、拒存密钥） |
| `memory_search` | 本地关键词检索（含归档，可选） |
| `memory_read` | 读全文（>4000 字符截断） |
| `memory_list` | 最近记忆 |
| `memory_pin` | 置顶/取消（置顶不参与衰减） |
| `memory_forget` | 软删除 + 墓碑 |
| `memory_profile_save` | 写 L0 画像（超长硬截断、拒密钥，记录重写时间） |
| `memory_profile_archive` | 归档当前画像到 `profile-history/`（重写前调用，可回滚） |
| `memory_dream` | 睡梦：回顾对话、提炼候选、写报告；v0.8 起含 Phase 4 画像重写任务 |
| `memory_stats` | 查看注入 token / 条数 / 磁盘占用 / 捕获数 |
| `memory_consolidate` | 手动整理（dry-run 可选） |

## 数据位置

```
~/.dsh/memory-fish/
├── profile.md      # L0（≤200 tok，常驻注入）
├── profile-history/ # v0.8：每次重写前的旧画像快照，可回滚
├── index.json      # 元数据索引（可重建）
├── memories/       # L2：每条一个 Markdown
├── archive/        # L3：旧版本、被替代、被遗忘的原文
├── journal/        # 自动捕获的原始对话（按天 jsonl，永不注入）
├── dream/          # 睡梦报告（按天 md）+ v0.8 画像重写任务（*-mental-model.md）
└── stats.json      # 计数（含 lastProfileRewrite）
```

全部人类可读、可 git、可手改。索引丢失会从 `memories/*.md` 自动重建。

## 安装

注册进 DSH profile：

1. 把本目录复制到 `<profile>/node_modules/dsh-memory-fish/`
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 加入 `"dsh-memory-fish"`，
   并在 `dependencies` 加入 `"dsh-memory-fish": "file:projects/memory-fish"`
3. 重启 DSH（或等待 profile 热加载）

## 代码结构

```
index.mjs        插件入口：配置、注入、自动捕获、装配
lib/config.mjs   默认值 + 配置校验
lib/util.mjs     token 估算、bigram/Jaccard、显著性、间隔重复、脱敏
lib/store.mjs    Markdown/JSON 存储、journal、归档、迁移
lib/inject.mjs   L0+L1 注入块（预算裁剪）
lib/core.mjs     saveMemoryCore：去重 / 新颖性门控 / 版本
lib/dream.mjs    三阶段睡眠
lib/tools.mjs    模型工具（写操作加锁串行）
lib/panel.mjs    本地 HTTP 面板 + API
lib/lock.mjs     跨进程写锁
lib/log.mjs      可选调试日志
client/client.js 设置页面板（浏览器半）
```

## 测试

```bash
npm test   # 64 项断言：捕获、脱敏、保存/去重/NOOP、检索、asOf 历史、
           # 睡眠三阶段 + Phase 4 画像重写（到期/未到期/关闭、任务文件、
           # 归档、硬截断）、面板路由、锁释放、预算
```

CI 在 Linux / Windows × Node 22 / 24 上跑。

## 安全

本地优先、无网络。journal 落盘前会脱敏密钥；HTTP 面板仅限 localhost 且有同源校验，但**没有鉴权**——请只在可信机器上运行。详见 [SECURITY.md](./SECURITY.md)。

## 设计

见 [DESIGN.md](./DESIGN.md)。

## License

MIT

