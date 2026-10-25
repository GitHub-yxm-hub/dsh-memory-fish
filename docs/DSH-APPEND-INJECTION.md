# DSH 尾部注入调研：能否向会话历史 append sourced `user/message`

> 调研日期：2026-10-26 · 方式：只读（解析 `app.asar` + 首方包文档/源码，未改仓库、未 git）
> 本机环境：DeepSeek Harness 0.2.x 桌面版，`D:\App\dsh\resources\app.asar`（182,434,783 B），
> Windows 桌面 profile（`C:\Users\86177\.dsh\profiles\desktop`）。
> 目的：回答 dsh-memory-fish v0.9 是否能把「C1 欠梦提醒 / 待办到期提醒」从 system prompt
> 搬到会话尾部 append-only 注入，从而彻底保护 **KV 前缀缓存**。
> 本文是仓库归档版（精简）；原始报告含可复跑的 asar 探针脚本，保留在调研工作区。

## 结论（TL;DR）

**有公开 API，且官方插件开发规范明文推荐。** 两条路径都能产出「带 source 的普通
`user/message`，append-only，system prompt 完全不变」：

1. **`agent.inject(userMessage)`** —— 最省事。官方内置插件开发技能原文：
   *"Add per-agent context with `agent.inject()`; it is logged as `agent/inbox/spliced`
   at call time and enters the next admitted step."*（E7）不唤醒 agent（E9）。
2. **`ctx.on('agent/pre-step', …)` 瀑布监听器改写 `decision.messages`** —— 官方首方包
   `dsh-agent-instructions` 就是这么注入 `<system-reminder>` 基线的（E3/E4）；loop 在 step
   开始时把这些消息以 `session.append('user/message', msg, { surfaceOp: 'append' })` 落盘（E5）。

**对 dsh-memory-fish 的决定：v0.9 先不搬**，继续用「system prompt + 注入快照」；
把 tail 注入列为 **v0.10 可选特性**（`reminderDelivery: 'inline' | 'tail'`，默认关）。

## 调研方法

- `app.asar` 不是压缩包：按 ASAR 头解析（`[u32=4][headerSize][u32=jsonLen][JSON@16]`，
  `dataOffset = 8 + headerSize = 4,748,104`），得到 18,188 个文件条目（16,605 packed），
  从而把每个字符串命中**归因到真实包内路径 + 绝对/相对偏移**。
- asar 内无 `.d.ts`（npm dist 只带 `lib/index.js` 等），但各包的 `lib/typert.host.js`
  是生成的 TypeScript 声明目录（JSON 内嵌 `export interface …` 原文），是能拿到的最权威
  公开 API 面（E2/E6/E13/E14）。
- 旁证：本机 profile 的真实第三方插件 `dsh-pet` 运行时 `import { createUserMessage }
  from "@deepseek-ai/dsh-llm"`，说明 profile 插件链可以拿到该 peer 依赖（未在插件内实测）。

## 证据表（18 条）

> 路径为 asar 内相对路径（`dsh/node_modules/…`），偏移是文件内绝对字节偏移（latin1 检索）。

