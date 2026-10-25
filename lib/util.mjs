// ---------------------------------------------------------------- 小工具

export function estTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (/\p{Script=Han}/u.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

export function clampText(text, maxTokens) {
  const s = String(text ?? '');
  if (estTokens(s) <= maxTokens) return s;
  // 粗略按 token 比例截断，再收尾到最后一个换行
  const ratio = maxTokens / Math.max(1, estTokens(s));
  let cut = s.slice(0, Math.max(20, Math.floor(s.length * ratio)));
  const nl = cut.lastIndexOf('\n');
  if (nl > cut.length * 0.6) cut = cut.slice(0, nl);
  return cut.trimEnd() + '\n…（画像已截断）';
}

/**
 * 硬预算截断（v0.8）：保证 estTokens(结果) <= maxTokens，含截断标记本身。
 * 用于 subagent 返回的 L0 画像落盘前，避免超长内容把注入预算撑爆。
 * 二分查找前缀长度（estTokens 对前缀单调不减）。
 */
export function clampToBudget(text, maxTokens, suffix = '\n…（画像已截断）') {
  const s = String(text ?? '');
  const budget = Math.max(8, Math.trunc(Number(maxTokens) || 0));
  if (estTokens(s) <= budget) return s;
  const tail = estTokens(suffix) < budget ? suffix : '';
  const room = Math.max(4, budget - estTokens(tail));
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estTokens(s.slice(0, mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  let cut = s.slice(0, lo);
  const nl = cut.lastIndexOf('\n');
  if (nl > cut.length * 0.6) cut = cut.slice(0, nl);
  return cut.trimEnd() + tail;
}

/**
 * L0 画像重写状态（v0.8 mental model）：dream 与 memory_stats 共用同一份判断。
 * 到期 = 启用 && （从未重写 或 距上次重写 >= mentalModelEveryDays 天）。
 */
export function profileRewriteStatus(cfg = {}, stats = {}, now = Date.now()) {
  const enabled = cfg.mentalModel !== false;
  const everyDays = Math.max(1, Math.trunc(Number(cfg.mentalModelEveryDays) || 7));
  const lastRewrite = stats?.lastProfileRewrite || null;
  const lastMs = lastRewrite ? new Date(lastRewrite).getTime() : NaN;
  const daysSince = Number.isFinite(lastMs) ? (now - lastMs) / 86400000 : null;
  return {
    enabled,
    everyDays,
    lastRewrite,
    daysSince: daysSince === null ? null : Number(daysSince.toFixed(1)),
    due: enabled && (!Number.isFinite(lastMs) || daysSince >= everyDays),
  };
}

export function nowIso() {
  return new Date().toISOString();
}

export function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function dayOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '';
}

/** 本地日期 YYYY-MM-DD（journal 按本地日切分）。 */
export function localDay(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** 从 DSH 消息里抽出纯文本。 */
export function messageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const parts = Array.isArray(message.content) ? message.content : [];
  const texts = parts
    .filter(p => p && (p.type === 'text' || typeof p.text === 'string'))
    .map(p => String(p.text ?? ''))
    .filter(Boolean);
  if (texts.length) return texts.join('\n');
  if (typeof message.content === 'string') return message.content;
  return '';
}

/** 做梦时用于判断"值得提炼"的线索词。 */
export const CANDIDATE_CUES = /(记住|记一下|记下|我喜欢|我讨厌|我不喜欢|我偏好|以后都|以后用|统一用|不要用|别再用|别再|下次|约定|决定|采用|规则|注意|重要|必须|千万别)/;

export function slugify(title) {
  const s = String(title).trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'memory').slice(0, 40);
}

export function bigrams(text) {
  const s = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similar(a, b) {
  return jaccard(bigrams(a), bigrams(b));
}

export function out(obj) {
  return JSON.parse(JSON.stringify(obj)); // 去掉 undefined，保证 lossless JSON
}

// ---------------------------------------------------------------- 显著性 / 复习 / 睡眠

export const EXPLICIT_RE = /(记住|记一下|记下|务必|永远|千万别|绝不|必须)/;
export const CORRECTION_RE = /(不是|改用|纠正|其实|之前说错|更正|应该是)/;

/**
 * 显著性打分 0-10（编码阶段：杏仁核/多巴胺式的"值不值得记"）。
 * 用户明说 > 纠正 > 绝对化措辞 > 新颖性 > 用户置顶。
 */
export function salienceFor({ title, content, importance, pin, novelty }) {
  const text = `${title}\n${content}`;
  let score = 3;
  if (EXPLICIT_RE.test(text)) score += 4;      // 明确要求记住
  if (CORRECTION_RE.test(text)) score += 2;    // 纠正（最高价值类型）
  if (/(重要|关键|核心|底线|原则)/.test(text)) score += 1;
  score += Math.round((novelty ?? 1) * 2);     // 越新越值得记
  if ((importance ?? 3) >= 4) score += 1;
  if (pin) score += 1;
  return Math.max(1, Math.min(10, score));
}

/** 初始稳定性（天）：越重要 / 越显著，记得越久。 */
export function initialStability(importance, salience) {
  const base = 3 + (importance ?? 3) * 2 + Math.round((salience ?? 5) / 2); // 约 8-13 天
  return Math.min(90, Math.max(2, base));
}

export function addDays(iso, days) {
  const t = new Date(iso ?? nowIso()).getTime();
  return new Date(t + days * 86400000).toISOString();
}

export function isDue(entry, now = Date.now()) {
  if (!entry?.nextReview) return false;
  const t = new Date(entry.nextReview).getTime();
  return Number.isFinite(t) && t <= now;
}

/** 复习一次：稳定性增长（间隔重复的"提取练习效应"）。 */
export function reinforce(entry, factor = 1.3) {
  const now = nowIso();
  entry.hits = (entry.hits || 0) + 1;
  entry.lastHit = now;
  entry.lastReview = now;
  if (entry.stability) entry.stability = Math.min(365, Math.max(1, entry.stability * factor));
  else entry.stability = initialStability(entry.importance, entry.salience);
  entry.reviews = (entry.reviews || 0) + 1;
  entry.nextReview = addDays(now, Math.round(entry.stability));
  return entry;
}

/** 记忆强度：显著性 × 衰减 × 复习命中（SHY 的"用进废退"）。 */
export function strengthOf(entry, now = Date.now()) {
  const ageDays = Math.max(0, (now - new Date(entry.updated || entry.created || nowIso()).getTime()) / 86400000);
  const stability = entry.stability || 30;
  const recency = Math.exp(-ageDays / Math.max(1, stability));
  const salience = (entry.salience ?? 5) / 10;
  return salience * recency * (1 + (entry.hits || 0) * 0.2);
}

export const SECRET_RE = /(sk-[A-Za-z0-9]{16,})|(api[_-]?key\s*[:=]\s*\S{12,})|(password\s*[:=]\s*\S{6,})|(Bearer\s+[A-Za-z0-9._~+/=-]{20,})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/** 落盘前脱敏：journal 里可能混入用户粘贴的密钥。 */
export function redactSecrets(text) {
  return String(text ?? '').replace(SECRET_RE, '[REDACTED]');
}
