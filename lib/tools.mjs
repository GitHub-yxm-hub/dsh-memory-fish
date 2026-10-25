import { promises as fs } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { out, nowIso, dayOf, similar, reinforce, SECRET_RE, estTokens, clampToBudget, profileRewriteStatus } from './util.mjs';
import { buildInjection } from './inject.mjs';
import { saveMemoryCore } from './core.mjs';
import { buildDream } from './dream.mjs';
import { atomicWrite } from './store.mjs';
import { withLock } from './lock.mjs';
import { log } from './log.mjs';

/** 需要串行化的写操作：跨进程锁 + 写前重读索引。 */
const MUTATING = new Set(['memory_save', 'memory_pin', 'memory_forget', 'memory_profile_save', 'memory_profile_archive', 'memory_consolidate', 'memory_dream']);

export function registerTools(ctx, store, cfg, toolImpl) {
  const register = (def) => {
    const original = def.execute;
    if (MUTATING.has(def.name) && typeof original === 'function') {
      def.execute = async (args, exec) => withLock(store.dir, async () => {
        await store.load();
        return original.call(def, args, exec);
      });
    }
    toolImpl[def.name] = def;
    try {
      ctx.tools.register(defineTool(def));
    } catch (error) {
      log.warn('tool register failed', def.name, error);
    }
  };

  // ---- memory_save ----
  register({
    name: 'memory_save',
    description: '保存一条跨会话记忆。只存"一个月后仍然成立"的结论：偏好、纠正、决策及其理由、排障闭环、关键数字/ID。不要存过程状态、临时错误、仓库里能直接读到的东西、密钥。同主题会原地更新（自动去重），不会重复堆积。内容写成给未来 agent 的祈使句，2-5 句，自包含。',
    parameters: {
      title: { type: 'string', required: true, description: '短标题（≤40 字），会成为热索引的一行。' },
      content: { type: 'string', required: true, description: '记忆正文，2-5 句自包含的祈使句。' },
      tags: { type: 'array', items: { type: 'string' }, description: '至多 3 个标签。' },
      importance: { type: 'number', description: '重要度 1-5（默认 3；用户明确要求记住=5）。' },
      pin: { type: 'boolean', description: '是否置顶（置顶记忆永远在热索引最前，不参与衰减）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      return await saveMemoryCore(store, cfg, args);
    },
  });

  // ---- memory_search ----
  register({
    name: 'memory_search',
    description: '在本地记忆里做关键词检索（标题/标签/正文，大小写不敏感），返回相关条目摘要。当过去的偏好、决策或上下文可能相关时先用它查证，不要直接重问用户。默认只搜"当前有效"的记忆；asOf="2026-09-01" 可按时间点查历史版本（回答"上个月我们用什么方案"）；includeArchived=true 会连冷档案一起搜。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词或短语。' },
      limit: { type: 'number', description: '最多返回条数（默认 8，最大 20）。' },
      asOf: { type: 'string', description: '时间点（ISO 日期），查那一刻有效的记忆版本；省略则只看当前有效版本。' },
      includeArchived: { type: 'boolean', description: '是否包含已归档的冷记忆（默认 false）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      const q = String(args.query ?? '').trim();
      if (!q) return out({ ok: false, code: 'invalid_input', message: 'query 不能为空' });
      const limit = Math.min(20, Math.max(1, Math.trunc(Number(args.limit) || 8)));
      if (!store.entries.length) await store.load();
      const lower = q.toLowerCase();
      const asOfMs = args.asOf ? new Date(String(args.asOf)).getTime() : NaN;
      const hasAsOf = Number.isFinite(asOfMs);
      const pool = args.includeArchived === true ? store.entries : store.entries.filter(e => e.status === 'active');
      const nowMs = Date.now();

      // 每条记忆可能有多"代"内容（history），统一展开成带有效期的版本
      const versions = [];
      for (const e of pool) {
        const current = {
          entry: e, title: e.title, content: e.content ?? '',
          validFrom: e.validFrom || e.created || '',
          validTo: e.validTo || null,
          historical: false,
        };
        const hist = (e.history || []).map(h => ({
          entry: e, title: h.title || e.title, content: h.content ?? '',
          validFrom: h.validFrom || '', validTo: h.validTo || null, historical: true,
        }));
        versions.push(...hist, current);
      }

      const inRange = (v) => {
        if (!hasAsOf) return v.historical === false; // 默认只看当前有效版本
        const from = new Date(v.validFrom).getTime();
        const to = v.validTo ? new Date(v.validTo).getTime() : nowMs;
        return Number.isFinite(from) && from <= asOfMs && asOfMs <= to;
      };

      const hits = [];
      for (const v of versions) {
        if (!inRange(v)) continue;
        const e = v.entry;
        let score = 0;
        if (String(v.title).toLowerCase().includes(lower)) score += 3;
        if ((e.tags || []).some(t => String(t).toLowerCase().includes(lower))) score += 2;
        let body = v.content;
        if (!body) {
          try { body = (await fs.readFile(e.file, 'utf8')).replace(/^---[\s\S]*?---\n\n?/, ''); } catch { body = ''; }
        }
        if (body.toLowerCase().includes(lower)) score += 1;
        if (score > 0) {
          const idx = body.toLowerCase().indexOf(lower);
          const start = Math.max(0, idx - 40);
          const excerpt = (start > 0 ? '…' : '') + body.slice(start, idx + lower.length + 60).replace(/\s+/g, ' ').trim();
          hits.push(out({
            id: e.id, title: v.title, tags: e.tags || [], scope: 'user', status: e.status,
            importance: e.importance ?? 3, updated: dayOf(v.validFrom), score, excerpt,
            validFrom: dayOf(v.validFrom), validTo: v.validTo ? dayOf(v.validTo) : null,
            historical: v.historical,
          }));
        }
      }
      hits.sort((a, b) => b.score - a.score || String(b.validFrom).localeCompare(String(a.validFrom)));
      const top = hits.slice(0, limit);
      for (const h of top) {
        if (h.historical) continue; // 历史版本不参与复习加固
        const e = store.byId(h.id);
        if (e && cfg.reviewEnabled) reinforce(e, 1.3); // 提取练习：命中即加固
        else if (e) { e.hits = (e.hits || 0) + 1; e.lastHit = nowIso(); }
      }
      if (top.some(h => !h.historical)) { await store.saveIndex(); store.stats.searches += 1; await store.saveStats(); }
      return out({
        query: q, asOf: hasAsOf ? dayOf(new Date(asOfMs).toISOString()) : null,
        total: hits.length, returned: top.length, matches: top,
      });
    },
  });

  // ---- memory_read ----
  register({
    name: 'memory_read',
    description: '按 id 读取一条记忆的全文（超过 4000 字符会截断并给出本地路径）。id 来自 memory_search 或 memory_list。读取本身也是一次复习，会轻微加固记忆。',
    parameters: { id: { type: 'string', required: true, description: '记忆 id。' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      const safe = String(args.id ?? '').trim();
      const e = store.byId(safe);
      if (!e) return out({ ok: false, code: 'not_found', message: `没有 id 为 ${safe} 的记忆，先用 memory_search 找。` });
      let content = '';
      try { content = await fs.readFile(e.file, 'utf8'); } catch {
        content = `# ${e.title}\n\n${e.content ?? ''}`;
      }
      const body = content;
      const truncated = body.length > 4000;
      if (cfg.reviewEnabled) {
        reinforce(e, 1.1);
        await store.saveIndex();
      }
      return out({
        ok: true, id: e.id, title: e.title, status: e.status, tags: e.tags || [],
        importance: e.importance ?? 3, salience: e.salience ?? 5,
        stability: e.stability, nextReview: e.nextReview,
        validFrom: e.validFrom || e.created, validTo: e.validTo || null,
        historyCount: (e.history || []).length,
        created: e.created, updated: e.updated,
        content: truncated ? body.slice(0, 4000) : body,
        truncated, local_file: e.file, size_bytes: Buffer.byteLength(body, 'utf8'),
      });
    },
  });

  // ---- memory_list ----
  register({
    name: 'memory_list',
    description: '列出最近的活跃记忆（置顶优先，其次按更新时间倒序）。用于快速了解记住过什么。',
    parameters: { limit: { type: 'number', description: '最多条数（默认 8，最大 50）。' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      if (!store.entries.length) await store.load();
      const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit) || 8)));
      const visible = store.visible();
      const entries = visible.slice(0, limit).map(e => out({
        id: e.id, title: e.title, pinned: !!e.pinned, tags: e.tags || [],
        importance: e.importance ?? 3, updated: dayOf(e.updated), hits: e.hits || 0,
      }));
      const archived = store.entries.filter(e => e.status !== 'active').length;
      return out({ ok: true, total: visible.length, archived, returned: entries.length, entries });
    },
  });

  // ---- memory_pin ----
  register({
    name: 'memory_pin',
    description: '置顶或取消置顶一条记忆。置顶记忆永远出现在热索引最前，不参与衰减归档。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆 id。' },
      pinned: { type: 'boolean', description: 'true 置顶，false 取消（默认 true）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      const e = store.byId(String(args.id ?? '').trim());
      if (!e) return out({ ok: false, code: 'not_found', message: '没有找到该记忆' });
      e.pinned = args.pinned === false ? false : true;
      e.updated = nowIso();
      await store.saveIndex();
      return out({ ok: true, id: e.id, pinned: e.pinned, title: e.title });
    },
  });

  // ---- memory_forget ----
  register({
    name: 'memory_forget',
    description: '遗忘一条记忆（软删除：状态标记 deleted 并移出索引，文件保留在冷档案，不会被压缩复活）。用户明确要求"忘掉"时使用。',
    parameters: { id: { type: 'string', required: true, description: '记忆 id。' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      const e = store.byId(String(args.id ?? '').trim());
      if (!e) return out({ ok: false, code: 'not_found', message: '没有找到该记忆' });
      try {
        const text = await fs.readFile(e.file, 'utf8');
        await store.archiveContent(e, text);
      } catch { /* 文件可能已不在 */ }
      e.status = 'deleted';
      e.validTo = e.validTo || nowIso();
      e.pinned = false;
      e.updated = nowIso();
      try { await fs.unlink(e.file); } catch { /* 已删除 */ }
      await store.saveIndex();
      return out({ ok: true, id: e.id, forgotten: true, title: e.title });
    },
  });

  // ---- memory_profile_save ----
  register({
    name: 'memory_profile_save',
    description: '写入 L0 画像（每次会话都常驻注入的一小段文字，预算约 200 tokens）。只放"关于铁凝的事实与硬约束"：称呼、身份、偏好、雷点。不是记忆条目，别放项目细节。超长内容会硬截断到 profileTokens 预算内；写入成功即记一次「画像重写」，供 mental model 到期判断。',
    parameters: {
      content: { type: 'string', required: true, description: '画像正文（Markdown，纯文本也行），会按预算截断。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      const raw = String(args.content ?? '').trim();
      if (!raw) return out({ ok: false, code: 'invalid_input', message: 'content 不能为空' });
      if (SECRET_RE.test(raw)) return out({ ok: false, code: 'secret_refused', message: '疑似密钥/凭据，拒绝写入画像。' });
      const content = clampToBudget(raw, cfg.profileTokens);
      const truncated = content !== raw;
      const body = `# 小肥鱼记忆 · L0 画像\n\n${content}\n`;
      await atomicWrite(store.profileFile, body);
      // v0.8：记一次画像重写，dream 据此判断 mental model 是否到期
      store.stats.lastProfileRewrite = nowIso();
      store.stats.profileRewrites = (store.stats.profileRewrites || 0) + 1;
      await store.saveStats();
      return out({
        ok: true, saved: true, tokens: estTokens(content), budget: cfg.profileTokens,
        truncated, lastRewrite: store.stats.lastProfileRewrite, rewrites: store.stats.profileRewrites,
      });
    },
  });

  // ---- memory_profile_archive（v0.8）----
  register({
    name: 'memory_profile_archive',
    description: '把当前 L0 画像复制到 profile-history/YYYYMMDD-HHmmss.md（mental model 重写前先归档，保留可回滚历史）。只复制，不改动当前画像，也不影响记忆条目。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute() {
      const res = await store.archiveProfile();
      if (!res) return out({ ok: false, code: 'no_profile', message: '当前还没有画像可归档。' });
      return out({ ok: true, archived: true, file: res.file, tokens: res.tokens, at: res.at });
    },
  });

  // ---- memory_dream ----
  register({
    name: 'memory_dream',
    description: '睡梦机制（三阶段）：SWS 重放+压缩近似记忆、SHY 显著性加权衰减、REM 建立联想链接；同时输出到期复习清单。v0.8 起还有 Phase 4 · Mental model：L0 画像到期时生成 dream/YYYY-MM-DD-mental-model.md 重写任务（由 subagent 执行，不占主上下文）。默认只报告不自动保存（autoSave=true 时只自动保存用户明确说"记住…"的句子）。做完梦后：若「画像到期：是」先 memory_profile_archive、再用 subagent 重写并 memory_profile_save；然后逐条判断候选、memory_save 值得留下的，再 memory_consolidate。',
    parameters: {
      days: { type: 'number', description: '回顾最近几天（默认 2）。' },
      autoSave: { type: 'boolean', description: '是否自动保存"明确要求记住"的候选（默认 false）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      const days = Math.min(30, Math.max(1, Math.trunc(Number(args.days) || cfg.dreamDays)));
      const dream = await buildDream(store, cfg, days);
      const autoSaved = [];
      if (args.autoSave === true) {
        for (const c of dream.cues) {
          if (!c.explicit) continue;
          const raw = c.text.replace(/^.*?(记住|记一下|记下)[:：]?\s*/, '').trim();
          if (!raw) continue;
          const title = raw.slice(0, 30);
          const r = await saveMemoryCore(store, cfg, { title, content: raw, tags: ['睡眠提炼'], importance: 4 });
          autoSaved.push({ title, id: r.id, updated: r.updated === true, noop: r.noop === true, ok: r.ok });
        }
      }
      // v0.9：睡眠整理了记忆/画像 → L1 热索引快照失效，下轮注入重建
      await store.invalidateInjection('dream');
      return out({
        ok: true, day: dream.day, days, sessions: dream.sessions, messages: dream.messages,
        phases: {
          sws: dream.phases.sws.mergedCount,
          shy: dream.phases.shy.demotedCount,
          rem: dream.phases.rem.linkCount,
        },
        dueReview: dream.due,
        cues: dream.cues.length,
        mentalModel: dream.mentalModel,
        candidates: dream.cues.map(c => ({ at: c.at, session: c.session, text: c.text, explicit: c.explicit })),
        autoSaved, reportFile: dream.file, report: dream.report,
      });
    },
  });

  // ---- memory_stats ----
  register({
    name: 'memory_stats',
    description: '查看记忆占用统计：活跃/归档条数、L0+L1 注入 token、磁盘字符量、检索次数、画像重写状态。用于确认上下文成本是否恒定。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute() {
      if (!store.entries.length) await store.load();
      const hot = buildInjection(store, cfg);
      const active = store.entries.filter(e => e.status === 'active');
      const archived = store.entries.filter(e => e.status !== 'active');
      const totalChars = store.entries.reduce((n, e) => n + (e.chars || 0), 0);
      const due = store.due();
      const salienceAvg = active.length
        ? Number((active.reduce((n, e) => n + (e.salience ?? 5), 0) / active.length).toFixed(1))
        : 0;
      const mm = profileRewriteStatus(cfg, store.stats);
      return out({
        ok: true,
        active: active.length, archived: archived.length, pinned: active.filter(e => e.pinned).length,
        dueReview: due.length,
        salienceAvg,
        reviews: active.reduce((n, e) => n + (e.reviews || 0), 0),
        l1Lines: hot.l1Lines, coldRemaining: hot.cold,
        injectedL0Tokens: hot.profileTokens, injectedL1Tokens: hot.l1Tokens,
        budgetTokens: cfg.budgetTokens,
        profileTokens: cfg.profileTokens,
        diskChars: totalChars,
        hits: store.stats.searches, saved: store.stats.saved, updated: store.stats.updated,
        captured: store.stats.captured || 0,
        dreams: store.stats.dreams || 0,
        lastDream: store.stats.lastDream || null,
        lastConsolidate: store.stats.lastConsolidate,
        mentalModel: mm.enabled,
        lastProfileRewrite: mm.lastRewrite,
        profileRewrites: store.stats.profileRewrites || 0,
        profileRewriteDue: mm.due,
        mentalModelEveryDays: mm.everyDays,
        // v0.9：注入快照观测（重建次数/最近原因/缓存日期）
        injectionMode: cfg.injectionMode,
        injectionRebuilds: store.stats.injectionRebuilds || 0,
        lastInjectionRebuild: store.stats.lastInjectionRebuild || null,
        injectionCacheDay: store.injectionCache?.day || null,
      });
    },
  });

  // ---- memory_consolidate ----
  register({
    name: 'memory_consolidate',
    description: '手动整理记忆：合并同主题近似条目（相似度≥0.75，旧的归档、新的保留并记录 supersede）、衰减归档长期未用的低重要度记忆。纯本地规则，不调用 LLM。返回整理报告。',
    parameters: { dryRun: { type: 'boolean', description: '只报告不修改（默认 false）。' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    async execute(args) {
      if (!store.entries.length) await store.load();
      const dry = args.dryRun === true;
      const merged = [];
      const archived = [];
      const now = Date.now();

      // 1) 合并近似条目
      const active = store.entries.filter(e => e.status === 'active').sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
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
          if (!dry) {
            keep.supersedes = [...new Set([...(keep.supersedes || []), drop.id])];
            try {
              const text = await fs.readFile(drop.file, 'utf8');
              await store.archiveContent(drop, text);
            } catch { /* 忽略 */ }
            drop.status = 'archived';
            drop.validTo = drop.validTo || nowIso();
            drop.pinned = false;
            drop.updated = nowIso();
            removed.add(drop.id);
          } else {
            removed.add(drop.id);
          }
        }
      }

      // 2) 衰减归档：>archiveAfterDays 天未更新、低重要度、未置顶、从未被检索
      for (const e of store.entries) {
        if (e.status !== 'active' || e.pinned) continue;
        if ((e.importance ?? 3) >= 4 || (e.hits || 0) > 0) continue;
        const ageDays = (now - new Date(e.updated || e.created).getTime()) / 86400000;
        if (ageDays > cfg.archiveAfterDays) {
          if (!dry) {
            try {
              const text = await fs.readFile(e.file, 'utf8');
              await store.archiveContent(e, text);
            } catch { /* 忽略 */ }
            e.status = 'archived';
            e.validTo = e.validTo || nowIso();
            e.updated = nowIso();
          }
          archived.push({ id: e.id, ageDays: Math.round(ageDays) });
        }
      }

      if (!dry) {
        await store.saveIndex();
        store.stats.consolidations += 1;
        store.stats.lastConsolidate = nowIso();
        await store.saveStats();
        // v0.9：整理会合并/归档记忆 → L1 热索引快照失效
        await store.invalidateInjection('consolidate');
      }
      const hot = buildInjection(store, cfg);
      return out({
        ok: true, dryRun: dry,
        mergedCount: merged.length, archivedCount: archived.length,
        merged, archived,
        activeAfter: store.entries.filter(e => e.status === 'active').length,
        injectedL1Tokens: hot.l1Tokens, budgetTokens: cfg.budgetTokens,
      });
    },
  });

}
