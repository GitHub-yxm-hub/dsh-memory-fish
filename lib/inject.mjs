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

export function buildInjection(store, config) {
  const profileRaw = fsSync.existsSync(store.profileFile)
    ? fsSync.readFileSync(store.profileFile, 'utf8')
    : '';
  const profile = clampText(profileRaw.replace(/^#.*\n+/, '').trim() || '（暂无画像）', config.profileTokens);

  const dream = dreamStatus(store, config);
  const reminder = [];
  if (dream) {
    reminder.push('### 睡梦');
    reminder.push(`- 欠梦（上次整理 ${dream.lastDay || '—'}）→ 建议先 memory_dream 做三阶段整理`);
  }
  const reminderTokens = reminder.length ? estTokens(reminder.join('\n')) : 0;

  const visible = store.visible();
  const total = visible.length;
  const lines = [];
  let used = 0;
  const limitLines = Math.min(config.maxHotLines, 20);
  const due = store.due();
  for (const e of visible) {
    if (lines.length >= limitLines) break;
    const date = dayOf(e.updated || e.created);
    const tags = (e.tags || []).slice(0, 2).map(t => `#${t}`).join(' ');
    const mark = e.pinned ? '★' : '·';
    const line = `- ${mark} ${date} ${String(e.title).slice(0, 60)}${tags ? ' ' + tags : ''}`;
    const cost = estTokens(line);
    if (used + cost > config.budgetTokens - config.profileTokens - reminderTokens) break;
    lines.push(line);
    used += cost;
  }

  const shown = lines.length;
  const cold = Math.max(0, total - shown);
  const body = [
    '## 小肥鱼记忆（本地，跨会话）',
    '### 画像',
    profile,
    '',
    shown > 0 ? '### 热索引（置顶★ / 显著性排序）' : '### 热索引',
    ...(shown > 0 ? lines : ['（还没有记忆）']),
    cold > 0 ? `\n> 冷区还有 ${cold} 条，需要时 memory_search 检索；memory_read 取全文。` : '',
    due.length > 0 ? '> ⏰ 有记忆到期该复习（睡眠报告会列出，主动回顾能加固记忆）。' : '',
    reminder.join('\n'),
    '> 规则：只在结论时刻 memory_save；不确定就 memory_search 查证，查不到就说不知道，不要编。',
  ].filter(Boolean).join('\n');

  return {
    text: body.trim() + '\n',
    l1Lines: shown,
    cold,
    due: due.length,
    dreamDue: Boolean(dream),
    l1Tokens: estTokens(body),
    profileTokens: estTokens(profile),
  };
}
