import fsSync from 'node:fs';
import { clampText, estTokens, dayOf, localDay } from './util.mjs';

// ---------------------------------------------------------------- 注入

/**
 * C1 睡梦提醒（v0.8.1 缓存友好版）。
 * 文案只随「做梦」事件或日界变化，**不含**小时数/新增对话计数——
 * 否则欠梦期间每轮请求的 system prompt 都会变，整段前缀缓存失效。
 */
function dreamStatus(store, config, now = Date.now()) {
  if (config.dreamReminder === false) return null;
  const last = store.stats?.lastDream ? new Date(store.stats.lastDream).getTime() : 0;
  const ageHours = Number.isFinite(last) && last ? (now - last) / 3600000 : Infinity;
  const lastDay = Number.isFinite(last) && last ? localDay(new Date(last)) : '';
  const captured = store.stats?.capturedSinceDream || 0;
  const dueCount = store.due().length;
  const overdue = !Number.isFinite(ageHours) ? true : ageHours >= Number(config.dreamAfterHours ?? 24);
  if (!overdue) return null;                        // 到期复习由正文阈值行负责，避免重复
  if (captured === 0 && dueCount === 0) return null;
  return { overdue, lastDay, dueCount };
}

/**
 * v0.9-B：「待办」块（实时渲染，不走 L1 快照）。
 * 仅 open task；≤5 行，格式 `- ⏰ MM-DD 标题`（逾期）/ `- · MM-DD 标题`（有截止）/ `- · 标题`；
 * 超出加 `- …另有 N 个（memory_task list）`。
 * 返回 { lines（不含「### 待办」标题）, tokens, shown, overdue, total }。
 */
const TASK_INJECT_MAX = 5;
const TASK_TITLE_MAX = 40;

function buildTaskBlock(tasks, config, day) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { lines: [], tokens: 0, shown: 0, overdue: 0, total: 0 };
  const shown = tasks.slice(0, TASK_INJECT_MAX);
  const lines = shown.map(t => {
    const flag = t.dueAt && day && t.dueAt < day ? '⏰' : '·';
    const due = t.dueAt ? String(t.dueAt).slice(5) : ''; // MM-DD
    const title = String(t.title ?? '').slice(0, TASK_TITLE_MAX);
    return due ? `- ${flag} ${due} ${title}` : `- ${flag} ${title}`;
  });
  let hidden = tasks.length - shown.length;
  const more = () => (hidden > 0 ? [`- …另有 ${hidden} 个（memory_task list）`] : []);
  const rawBudget = Number(config.taskTokens);
  const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.trunc(rawBudget) : 100;
  // 待办块自身也受 taskTokens 约束（超长标题/大量溢出时不无限膨胀）
  while (lines.length > 1 && estTokens(['### 待办', ...lines, ...more()].join('\n')) > budget) {
    lines.pop();
    hidden += 1;
  }
  const bodyLines = [...lines, ...more()];
  return {
    lines: bodyLines,
    tokens: estTokens(['### 待办', ...bodyLines].join('\n')),
    shown: lines.length,
    overdue: tasks.filter(t => t.dueAt && day && t.dueAt < day).length,
    total: tasks.length,
  };
}

/**
 * L1 热索引（v0.9：作为注入快照的构建单元，可在刷新纪元内被冻结）。
 * v0.9-B：排除 task（走「待办」块）与 skill（提炼技能不进热索引）。
 * 返回 { lines, due, cold }；预算先按 L0/提醒/待办预留，最终由 buildInjection 做整块硬守卫。
 */
function buildL1(store, config, reservedTokens = 0) {
  const visible = store.visible().filter(e => e.kind !== 'task' && e.kind !== 'skill');
  const total = visible.length;
  const lines = [];
  let used = 0;
  const limitLines = Math.min(config.maxHotLines, 20);
  const l1Budget = config.budgetTokens - config.profileTokens - reservedTokens;
  for (const e of visible) {
    if (lines.length >= limitLines) break;
    const date = dayOf(e.updated || e.created);
    const tags = (e.tags || []).slice(0, 2).map(t => `#${t}`).join(' ');
    const mark = e.pinned ? '★' : '·';
    const line = `- ${mark} ${date} ${String(e.title).slice(0, 60)}${tags ? ' ' + tags : ''}`;
    const cost = estTokens(line);
    if (used + cost > l1Budget) break;
    lines.push(line);
    used += cost;
  }
  return { lines, due: store.due().length > 0, cold: Math.max(0, total - lines.length) };
}