| # | 文件（asar 内） | 位置 | 原文要点 |
|---|---|---|---|
| E1 | `@deepseek-ai/dsh-llm/lib/types/message.js` | abs 83,277,675 | `createUserMessage(input)` → `createMessage({...input, role:'user'})`，自动生成 `id` 并 deep-freeze |
| E2 | `@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js`（Agent） | abs 17,263,133 | `interface Agent` 暴露 `session` / `inbox` / `send()` / `followup()` / `steer()` / **`inject(message)`** |
| E3 | `@deepseek-ai/dsh-agent-instructions/README.md` L88 | abs 16,986,132 | baseline/refresh 是普通 sourced `user/message` 事件：会 replay、compact、resume，状态可从 session log 重建 |
| E4 | 同上 L103 | abs 16,987,081 | 首个 eligible `agent/pre-step` 时把基线折进 entering batch |
| E5 | `@deepseek-ai/dsh-agent-loop/lib/index.js` L1066-1073 | abs 17,160,757 | loop 只在 step 开头 `session.append("user/message", message, { surfaceOp: "append" })` |
| E6 | `@deepseek-ai/dsh-session/README.md` L42-50 | abs 93,625,252 | `session.append(type, data, opts?)` 是公开方法，示例即 append sourced `user/message` |
| E7 | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` L18 | abs 17,440,080 | 推荐 `agent.inject()`；注意 `agent/request` 监听器不能改请求消息 |
| E8 | 同上 L16 | abs 17,439,355 | 改 `agent/pre-step` decision 时必须展开（`{...decision, messages}`），保住 `startsRequestSeries` |
| E9 | 同上 L29 | abs 17,442,299 | `agent.followup()` 会唤醒 agent，`agent.inject()` **不会**（消息在 inbox 等下一次输入） |
| E10 | `@deepseek-ai/dsh-agent/README.md` L85 | abs 17,487,666 | `PreStepDecision` = `{kind:'reject'}` 或 `{kind:'enter', messages, startsRequestSeries?}`；claim 后才算进入 |
| E11 | 同上 L87-91 | abs 17,488,412 | `Agent.inbox` 的 `Inbox` 接口：`nextTurn` / `nextStep` + `append/prepend/replace/remove/clear/splice` |
| E12 | `@deepseek-ai/dsh-agent-loop/README.md` L71 | abs 17,081,921 | 每次 inbox 变更落一条 `agent/inbox/spliced`；claim 落 `agent/inbox/claimed` |
| E13 | `@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js`（Message） | abs 17,285,110 / 17,308,868 | `MessageSourceMap` 按 `kind` 判别的 union；`UserMessage extends MessageBase { role:'user' }` |
| E14 | 同上（Inbox / Session） | abs 17,277,865 / 17,291,552 | `Inbox` 各方法签名；`Session.append<T>(type, data, …)`、`deriveMessages()` |
| E15 | `@deepseek-ai/dsh-agent-instructions/lib/index.js` L1335-1424 | abs 17,046,001 / 17,068,326 | 首方实现：`createUserMessage({content, source:{kind:'agent-instructions', …}})`；pre-step 里 `decision.messages.toSpliced(lastClaimedIndex+1, 0, desired)` |
| E16 | `@deepseek-ai/dsh-schedule/lib/index.js` L1586-1597 | abs 91,012,810 | 首方「一次性事件 → sourced user 消息」先例：`createUserMessage({source:{kind:'schedule'}})` + `followup()` |
| E17 | `@deepseek-ai/dsh-agent-loop/lib/index.js` L800-813 | abs 17,152,111 | `send/ followup/ steer/ inject` 的区别：inject = `send(msg,'next-step',false)` |
| E18 | 四处 README 的 KV 结论 | abs 16,991,712 等 | "Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries." 等四处一致 |

## 四问回答

### Q1：插件侧有没有公开 API 追加带 source 的 user 消息？

有，而且有官方推荐顺序：

| 能力 | API | 说明 |
|---|---|---|
| 构造 durable user 消息 | `createUserMessage({ content, source })`（`@deepseek-ai/dsh-llm`，E1） | `content` 是 `ContentBlock[]`；`source` 是 `{kind, …}`，自动生成 id、深冻结 |
| 一次性注入（不唤醒） | `agent.inject(msg)`（E2/E7/E17） | 等价 `send(msg,'next-step',false)`；inbox 变更立即落盘（E12），下一步 admit 时作为 `user/message` 提交 |
| 本 step 就进入请求 | `ctx.on('agent/pre-step', async (p, next) => …)` 返回 `{...decision, messages}`（E8/E10/E15） | 官方 `dsh-agent-instructions` 的 `<system-reminder>` 就是这条 |
| 底层 inbox 操作 | `agent.inbox.nextStep/prepend/replace/remove/splice`（E11/E14） | 首方用它做「去重后替换 pending」 |
| 直接写日志 | `session.append('user/message', msg, {surfaceOp:'append'})`（E6/E14） | 公开但**不建议**在 turn 中途用（见 Q2） |

> 勘误：类似 "Baseline and refresh messages are ordinary sourced user/message events…" 的
> 表述不在 `dsh-context`（纯 UI/分析插件，只**读**这类 source），在
> `dsh-agent-instructions` README L88 —— 它才是官方 `<system-reminder>` 注入实现。

### Q2：签名与约束

```ts
interface Agent {
  readonly session: Session; readonly inbox: Inbox;
  send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void;
  followup(message: UserMessage): void;  // 唤醒
  steer(message: UserMessage): void;     // 唤醒
  inject(message: UserMessage): void;    // 不唤醒
}
interface Inbox {
  readonly nextTurn: readonly UserMessage[]; readonly nextStep: readonly UserMessage[];
  append(target, message): void; prepend(target, message): void;
  replace(id, msg): boolean; remove(id): boolean; clear(): void;
  splice(target, start, deleteCount, inserted): UserMessage[];
}
interface UserMessage extends MessageBase { readonly role: 'user'; }
```

- **幂等/去重**：框架**不做**去重。官方做法（E15）：对比 `decision.messages`（已 claimed）+
  会话可见 surface 的 `(content, source)` 深相等（"An unchanged path with an unchanged
  digest is never injected again"）。建议用 `agent.session.deriveMessages()` 扫描
  `source.kind === 'dsh-memory-fish'` + 稳定 `reminderId`，并对照 `agent.inbox.nextStep` 防 pending
  重复；`session.eventAt / snapshotEvents / ownEvents` 已被 README 标 deprecated，不要用于去重。
- **source 形状**：`MessageSource` 是开放对象（运行时只校验 lossless JSON 与 surface marker）；
  内置 kind 约 20 个，插件自定义 kind 有先例（`agent-instructions` 不在内置表内）。
  约束：一条 `UserMessage` 只能带一个 source。
- **compact 后**：日志保留、resume/fork 保留；surface 会被 `replace` 阴影，模型不再逐字看到。
  → 提醒类消息不要假设「永久逐字在上下文里」。
- **对 KV 前缀缓存**：尾部 append **不失效已有前缀**（E18 四处一致）；代价是该消息之后每步重发，
  直到被压缩阴影。system prompt 完全不动 → 正是目标。
- **时机约束**：
  - `agent/pre-step` 内插入最稳：只在该 step 被接受后落盘；`agent/request` / `prepareCall`
    期间取消则不提交（E10）。
  - `agent.inject()` 任意时刻可调，但 agent 空闲时会一直等下一次输入（E9）；
    `cancel()` 默认清空 inbox（dsh-agent README）→ 可能丢一次提醒。
  - 直接 `session.append` 写 `user/message`：**避开**。loop 自己只在 step 开头批量 commit（E5），
    turn 中途直写可能插到 `assistant(tool_calls)` 与 `tool/result` 之间，产生协议非法序列。
  - `pre-step` 对所有 agent 触发（含 subagent）→ 需按 `session.header.origin === 'subagent'` 过滤。

### Q3：没有公开 API 时的半公开路径与风险？

**不需要**——Q1 的路径都是公开文档化的（`Agent` 接口、`agent/*` 事件、`Session.append`
在 "Use this package" 章节、`createUserMessage` 是常规导出，且真实第三方插件 dsh-pet 在用）。

- 半公开可用但**不建议**：`ctx.sessionController.resolveAgent(sessionId)`、
  `ctx.sessionProjections.stateOf(session,'turnBoundary')`——随宿主版本演进，无跨 composition 保证。
- **红线**：`appendPluginRecord()` 明确禁止第三方调用；不要用 `agent.ctx` 内部结构；
  不要监听 `system-prompt/assemble` 改文本。

### Q4：v0.9 该搬还是继续 system prompt + 快照？

**v0.9 先不搬**。快照冻结后，system prompt 在会话内真正字节稳定；剩余会让它中途变化的只有：
C1 在 `memory_dream` 完成后翻转消失、`daily` 模式跨日界重建 L1、L0 画像重写。
每次只造成 1 次前缀 miss，但 miss 代价是整段历史 re-prefill（长会话很贵）。

判断标准：

- 长会话（>30k tokens）且经常中途做梦 / 跨日 → tail 注入收益明显；
- 会话普遍短、做梦多在会话外（23:30 定时）→ 快照冻结已够，不值得引入新 API 面。

> 实现现状（v0.9.0 最终版）：**不搬尾部注入**。L0 画像与 C1 提醒保持实时渲染（C1 是
> 日粒度文案，只在「做梦事件 / 日界 / 跨过 dreamAfterHours」变化），L1 热索引 / 到期阈值
> 走注入快照（session/daily/live）。会话内残留翻转点 = 会话中途完成一次 `memory_dream`
> （C1 行从有到无）及极端情况跨过阈值一次。v0.10 可选
> `reminderDelivery: 'inline' | 'tail'`（默认 `inline`），tail 用本报告「对 v0.10 的建议」
> 第 1 条的 `agent/pre-step` + `createUserMessage` 方案；若不想引入 tail，也可把 C1 并入注入快照
> ——两者二选一即可。

## 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 依赖 `@deepseek-ai/dsh-llm` / `agent/*` 事件随 0.2.x rc 演进 | 中 | peerDependencies 精确区间 + 运行期 import 失败降级（手写 `{id, role:'user', content, source}`） |
| R2 | 去重靠 `deriveMessages()` 扫描，压缩后标记可能不再逐字可见 → 重复注入 | 低 | 接受「压缩后重提醒」（对提醒反而合理）或自建 per-session fold |
| R3 | `pre-step` 对所有 agent 触发，误注入 subagent / 标题会话 | 中 | `session.header.origin === 'subagent'` 跳过；只用 root session |
| R4 | 提醒永久留在 transcript（用户可见的 user 角色消息） | 低 | 用 `<system-reminder>` 框架 + `form:'notice'`；UI 按 source 分类显示 |
| R5 | 直写 `session.append` 在 turn 中途破坏 tool 顺序 | 高（若采用） | 只走 pre-step / inbox 两条路；直写仅限无 open step |
| R6 | `agent.inject()` 的 pending 消息被 `cancel()` 清空 | 中 | 一次性事件优先 pre-step；inject 只用于「丢了也无所谓」的提示 |
| R7 | 每步都跑 pre-step 检查的成本 | 低 | 先做 `reminderDue` 布尔短路，仅到期时扫 `deriveMessages()` |
| R8 | 冻结 C1 会显示「睡梦已完成但提醒仍在」的陈旧 | 低 | 冻结文本注明「若已完成可忽略」；或保持实时（v0.9 现状） |

## 对 v0.10 的建议

1. 新增 `reminderDelivery: 'inline' | 'tail'`（默认 `inline`）。tail 走
   `agent/pre-step` 插入（同一 step 可见，最贴近官方样例）+ `createUserMessage` +
   `source: { kind:'dsh-memory-fish', form:'notice', reminderId }`；去重读 `deriveMessages()`；
   subagent 跳过；取消语义由 pre-step 天然保证（未接受不落盘）。
2. 适合先搬尾部的候选：待办 / 复习到期提醒、每日简报（事件驱动、一次性、时效强）；
   C1 视上文的收益判断（长会话 + 频繁中途做梦才值得）。
3. 不建议用 `agent.inject()` 做「每会话一次」的提醒：要自己处理 idle 等待、cancel 清空、
   resume 场景；它更适合「定时器主动触发且希望不唤醒」的场景（需要唤醒用 `followup()`）。
4. 实施前先做一次最小 import 验证 + 真机注入链路验证（挂测试插件重启 DSH），本轮未执行。

## 未验证 / 边界

1. 未在运行中的 DSH 里真机注册测试插件验证注入链路（需改 profile + 重启，超出只读边界）；
   以上结论全部来自官方文档 + 首方实现源码 + generated 声明目录。
2. 未验证 memory-fish 作为 linked profile 包（`file:projects/memory-fish`）在加 peer dep 后
   import `@deepseek-ai/dsh-llm` 的实际解析（机制与 dsh-pet 同类；建议实施时先跑最小 import 验证）。
3. `MessageSourceMap` 的 TS 模块增强写法未在 asar 中找到实例（d.ts 不随包分发）；
   JS 运行时按开放对象处理，无阻塞。

## 参考

- asar 内证据原文：`dsh-agent-instructions`（README + lib/index.js）、`dsh-session` README、
  `dsh-agent` README、`dsh-agent-loop`（README + lib/index.js）、`dsh-schedule` lib、
  `dsh-llm/lib/types/message.js`、`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`、
  各包 `lib/typert.host.js` 声明目录。
- 本机插件侧：`projects/memory-fish/lib/config.mjs`（`injectionMode`）、
  `lib/inject.mjs`（C1 与待办渲染）、`lib/store.mjs`（`getInjectionSnapshot`）。
