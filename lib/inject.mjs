import fsSync from 'node:fs';
import { clampText, estTokens, dayOf } from './util.mjs';

// ---------------------------------------------------------------- 注入

/**
 * C1 睡梦提醒：不依赖宿主调度器，在注入时按"欠一次梦"判断。
 * 条件：距上次做梦 >= dreamAfterHours，或存在到期复习；且确有新对话/复习项。
 */
function dreamStatus(store, config, now = Date.now()) {
  if (config.dreamReminder === false) return null;
  const last = store.stats?.lastDream ? new Date(store.stats.lastDream).getTime() : 0;
  const ageHours = Number.isFinite(last) ? Math.floor((now - (last || 0)) / 3600000) : Infinity;
  const captured = store.stats?.capturedSinceDream || 0;
  const dueCount = store.due().length;
  const overdue = !Number.isFinite(ageHours) ? true : ageHours >= Number(config.dreamAfterHours ?? 24);
  if (!overdue && dueCount === 0) return null;
  if (captured === 0 && dueCount === 0) return null;
  return { ageHours: Number.isFinite(ageHours) ? ageHours : null, captured, dueCount, overdue };
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
    const parts = [];
    if (dream.ageHours !== null) parts.push(`距上次做梦 ${dream.ageHours} 小时`);
    if (dream.captured > 0) parts.push(`新增对话 ${dream.captured} 条`);
    if (dream.dueCount > 0) parts.push(`${dream.dueCount} 条记忆到期该复习`);
    reminder.push(`- ${parts.join(' · ')} → 建议先 memory_dream 做三阶段整理`);
  }
  const reminderTokens = reminder.length ? estTokens(reminder.join('\n')) : 0;

  const visible = store.visible();
  const total = visible.length;
  const lines = [];
  let used = 0;
  const limitLines = Math.min(config.maxHotLines, 20);
  const due = store.due();
  const dueIds = new Set(due.map(e => e.id));
  for (const e of visible) {
    if (lines.length >= limitLines) break;
    const date = dayOf(e.updated || e.created);
    const tags = (e.tags || []).slice(0, 2).map(t => `#${t}`).join(' ');
    const mark = dueIds.has(e.id) ? '⏰' : (e.pinned ? '★' : '·');
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
    shown > 0 ? '### 热索引（置顶★ / 到期⏰ / 显著性排序）' : '### 热索引',
    ...(shown > 0 ? lines : ['（还没有记忆）']),
    cold > 0 ? `\n> 冷区还有 ${cold} 条，需要时 memory_search 检索；memory_read 取全文。` : '',
    due.length > 0 ? `> ⏰ ${due.length} 条记忆已到复习期（睡眠摘要里会列出，主动回顾能加固记忆）。` : '',
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
