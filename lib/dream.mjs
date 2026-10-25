import { promises as fs } from 'node:fs';
import { localDay, jaccard, bigrams, similar, CANDIDATE_CUES, strengthOf, nowIso, profileRewriteStatus } from './util.mjs';

/** v0.8：最近 N 天睡梦报告的摘要（作为 mental model 重写的材料）。 */
async function recentDreamSummaries(store, now, count = 3) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const day = localDay(new Date(now - i * 86400000));
    const { content } = await store.readDreamReport(day);
    if (!String(content ?? '').trim()) continue;
    const summary = content.split('\n').filter(l => l.trim()).slice(0, 12)
      .map(l => (l.length > 160 ? l.slice(0, 160) + '…' : l)).join('\n');
    out.push({ day, summary });
  }
  return out;
}

/**
 * 做梦：三阶段睡眠（P0）
 *   Phase 1 SWS：重放 journal + 压缩近重复记忆（合并、原文进 archive）
 *   Phase 2 SHY：按显著性加权衰减，长期低分条目降级归档
 *   Phase 3 REM：建立"相关记忆"链接（只加链接，不改内容）
 * 并输出到期复习清单（P1）。
 */
export async function buildDream(store, cfg, days = cfg.dreamDays) {
  const records = await store.readJournal(days);
  const sessions = new Set(records.map(r => r.session).filter(Boolean));
  const userRecords = records.filter(r => r.role === 'user');
  const cues = [];
  const seen = [];
  for (const r of userRecords) {
    const text = String(r.text ?? '').trim();
    if (!text || text.length < 4) continue;
    if (!CANDIDATE_CUES.test(text)) continue;
    const sig = bigrams(text);
    if (seen.some(s => jaccard(s, sig) >= 0.6)) continue;
    seen.push(sig);
    cues.push({
      session: r.session || '',
      at: r.ts || '',
      text: text.length > 240 ? text.slice(0, 240) + '…' : text,
      explicit: /(记住|记一下|记下)/.test(text),
    });
    if (cues.length >= 20) break;
  }

  if (!store.entries.length) await store.load();
  const now = Date.now();

  // ---- Phase 1 · SWS：重放 + 压缩 ----
  const active = store.entries.filter(e => e.status === 'active').sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const merged = [];
  const removed = new Set();
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    if (removed.has(a.id)) continue;
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      if (removed.has(b.id)) continue;
      const sim = similar(`${a.title}\n${a.content ?? ''}`, `${b.title}\n${b.content ?? ''}`);
      if (sim < cfg.dedupeThreshold) continue;
      const keep = String(a.updated).localeCompare(String(b.updated)) >= 0 ? a : b;
      const drop = keep === a ? b : a;
      merged.push({ kept: keep.id, dropped: drop.id, similarity: Number(sim.toFixed(2)) });
      keep.supersedes = [...new Set([...(keep.supersedes || []), drop.id])];
      keep.salience = Math.max(keep.salience ?? 5, drop.salience ?? 5);
      try {
        const text = await fs.readFile(drop.file, 'utf8');
        await store.archiveContent(drop, text);
      } catch { /* 忽略 */ }
      drop.status = 'archived';
      drop.validTo = drop.validTo || nowIso();
      drop.pinned = false;
      removed.add(drop.id);
    }
  }

  // ---- Phase 2 · SHY：显著性加权衰减 ----
  const demoted = [];
  for (const e of store.entries) {
    if (e.status !== 'active' || e.pinned) continue;
    const ageDays = (now - new Date(e.updated || e.created).getTime()) / 86400000;
    const strength = strengthOf(e, now);
    const keepDays = (e.importance ?? 3) >= 4 ? cfg.archiveAfterDays * 3 : cfg.archiveAfterDays;
    if (ageDays > keepDays && strength < 0.12) {
      try {
        const text = await fs.readFile(e.file, 'utf8');
        await store.archiveContent(e, text);
      } catch { /* 忽略 */ }
      e.status = 'archived';
      e.validTo = e.validTo || nowIso();
      e.pinned = false;
      demoted.push({ id: e.id, title: e.title, ageDays: Math.round(ageDays), strength: Number(strength.toFixed(3)) });
    }
  }

  // ---- Phase 3 · REM：关联（tags 共现 + 相似度） ----
  const links = [];
  const live = store.entries.filter(e => e.status === 'active');
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (a.salience !== undefined && a.salience < 4) continue; // 低显著性的不建图，省空间
    const aTags = new Set((a.tags || []).map(t => t.toLowerCase()));
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      const bTags = new Set((b.tags || []).map(t => t.toLowerCase()));
      let shared = 0;
      for (const t of aTags) if (bTags.has(t)) shared++;
      const sim = similar(`${a.title}\n${a.content ?? ''}`, `${b.title}\n${b.content ?? ''}`);
      if (shared >= 1 || sim >= 0.5) {
        const rel = shared >= 1 ? `tag:${[...aTags].filter(t => bTags.has(t))[0]}` : `sim:${sim.toFixed(2)}`;
        a.links = [...new Set([...(a.links || []), b.id])].slice(-12);
        b.links = [...new Set([...(b.links || []), a.id])].slice(-12);
        links.push({ a: a.id, b: b.id, relation: rel });
      }
    }
  }

  // ---- 复习清单（P1） ----
  const due = store.due(now).map(e => ({
    id: e.id, title: e.title, dueAt: e.nextReview,
    stability: e.stability, hits: e.hits || 0, salience: e.salience ?? 5,
  }));

  // ---- Phase 4 · Mental model（v0.8）：L0 画像到期 → 生成给 subagent 的重写任务 ----
  const mm = profileRewriteStatus(cfg, store.stats, now);
  const day = localDay();
  let mentalTaskFile = null;
  if (mm.enabled && mm.due) {
    let profileRaw = '';
    try { profileRaw = await fs.readFile(store.profileFile, 'utf8'); } catch { /* 还没有画像 */ }
    const recent = store.entries
      .filter(e => e.status === 'active')
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
      .slice(0, 20)
      .map(e => {
        const excerpt = String(e.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        return `- \`${e.id}\` ${e.title}${(e.tags || []).length ? ' [' + e.tags.join(', ') + ']' : ''}\n  ${excerpt}`;
      });
    const summaries = await recentDreamSummaries(store, now, 3);
    const taskPath = `dream/${day}-mental-model.md`;
    const taskBody = [
      `# 🧠 Mental model 重写任务 · ${day}`,
      '',
      `- 触发原因：L0 画像${mm.lastRewrite ? `距上次重写 ${mm.daysSince} 天` : '从未自动重写过'}（阈值 ${mm.everyDays} 天）`,
      `- 当前画像：${store.profileFile}`,
      `- 本任务文件：${taskPath}`,
      `- 生成时间：${nowIso()}`,
      '',
      '## 1. 当前 L0 画像',
      '',
      profileRaw.trim() || '（还没有画像）',
      '',
      '## 2. 最近 20 条活跃记忆',
      '',
      ...(recent.length ? recent : ['（还没有记忆）']),
      '',
      '## 3. 最近 3 天睡梦摘要',
      '',
      ...(summaries.length ? summaries.flatMap(s => [`### ${s.day}`, '', s.summary, '']) : ['（暂无睡梦报告）', '']),
      '## 4. 给 subagent 的指令',
      '',
      '你是「画像重写员」。任务：根据给定材料，重写 dsh-memory-fish 的 L0 画像。',
      '',
      '材料：',
      `1) 当前画像：${store.profileFile}`,
      `2) 本任务文件：${taskPath}`,
      '',
      '要求：',
      '- 只写"一个月后仍成立"的事实：称呼、身份、偏好、硬约束、雷点；',
      '- 不写项目细节、不写过程状态、不写密钥；',
      '- 中文，祈使句，≤200 tokens（约 200 个汉字）；',
      '- 输出格式：先给画像正文（不要标题），再另起一行写 "TOKENS: <估算值>"；',
      '- 不要调用任何工具，只返回文本。',
      '',
      '完成后由主 agent 负责：memory_profile_archive 归档旧画像 → 校验长度与密钥 → memory_profile_save 落盘。',
      '',
    ].join('\n');
    mentalTaskFile = await store.saveMentalModelTask(day, taskBody);
  }

  const lines = [
    `# 睡梦报告 ${day}`,
    '',
    `- 回顾范围：最近 ${days} 天`,
    `- 会话数：${sessions.size}，对话条数：${records.length}（用户 ${userRecords.length} 条）`,
    '',
    '## 🌊 Phase 1 · SWS 慢波：重放 + 压缩',
    `- 合并近似记忆：${merged.length} 组`,
    ...(merged.length ? merged.map(m => `  - 保留 ${m.kept} ← 归档 ${m.dropped}（相似度 ${m.similarity}）`) : ['  - （无需合并）']),
    '',
    '## 🌙 Phase 2 · SHY 稳态：显著性加权衰减',
    `- 降级归档：${demoted.length} 条`,
    ...(demoted.length ? demoted.map(d => `  - ${d.title}（${d.ageDays} 天未动，强度 ${d.strength}）`) : ['  - （没有需要遗忘的）']),
    '',
    '## 💭 Phase 3 · REM：联想链接',
    `- 新建关联：${links.length} 条`,
    ...(links.length ? links.slice(0, 10).map(l => `  - ${l.a} ↔ ${l.b}（${l.relation}）`) : ['  - （暂无可关联）']),
    ...(mm.enabled ? [
      '',
      '## 🧠 Mental model（Phase 4 · L0 画像自动重写）',
      mm.due
        ? `- 画像到期：是 → 任务文件：${mentalTaskFile}`
        : `- 画像到期：否（上次重写 ${mm.lastRewrite ? mm.daysSince + ' 天前' : '未知'}，每 ${mm.everyDays} 天一次）`,
      ...(mm.due ? ['- 下一步：先 memory_profile_archive 归档旧画像，再用 subagent 按任务文件重写，最后 memory_profile_save 落盘。'] : []),
    ] : []),
    '',
    '## ⏰ 待复习（间隔重复）',
    ...(due.length ? due.map(d => `- [ ] ${d.title}（稳定 ${d.stability ?? '?'} 天，命中 ${d.hits} 次）`) : ['- （暂无到期）']),
    '',
    '## 候选（值得考虑写入长期记忆）',
    ...(cues.length ? cues.map((c, i) => `${i + 1}. [${c.at ? c.at.slice(0, 16).replace('T', ' ') : '—'}] ${c.text}${c.explicit ? ' （明确要求记住）' : ''}`) : ['（没有发现候选）']),
    '',
    '## 处理建议',
    '- 候选逐条判断："一个月后仍成立"才写，明确"记住"的直接写。',
    '- 待复习条目：主动以一句话回顾，能加固记忆（提取练习效应）。',
    '- 然后执行 memory_consolidate 收尾。',
    '',
  ].join('\n');

  await store.saveIndex();
  const file = await store.saveDreamReport(day, lines);
  store.stats.dreams = (store.stats.dreams || 0) + 1;
  store.stats.lastDream = nowIso();
  store.stats.capturedSinceDream = 0;
  await store.saveStats();

  return {
    day, days,
    sessions: sessions.size, messages: records.length, userMessages: userRecords.length,
    cues,
    phases: {
      sws: { mergedCount: merged.length, merged },
      shy: { demotedCount: demoted.length, demoted },
      rem: { linkCount: links.length, links: links.slice(0, 30) },
    },
    mentalModel: { ...mm, taskFile: mentalTaskFile },
    due,
    report: lines, file,
  };
}
