import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { nowIso, stamp, dayOf, localDay, estTokens, initialStability, addDays, isDue, redactSecrets } from './util.mjs';

// ---------------------------------------------------------------- 存储

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.memDir = path.join(dir, 'memories');
    this.archDir = path.join(dir, 'archive');
    this.journalDir = path.join(dir, 'journal');
    this.dreamDir = path.join(dir, 'dream');
    this.profileHistoryDir = path.join(dir, 'profile-history');
    this.profileFile = path.join(dir, 'profile.md');
    this.indexFile = path.join(dir, 'index.json');
    this.statsFile = path.join(dir, 'stats.json');
    // v0.9：L1 注入快照（内存 + 落盘），保存"某个刷新纪元内冻结的热索引"
    this.injectionCacheFile = path.join(dir, 'injection-cache.json');
    this.injectionCache = null;    // { day, builtAt, reason, lines, due, cold }
    this.injectionWrite = null;    // 最近一次缓存落盘的 promise（测试/调试可 await）
    this.loaded = false;           // init 前不缓存注入快照，避免把空索引冻住
    this.injectDirty = true;       // 首次构建的 reason 记作 init
    this.injectDirtyReason = 'init';
    this.entries = [];
    this.stats = { saved: 0, updated: 0, searches: 0, consolidations: 0, lastConsolidate: null, captured: 0, capturedSinceDream: 0, dreams: 0, lastDream: null, lastProfileRewrite: null, profileRewrites: 0, injectionRebuilds: 0, lastInjectionRebuild: null };
  }

  async init() {
    await fs.mkdir(this.memDir, { recursive: true });
    await fs.mkdir(this.archDir, { recursive: true });
    await fs.mkdir(this.journalDir, { recursive: true });
    await fs.mkdir(this.dreamDir, { recursive: true });
    await fs.mkdir(this.profileHistoryDir, { recursive: true });
    await this.load();
  }

  /** 追加一条对话记录到当天 journal（L3 原始层，永不注入上下文）。落盘前强制脱敏。 */
  async appendJournal(record) {
    const day = localDay();
    const file = path.join(this.journalDir, `${day}.jsonl`);
    const safe = { ...record, text: redactSecrets(record?.text ?? '') };
    await fs.appendFile(file, JSON.stringify(safe) + '\n', 'utf8').catch(() => {});
    this.stats.capturedSinceDream = (this.stats.capturedSinceDream || 0) + 1;
  }

  /** 读取最近 n 天的 journal 条目。 */
  async readJournal(days = 2) {
    const out = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      const file = path.join(this.journalDir, `${localDay(d)}.jsonl`);
      let text = '';
      try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    }
    out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return out;
  }

  async saveDreamReport(day, content) {
    const file = path.join(this.dreamDir, `${day}.md`);
    await atomicWrite(file, content);
    return file;
  }

  async readDreamReport(day = localDay(new Date(Date.now() - 86400000))) {
    const file = path.join(this.dreamDir, `${day}.md`);
    try { return { day, content: await fs.readFile(file, 'utf8'), file }; } catch { return { day, content: '', file }; }
  }

  /** v0.8：写 mental model 重写任务文件（给 subagent 读，不注入上下文）。 */
  async saveMentalModelTask(day, content) {
    const file = path.join(this.dreamDir, `${day}-mental-model.md`);
    await atomicWrite(file, content);
    return file;
  }

  /**
   * v0.8：把当前 L0 画像归档到 profile-history/YYYYMMDD-HHmmss.md。
   * 画像重写前调用，只复制、不改当前画像，可回滚。
   */
  async archiveProfile() {
    let raw = '';
    try { raw = await fs.readFile(this.profileFile, 'utf8'); } catch { return null; }
    if (!raw.trim()) return null;
    const at = nowIso();
    const file = path.join(this.profileHistoryDir, `${stamp()}.md`);
    await atomicWrite(file, raw);
    return { file, tokens: estTokens(raw), at };
  }

  async pruneJournal(keepDays) {
    const cutoff = new Date(Date.now() - keepDays * 86400000);
    let removed = 0;
    let files = [];
    try { files = await fs.readdir(this.journalDir); } catch { return 0; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const dayStr = f.replace(/\.jsonl$/, '');
      const t = new Date(`${dayStr}T00:00:00`).getTime();
      if (Number.isFinite(t) && t < cutoff.getTime()) {
        await fs.unlink(path.join(this.journalDir, f)).catch(() => {});
        removed++;
      }
    }
    return removed;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.indexFile, 'utf8');
      const data = JSON.parse(raw);
      this.entries = Array.isArray(data.entries) ? data.entries : [];
    } catch {
      this.entries = await this.scan();
    }
    await this.migrate();
    // v0.9：重读 stats.json 时保留本进程的注入重建观测（单调不减），
    // 否则 mutating 工具的 withLock → load() 会把刚发生的重建次数/原因冲掉
    const memInjectRebuilds = Number(this.stats?.injectionRebuilds) || 0;
    const memLastRebuild = this.stats?.lastInjectionRebuild || null;
    try {
      this.stats = { ...this.stats, ...JSON.parse(await fs.readFile(this.statsFile, 'utf8')) };
    } catch { /* 首次运行 */ }
    this.stats.injectionRebuilds = Math.max(memInjectRebuilds, Number(this.stats.injectionRebuilds) || 0);
    if (memLastRebuild && (!this.stats.lastInjectionRebuild
      || String(memLastRebuild.at || '') > String(this.stats.lastInjectionRebuild.at || ''))) {
      this.stats.lastInjectionRebuild = memLastRebuild;
    }
    // v0.9：读回上一次进程落盘的注入快照；只在首次 load 时读，之后以内存态为准
    if (!this.loaded) {
      try {
        const raw = JSON.parse(await fs.readFile(this.injectionCacheFile, 'utf8'));
        if (raw && typeof raw === 'object' && Array.isArray(raw.lines)) {
          this.injectionCache = {
            day: String(raw.day ?? ''),
            builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
            reason: typeof raw.reason === 'string' ? raw.reason : 'cache',
            lines: raw.lines.map(x => String(x)),
            due: raw.due === true,
            cold: Math.max(0, Math.trunc(Number(raw.cold) || 0)),
          };
          // 只有"还没被任何真实事件标脏"时才信任磁盘缓存，避免吞掉启动期的 session 失效
          if (this.injectDirtyReason === 'init') {
            this.injectDirty = false;
            this.injectDirtyReason = null;
          }
        }
      } catch { /* 没有缓存或缓存损坏：保持脏，下次 build 重算 */ }
    }
    if (!fsSync.existsSync(this.profileFile)) {
      await fs.writeFile(this.profileFile, '# 小肥鱼记忆 · L0 画像\n\n（还没有写入画像）\n', 'utf8');
    }
    this.loaded = true;
  }

  /**
   * v0.9：标记注入快照失效（只标脏，不立即重算）。
   * 触发点：新会话（session）、memory_dream（dream）、memory_consolidate（consolidate）。
   */
  async invalidateInjection(reason = 'session') {
    this.injectDirty = true;
    this.injectDirtyReason = String(reason || 'session');
  }

  /**
   * v0.9：取 L1 热索引注入快照（缓存感知）。
   * - mode==='live'：不缓存、不计数，每次 build()；
   * - 未 loaded：直接 build()，不写盘不冻结（避免启动期空索引被缓存）；
   * - 命中（未脏且同日）：返回缓存；
   * - 未命中：build() → 原子写盘 → 重建计数/时间 → 清脏。
   * build() 需返回 { lines: string[], due: boolean, cold?: number }。
   * 同步返回（systemPrompt text() 是同步的），落盘走 fire-and-forget，失败不影响注入。
   */
  getInjectionSnapshot({ mode, day, build } = {}) {
    const run = typeof build === 'function' ? build : () => ({ lines: [], due: false });
    const pack = (fresh) => ({
      lines: Array.isArray(fresh?.lines) ? fresh.lines.map(x => String(x)) : [],
      due: fresh?.due === true,
      cold: Math.max(0, Math.trunc(Number(fresh?.cold) || 0)),
    });
    if (mode === 'live') return { ...pack(run()), day, reason: 'live', cached: false, builtAt: null };
    // init 之前不缓存：此时索引可能还没加载，冻住会把"空记忆"写进缓存
    if (!this.loaded) return { ...pack(run()), day, reason: 'init', cached: false, builtAt: null };

    const cached = this.injectionCache;
    if (cached && !this.injectDirty && cached.day === day) {
      return {
        lines: [...(cached.lines || [])], due: cached.due === true, cold: cached.cold || 0,
        day: cached.day, reason: cached.reason || 'cache', builtAt: cached.builtAt || null, cached: true,
      };
    }

    // 脏 → 用标脏原因；否则只可能是日界变化
    const reason = this.injectDirty ? (this.injectDirtyReason || 'init') : 'day';
    const fresh = pack(run());
    const record = { day, builtAt: nowIso(), reason, lines: fresh.lines, due: fresh.due, cold: fresh.cold };
    this.injectionCache = record;
    this.injectDirty = false;
    this.injectDirtyReason = null;

    // 串行化落盘，避免快速连续重建时旧快照后写覆盖新快照
    const payload = JSON.stringify(record, null, 2) + '\n';
    const prev = this.injectionWrite && typeof this.injectionWrite.then === 'function' ? this.injectionWrite : Promise.resolve();
    this.injectionWrite = prev.then(() => atomicWrite(this.injectionCacheFile, payload)).catch(() => {});

    this.stats.injectionRebuilds = (this.stats.injectionRebuilds || 0) + 1;
    this.stats.lastInjectionRebuild = { at: record.builtAt, reason, day };
    return { ...record, cached: false };
  }

  /** v0.4 迁移：给旧条目补上 salience / 复习调度 / 链接字段；v0.5 补时间有效性字段；v0.9-B 补 kind/task 字段。 */
  async migrate() {
    let changed = false;
    const now = nowIso();
    for (const e of this.entries) {
      if (!e.kind) { e.kind = 'fact'; changed = true; } // v0.9-B：旧数据默认 fact
      if (typeof e.salience !== 'number') { e.salience = 5; changed = true; }
      if (!Array.isArray(e.links)) { e.links = []; changed = true; }
      // 时间有效性（P3）：旧数据默认"从创建时起一直有效"
      if (!e.validFrom) { e.validFrom = e.created || now; changed = true; }
      if (e.validTo === undefined) { e.validTo = null; changed = true; }
      if (!Array.isArray(e.history)) { e.history = []; changed = true; }
      if (e.kind === 'task') {
        // v0.9-B：task 不参与间隔复习——不初始化 stability/nextReview，并清掉历史误加的复习字段
        if (!e.taskStatus) { e.taskStatus = 'open'; changed = true; }
        if (e.priority === undefined || e.priority === null || !Number.isFinite(Number(e.priority))) { e.priority = 3; changed = true; }
        else if (Number(e.priority) < 1 || Number(e.priority) > 5) { e.priority = Math.min(5, Math.max(1, Math.trunc(Number(e.priority)))); changed = true; }
        if (typeof e.dueAt !== 'string') { e.dueAt = ''; changed = true; }
        if (e.doneAt === undefined) { e.doneAt = null; changed = true; }
        if (typeof e.note !== 'string') { e.note = ''; changed = true; }
        if (e.stability || e.nextReview) { e.stability = null; e.nextReview = null; e.lastReview = null; e.reviews = 0; changed = true; }
        continue;
      }
      if (!e.stability) {
        e.stability = initialStability(e.importance, e.salience);
        e.lastReview = e.lastReview || e.updated || now;
        e.nextReview = addDays(e.lastReview, Math.round(e.stability));
        e.reviews = e.reviews || 0;
        changed = true;
      }
      if (!e.nextReview) { e.nextReview = addDays(e.updated || now, Math.round(e.stability)); changed = true; }
    }
    if (changed) {
      try { await this.saveIndex(); } catch { /* 忽略 */ }
    }
  }

  /** 索引丢失时，从 memories/*.md 的 frontmatter 重建。 */
  async scan() {
    const entries = [];
    let files = [];
    try { files = await fs.readdir(this.memDir); } catch { return entries; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try {
        const text = await fs.readFile(path.join(this.memDir, f), 'utf8');
        const e = parseFrontmatter(text, f.replace(/\.md$/, ''));
        if (e) entries.push(e);
      } catch { /* 跳过坏文件 */ }
    }
    return entries;
  }

  async saveIndex() {
    const data = { version: 1, updated: nowIso(), entries: this.entries };
    await atomicWrite(this.indexFile, JSON.stringify(data, null, 2) + '\n');
  }

  async saveStats() {
    await atomicWrite(this.statsFile, JSON.stringify(this.stats, null, 2) + '\n');
  }

  /** active 的条目：置顶 → 显著性 → 重要度 → 更新时间。 */
  visible() {
    return this.entries
      .filter(e => e.status === 'active')
      .sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        if ((b.salience ?? 5) !== (a.salience ?? 5)) return (b.salience ?? 5) - (a.salience ?? 5);
        if ((b.importance ?? 3) !== (a.importance ?? 3)) return (b.importance ?? 3) - (a.importance ?? 3);
        return String(b.updated).localeCompare(String(a.updated));
      });
  }

  /** 到期该复习的条目（v0.9-B：task 不做间隔复习，排除）。 */
  due(now = Date.now()) {
    return this.entries.filter(e => e.status === 'active' && e.kind !== 'task' && isDue(e, now));
  }

  /** v0.9-B：所有 task 条目（kind==='task'）。 */
  tasks() {
    return this.entries.filter(e => e.kind === 'task');
  }

  /**
   * v0.9-B：open 的 task，按 逾期 → dueAt → priority 排序。
   * dueAt 升序天然把逾期放最前；无 dueAt 的排最后；同日期高 priority 优先。
   */
  openTasks() {
    return this.entries
      .filter(e => e.kind === 'task' && e.taskStatus === 'open' && e.status === 'active')
      .sort((a, b) => {
        const ad = a.dueAt || '';
        const bd = b.dueAt || '';
        if (!!ad !== !!bd) return ad ? -1 : 1;
        if (ad !== bd) return ad.localeCompare(bd);
        if ((b.priority ?? 3) !== (a.priority ?? 3)) return (b.priority ?? 3) - (a.priority ?? 3);
        return String(a.updated).localeCompare(String(b.updated));
      });
  }

  byId(id) {
    return this.entries.find(e => e.id === id);
  }

  async writeMemory(entry, content) {
    const fm = [
      '---',
      `id: ${entry.id}`,
      `created: ${entry.created}`,
      `updated: ${entry.updated}`,
      `kind: ${entry.kind ?? 'fact'}`,
      `valid_from: ${entry.validFrom ?? entry.created ?? ''}`,
      `valid_to: ${entry.validTo ?? ''}`,
      `importance: ${entry.importance}`,
      `salience: ${entry.salience ?? 5}`,
      `pinned: ${entry.pinned ? 'true' : 'false'}`,
      `status: ${entry.status}`,
      `task_status: ${entry.taskStatus ?? ''}`,
      `due_at: ${entry.dueAt ?? ''}`,
      `done_at: ${entry.doneAt ?? ''}`,
      `priority: ${entry.priority ?? ''}`,
      `note: ${String(entry.note ?? '').replace(/\s+/g, ' ').trim()}`,
      `stability: ${entry.stability ?? ''}`,
      `last_review: ${entry.lastReview ?? ''}`,
      `next_review: ${entry.nextReview ?? ''}`,
      `reviews: ${entry.reviews ?? 0}`,
      `tags: ${(entry.tags || []).join(', ')}`,
      `supersedes: ${(entry.supersedes || []).join(', ')}`,
      `links: ${(entry.links || []).join(', ')}`,
      '---',
      '',
      `# ${entry.title}`,
      '',
      content.trim(),
      '',
    ].join('\n');
    entry.file = path.join(this.memDir, `${entry.id}.md`);
    entry.chars = fm.length;
    entry.tokens = estTokens(fm);
    await atomicWrite(entry.file, fm);
    return fm;
  }

  async archiveContent(entry, content) {
    const at = stamp();
    const file = path.join(this.archDir, `${entry.id}.${at}.md`);
    const fm = [
      '---',
      `id: ${entry.id}`,
      `title: ${entry.title}`,
      `archived_at: ${nowIso()}`,
      '---',
      '',
      content,
      '',
    ].join('\n');
    await atomicWrite(file, fm);
    return file;
  }
}