/**
 * v0.9：缓存感知注入块。
 * - L1 热索引行 + "有记忆到期"阈值布尔走 store.getInjectionSnapshot（session/daily 冻结）；
 * - L0 画像与 C1 睡梦提醒仍实时（画像改动应立即生效，C1 只在事件/日界变化）；
 * - 硬预算守卫：整块 estTokens > budgetTokens 时从 L1 末尾逐行删（阈值行/规则行保留）。
 */
export function buildInjection(store, config, now = Date.now()) {
  const day = localDay(new Date(now));
  const profileRaw = fsSync.existsSync(store.profileFile)
    ? fsSync.readFileSync(store.profileFile, 'utf8')
    : '';
  const profile = clampText(profileRaw.replace(/^#.*\n+/, '').trim() || '（暂无画像）', config.profileTokens);

  const dream = dreamStatus(store, config, now);
  const reminder = [];
  if (dream) {
    reminder.push('### 睡梦');
    reminder.push(`- 欠梦（上次整理 ${dream.lastDay || '—'}）→ 建议先 memory_dream 做三阶段整理`);
  }
  const reminderTokens = reminder.length ? estTokens(reminder.join('\n')) : 0;

  // v0.9-B：待办块实时渲染（任务增删立即生效），但 token 要从 L1 可用预算里扣
  const tasks = typeof store.openTasks === 'function' ? store.openTasks() : [];
  const taskBlock = buildTaskBlock(tasks, config, day);
  const taskSection = taskBlock.lines.length
    ? ['### 待办', ...taskBlock.lines, ''].join('\n')
    : '';

  // 快照构建闭包：只有真正重建时才会被调用（live 每次都调）
  const reservedTokens = reminderTokens + taskBlock.tokens;
  const build = () => buildL1(store, config, reservedTokens);
  let snap;
  if (typeof store.getInjectionSnapshot === 'function') {
    snap = store.getInjectionSnapshot({ mode: config.injectionMode, day, build });
  } else {
    // 兜底：极简 store 形态（测试桩）也能渲染
    snap = { ...build(), day, reason: 'live', cached: false, builtAt: null };
  }

  // 复制一份，硬预算裁剪只作用于本次渲染，绝不改缓存里的数组
  const lines = Array.isArray(snap.lines) ? [...snap.lines] : [];
  let cold = Math.max(0, Math.trunc(Number(snap.cold) || 0));
  const dueLine = snap.due === true;
  // v0.9-B：有待办时 footer 增加一条闭环规则行
  const taskFooter = taskBlock.lines.length ? '> 完成待办后用 memory_task done 标记，并查看剩余。' : '';

  const compose = (ls, coldCount) => [
    '## 小肥鱼记忆（本地，跨会话）',
    '### 画像',
    profile,
    '',
    taskSection,
    ls.length > 0 ? '### 热索引（置顶★ / 显著性排序）' : '### 热索引',
    ...(ls.length > 0 ? ls : ['（还没有记忆）']),
    coldCount > 0 ? `\n> 冷区还有 ${coldCount} 条，需要时 memory_search 检索；memory_read 取全文。` : '',
    dueLine ? '> ⏰ 有记忆到期该复习（睡眠报告会列出，主动回顾能加固记忆）。' : '',
    reminder.join('\n'),
    taskFooter,
    '> 规则：只在结论时刻 memory_save；不确定就 memory_search 查证，查不到就说不知道，不要编。',
  ].filter(Boolean).join('\n');

  let body = compose(lines, cold);
  // v0.9 硬预算守卫：整块 ≤ budgetTokens，超出从 L1 末尾裁剪（修掉正文固定开销导致的越界）
  // v0.9-B：待办块实时变化时，快照冻结的 L1 行也由这里兜底收敛
  while (lines.length > 0 && estTokens(body) > config.budgetTokens) {
    lines.pop();
    cold += 1;
    body = compose(lines, cold);
  }

  return {
    text: body.trim() + '\n',
    l1Lines: lines.length,
    cold,
    due: dueLine ? 1 : 0, // v0.9：阈值布尔走快照，数字只为字段兼容（1=有到期）
    dreamDue: Boolean(dream),
    l1Tokens: estTokens(body),
    profileTokens: estTokens(profile),
    // v0.9-B：待办块观测（实时）
    tasksOpen: taskBlock.total,
    tasksOverdue: taskBlock.overdue,
    taskLines: taskBlock.shown,
    taskTokens: taskBlock.tokens,
    injection: {
      mode: config.injectionMode || 'session',
      day,
      reason: snap.reason || null,
      cached: snap.cached === true,
      builtAt: snap.builtAt || null,
    },
  };
}
