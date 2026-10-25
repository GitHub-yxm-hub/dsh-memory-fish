import { promises as fs } from 'node:fs';
import { SECRET_RE, similar, salienceFor, initialStability, addDays, slugify, stamp, nowIso, out, reinforce, localDay } from './util.mjs';
import { buildInjection } from './inject.mjs';

export async function saveMemoryCore(store, cfg, args) {
  const title = String(args.title ?? '').trim();
  const content = String(args.content ?? '').trim();
  if (!title || !content) return out({ ok: false, code: 'invalid_input', message: 'title 与 content 不能为空' });
  // v0.9-B：记忆类型只允许 fact | skill（task 由 memory_task 创建）
  const kind = String(args.kind ?? 'fact').trim() || 'fact';
  if (kind !== 'fact' && kind !== 'skill') {
    return out({ ok: false, code: 'invalid_input', message: 'kind 只支持 fact | skill；待办任务请用 memory_task 创建' });
  }
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
    if (e.status !== 'active' || e.kind === 'task') continue; // v0.9-B：task 不参与记忆去重
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
    target.kind = kind; // v0.9-B：更新后的类型以本次写入为准
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
    id, title, content, tags, importance, salience, pinned: pin, kind,
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
    ok: true, saved: true, updated: false, id, kind, novelty: Number(novelty.toFixed(2)), salience, stability,
    nextReview: entry.nextReview, validFrom: entry.validFrom, scope: 'user',
    indexLines: hot.l1Lines, coldRemaining: hot.cold, injectedTokens: hot.l1Tokens,
  });
}

// ---------------------------------------------------------------- v0.9-B 待办任务（kind='task'）

const TASK_ACTIONS = ['add', 'done', 'drop', 'list'];

/**
 * dueAt 规范化：纯日期（YYYY-MM-DD）按**本地日**解释；其它可解析日期取本地日。
 * 空值返回 ''；非法返回 false（调用方据此回 invalid_input）。
 */
export function normalizeDueAt(input) {
  if (input === undefined || input === null) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return false;
    return localDay(dt);
  }
  const t = new Date(raw);
  if (!Number.isFinite(t.getTime())) return false;
  return localDay(t);
}

