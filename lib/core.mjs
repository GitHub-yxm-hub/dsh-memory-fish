import { promises as fs } from 'node:fs';
import { SECRET_RE, similar, salienceFor, initialStability, addDays, slugify, stamp, nowIso, out, reinforce } from './util.mjs';
import { buildInjection } from './inject.mjs';

export async function saveMemoryCore(store, cfg, args) {
  const title = String(args.title ?? '').trim();
  const content = String(args.content ?? '').trim();
  if (!title || !content) return out({ ok: false, code: 'invalid_input', message: 'title 与 content 不能为空' });
  if (SECRET_RE.test(content) || SECRET_RE.test(title)) {
    return out({ ok: false, code: 'secret_refused', message: '疑似密钥/凭据，拒绝保存。请去掉敏感值后重试。' });
  }
  if (!store.entries.length) await store.load();

  const tags = (args.tags || []).map(t => String(t).trim()).filter(Boolean).slice(0, 3);
  const importance = Math.min(5, Math.max(1, Math.trunc(Number(args.importance) || 3)));
  const pin = args.pin === true;

  let target = null;
  let best = 0;
  for (const e of store.entries) {
    if (e.status !== 'active') continue;
    const sim = similar(`${e.title}\n${e.content ?? ''}`, `${title}\n${content}`);
    if (sim > best) { best = sim; target = e; }
  }

  // 新颖性门控：几乎一模一样 → NOOP，只记一次"被检索"（提取练习）
  if (target && best >= cfg.noopThreshold) {
    reinforce(target, 1.2);
    await store.saveIndex();
    return out({
      ok: true, saved: false, updated: false, noop: true, id: target.id,
      similarity: Number(best.toFixed(2)), reason: '与已有记忆几乎相同，已跳过写入（只记录一次复习）',
    });
  }

  // 显著性：编码阶段的"值不值得记"
  const novelty = best > 0 ? 1 - best : 1;
  const salience = Math.max(
    salienceFor({ title, content, importance, pin, novelty }),
    args.salience ? Math.min(10, Math.max(1, Math.trunc(Number(args.salience)))) : 0,
  );

  if (target && best >= cfg.dedupeThreshold) {
    const at = nowIso();
    try {
      const oldText = await fs.readFile(target.file, 'utf8');
      await store.archiveContent(target, oldText);
    } catch { /* 老文件丢了也继续 */ }
    // P3 时间有效性：旧版本封存为历史（带 validFrom/validTo），当前版本换新有效期
    target.history = [
      ...(target.history || []),
      {
        title: target.title,
        content: target.content,
        validFrom: target.validFrom || target.created || at,
        validTo: at,
      },
    ].slice(-10);
    target.title = title;
    target.content = content;
    target.tags = tags.length ? tags : target.tags;
    target.importance = Math.max(target.importance ?? 3, importance);
    target.pinned = target.pinned || pin;
    target.salience = Math.max(target.salience ?? 5, salience);
    target.updated = at;
    target.validFrom = at;
    target.validTo = null;
    // 再巩固：旧记忆被改写，复习节奏重新起算（但保留已有稳定性）
    target.lastReview = at;
    target.stability = Math.max(target.stability || initialStability(target.importance, target.salience), initialStability(target.importance, target.salience));
    target.nextReview = addDays(at, Math.round(target.stability));
    await store.writeMemory(target, content);
    await store.saveIndex();
    store.stats.updated += 1;
    await store.saveStats();
    return out({
      ok: true, saved: true, updated: true, id: target.id,
      similarity: Number(best.toFixed(2)), salience: target.salience,
      validFrom: target.validFrom, historyCount: (target.history || []).length, scope: 'user',
    });
  }

  const now = nowIso();
  const stability = initialStability(importance, salience);
  const id = `${stamp()}-${slugify(title)}`;
  const entry = {
    id, title, content, tags, importance, salience, pinned: pin,
    created: now, updated: now, validFrom: now, validTo: null, history: [],
    hits: 0, lastHit: null,
    status: 'active', supersedes: [], links: [], chars: 0, tokens: 0, file: '',
    stability, lastReview: now, nextReview: addDays(now, Math.round(stability)), reviews: 0,
  };
  await store.writeMemory(entry, content);
  store.entries.push(entry);
  await store.saveIndex();
  store.stats.saved += 1;
  await store.saveStats();
  const hot = buildInjection(store, cfg);
  return out({
    ok: true, saved: true, updated: false, id, novelty: Number(novelty.toFixed(2)), salience, stability,
    nextReview: entry.nextReview, validFrom: entry.validFrom, scope: 'user',
    indexLines: hot.l1Lines, coldRemaining: hot.cold, injectedTokens: hot.l1Tokens,
  });
}
