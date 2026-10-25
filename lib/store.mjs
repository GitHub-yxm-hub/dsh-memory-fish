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
    this.profileFile = path.join(dir, 'profile.md');
    this.indexFile = path.join(dir, 'index.json');
    this.statsFile = path.join(dir, 'stats.json');
    this.entries = [];
    this.stats = { saved: 0, updated: 0, searches: 0, consolidations: 0, lastConsolidate: null, captured: 0, capturedSinceDream: 0, dreams: 0, lastDream: null };
  }

  async init() {
    await fs.mkdir(this.memDir, { recursive: true });
    await fs.mkdir(this.archDir, { recursive: true });
    await fs.mkdir(this.journalDir, { recursive: true });
    await fs.mkdir(this.dreamDir, { recursive: true });
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
    try {
      this.stats = { ...this.stats, ...JSON.parse(await fs.readFile(this.statsFile, 'utf8')) };
    } catch { /* 首次运行 */ }
    if (!fsSync.existsSync(this.profileFile)) {
      await fs.writeFile(this.profileFile, '# 小肥鱼记忆 · L0 画像\n\n（还没有写入画像）\n', 'utf8');
    }
  }

  /** v0.4 迁移：给旧条目补上 salience / 复习调度 / 链接字段；v0.5 补时间有效性字段。 */
  async migrate() {
    let changed = false;
    const now = nowIso();
    for (const e of this.entries) {
      if (typeof e.salience !== 'number') { e.salience = 5; changed = true; }
      if (!e.stability) {
        e.stability = initialStability(e.importance, e.salience);
        e.lastReview = e.lastReview || e.updated || now;
        e.nextReview = addDays(e.lastReview, Math.round(e.stability));
        e.reviews = e.reviews || 0;
        changed = true;
      }
      if (!Array.isArray(e.links)) { e.links = []; changed = true; }
      if (!e.nextReview) { e.nextReview = addDays(e.updated || now, Math.round(e.stability)); changed = true; }
      // 时间有效性（P3）：旧数据默认"从创建时起一直有效"
      if (!e.validFrom) { e.validFrom = e.created || now; changed = true; }
      if (e.validTo === undefined) { e.validTo = null; changed = true; }
      if (!Array.isArray(e.history)) { e.history = []; changed = true; }
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

  /** 到期该复习的条目。 */
  due(now = Date.now()) {
    return this.entries.filter(e => e.status === 'active' && isDue(e, now));
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
      `valid_from: ${entry.validFrom ?? entry.created ?? ''}`,
      `valid_to: ${entry.validTo ?? ''}`,
      `importance: ${entry.importance}`,
      `salience: ${entry.salience ?? 5}`,
      `pinned: ${entry.pinned ? 'true' : 'false'}`,
      `status: ${entry.status}`,
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
    created: meta.created || nowIso(),
    updated: meta.updated || meta.created || nowIso(),
    validFrom: meta.valid_from || meta.created || nowIso(),
    validTo: meta.valid_to || null,
    history: [],
    importance: Number(meta.importance) || 3,
    salience: Number(meta.salience) || 5,
    pinned: meta.pinned === 'true',
    status: (meta.status || 'active').trim(),
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