function clampPriority(input) {
  const n = Math.trunc(Number(input));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function taskSummary(t) {
  return { id: t.id, title: t.title, dueAt: t.dueAt || null, priority: t.priority ?? 3, taskStatus: t.taskStatus || 'open' };
}

function taskDetail(t) {
  return {
    id: t.id, title: t.title, content: t.content ?? '',
    kind: 'task', taskStatus: t.taskStatus || 'open',
    dueAt: t.dueAt || null, doneAt: t.doneAt || null,
    priority: t.priority ?? 3, note: t.note || '',
    created: t.created, updated: t.updated,
  };
}

function openSummaries(store) {
  return store.openTasks().map(taskSummary);
}

async function persistTask(store, task) {
  await store.writeMemory(task, task.content ?? '');
  await store.saveIndex();
  await store.saveStats();
}

/**
 * v0.9-B：待办任务核心（memory_task 的实现）。
 * - add：按 open task 相似度去重（≥ dedupeThreshold 合并更新）；dueAt 规范化；priority 1-5；
 * - done / drop：只允许 open → done/dropped，记录 doneAt；
 * - list：按 逾期 → dueAt → priority 排序；
 * - 所有写操作返回 remaining（open 摘要），形成"完成后查看剩余"闭环。
 */
export async function taskCore(store, cfg, args = {}) {
  const action = String(args.action ?? '').trim();
  if (!TASK_ACTIONS.includes(action)) {
    return out({ ok: false, code: 'invalid_input', message: 'action 只支持 add | done | drop | list' });
  }
  if (!store.entries.length) await store.load();
  const today = localDay();

  if (action === 'list') {
    const open = store.openTasks();
    const doneCount = store.entries.filter(e => e.kind === 'task' && e.taskStatus === 'done').length;
    const droppedCount = store.entries.filter(e => e.kind === 'task' && e.taskStatus === 'dropped').length;
    return out({
      ok: true, total: open.length, tasks: open.map(taskDetail),
      overdue: open.filter(t => t.dueAt && t.dueAt < today).length,
      done: doneCount, dropped: droppedCount,
      remaining: open.map(taskSummary),
    });
  }

  if (action === 'add') {
    const title = String(args.title ?? '').trim();
    const content = String(args.content ?? '').trim();
    if (!title || !content) return out({ ok: false, code: 'invalid_input', message: 'title 与 content 不能为空' });
    if (SECRET_RE.test(title) || SECRET_RE.test(content)) {
      return out({ ok: false, code: 'secret_refused', message: '疑似密钥/凭据，拒绝写入待办。' });
    }
    const dueAt = normalizeDueAt(args.dueAt);
    if (dueAt === false) return out({ ok: false, code: 'invalid_input', message: 'dueAt 无法解析，请用 YYYY-MM-DD（本地日）' });
    const priority = clampPriority(args.priority);
    const note = String(args.note ?? '').replace(/\s+/g, ' ').trim();

    // 去重：只与 open task 比较；同主题任务原地更新，避免重复堆积
    let target = null;
    let best = 0;
    for (const t of store.openTasks()) {
      const sim = similar(`${t.title}\n${t.content ?? ''}`, `${title}\n${content}`);
      if (sim > best) { best = sim; target = t; }
    }
    const at = nowIso();
    if (target && best >= cfg.dedupeThreshold) {
      target.title = title;
      target.content = content;
      target.updated = at;
      if (dueAt) target.dueAt = dueAt;
      if (args.priority !== undefined) target.priority = clampPriority(args.priority);
      if (args.note !== undefined) target.note = String(args.note ?? '').replace(/\s+/g, ' ').trim();
      await persistTask(store, target);
      return out({
        ok: true, added: false, updated: true, id: target.id, similarity: Number(best.toFixed(2)),
        task: taskDetail(target), remaining: openSummaries(store),
      });
    }

    const id = `${stamp()}-task-${slugify(title)}`;
    const task = {
      id, title, content, kind: 'task', taskStatus: 'open',
      dueAt: dueAt || '', doneAt: null, priority, note,
      importance: 3, salience: 5, pinned: false,
      created: at, updated: at, validFrom: at, validTo: null, history: [],
      hits: 0, lastHit: null,
      status: 'active', supersedes: [], links: [],
      chars: 0, tokens: 0, file: '',
      // v0.9-B：task 不参与间隔复习 —— 刻意不初始化 stability / nextReview / lastReview / reviews
    };
    await store.writeMemory(task, content);
    store.entries.push(task);
    await store.saveIndex();
    await store.saveStats();
    return out({
      ok: true, added: true, updated: false, id, kind: 'task', task: taskDetail(task),
      remaining: openSummaries(store),
    });
  }

  // done / drop：需要 id，且只允许 open
  const id = String(args.id ?? '').trim();
  if (!id) return out({ ok: false, code: 'invalid_input', message: 'id 不能为空' });
  const target = store.byId(id);
  if (!target || target.kind !== 'task' || target.status !== 'active') {
    return out({ ok: false, code: 'not_found', message: '没有找到该待办任务' });
  }
  if (target.taskStatus !== 'open') {
    return out({ ok: false, code: 'not_open', message: `该任务已是 ${target.taskStatus} 状态，不能重复操作` });
  }
  const at = nowIso();
  target.taskStatus = action === 'done' ? 'done' : 'dropped';
  target.doneAt = at;
  target.updated = at;
  await persistTask(store, target);
  return out({
    ok: true, id: target.id, taskStatus: target.taskStatus, doneAt: target.doneAt,
    task: taskDetail(target), remaining: openSummaries(store),
  });
}
