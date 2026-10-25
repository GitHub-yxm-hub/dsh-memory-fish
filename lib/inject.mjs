import fsSync from 'node:fs';
import { clampText, estTokens, dayOf, isDue } from './util.mjs';

// ---------------------------------------------------------------- 注入

export function buildInjection(store, config) {
  const profileRaw = fsSync.existsSync(store.profileFile)
    ? fsSync.readFileSync(store.profileFile, 'utf8')
    : '';
  const profile = clampText(profileRaw.replace(/^#.*\n+/, '').trim() || '（暂无画像）', config.profileTokens);

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
    if (used + cost > config.budgetTokens - config.profileTokens) break;
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
    '> 规则：只在结论时刻 memory_save；不确定就 memory_search 查证，查不到就说不知道，不要编。',
  ].filter(Boolean).join('\n');

  return { text: body.trim() + '\n', l1Lines: shown, cold, due: due.length, l1Tokens: estTokens(body), profileTokens: estTokens(profile) };
}