export function parseFrontmatter(text, fallbackId) {
  const m = /^---\n([\s\S]*?)\n---\n\n?# ([^\n]*)\n\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    id: meta.id || fallbackId,
    title: m[2].trim(),
    content: m[3],
    kind: (meta.kind || 'fact').trim(), // v0.9-B：旧数据默认 fact
    created: meta.created || nowIso(),
    updated: meta.updated || meta.created || nowIso(),
    validFrom: meta.valid_from || meta.created || nowIso(),
    validTo: meta.valid_to || null,
    history: [],
    importance: Number(meta.importance) || 3,
    salience: Number(meta.salience) || 5,
    pinned: meta.pinned === 'true',
    status: (meta.status || 'active').trim(),
    taskStatus: (meta.task_status || '').trim(),
    dueAt: (meta.due_at || '').trim(),
    doneAt: meta.done_at || null,
    priority: meta.priority ? Number(meta.priority) : null,
    note: meta.note || '',
    stability: Number(meta.stability) || null,
    lastReview: meta.last_review || null,
    nextReview: meta.next_review || null,
    reviews: Number(meta.reviews) || 0,
    tags: (meta.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    supersedes: (meta.supersedes || '').split(',').map(s => s.trim()).filter(Boolean),
    links: (meta.links || '').split(',').map(s => s.trim()).filter(Boolean),
    hits: 0,
    lastHit: null,
    chars: text.length,
    tokens: estTokens(text),
  };
}

export async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}
