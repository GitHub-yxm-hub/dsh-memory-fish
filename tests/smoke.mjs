// 小肥鱼记忆 · 冒烟测试
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const plugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-plugin-'));
fs.copyFileSync(path.join(root, 'index.mjs'), path.join(plugDir, 'index.mjs'));
fs.copyFileSync(path.join(root, 'package.json'), path.join(plugDir, 'package.json'));
fs.cpSync(path.join(root, 'lib'), path.join(plugDir, 'lib'), { recursive: true });
const stubDir = path.join(plugDir, 'node_modules', '@deepseek-ai', 'dsh-tools');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js', exports: { '.': './index.js' },
}));
fs.writeFileSync(path.join(stubDir, 'index.js'), 'export function defineTool(def) { return def; }\n');

const { apply } = await import(pathToFileURL(path.join(plugDir, 'index.mjs')).href);

const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-mem-'));
const tools = {};
const listeners = [];
const routes = [];
let injected = () => '';

const ctx = {
  systemPrompt: {
    getSectionOrder: () => 42,
    section(cfg) { injected = cfg.text; },
  },
  tools: { register(def) { tools[def.name] = def; } },
  on(event, fn) { listeners.push({ event, fn }); },
  inject(deps, fn) {
    if (deps.includes('webServer')) fn({ webServer: { register(route) { routes.push(route); } } });
  },
};

// v0.9：主实例用 live 模式跑既有断言（注入块每轮实时重建，旧行为不变）
apply(ctx, { dir: memDir, budgetTokens: 600, profileTokens: 200, dreamAfterHours: 0, injectionMode: 'live' });
await new Promise(r => setTimeout(r, 300));

const call = async (n, args) => {
  if (!tools[n]) throw new Error(`tool ${n} not registered`);
  return tools[n].execute(args ?? {}, { signal: { aborted: false } });
};
let failed = 0;
const check = (label, cond, extra) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
};

console.log('registered tools:', Object.keys(tools).join(', '));
check('注册 12 个工具', Object.keys(tools).length === 12);

// --- 自动捕获 ---
const emit = (session, event) => listeners.filter(l => l.event === 'session/event').forEach(l => l.fn(session, event));
const session = { id: 'sess-1', header: {} };
emit(session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '记住：以后都用 pnpm，不用 npm。' }] } });
emit(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，我用 pnpm。' }] } } });
emit(session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '我今天吃了拉面。' }] } });
emit({ id: 'sub-1', header: { origin: 'subagent' } }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '子代理里的话不该被捕获' }] } });
// 安全：journal 落盘前必须脱敏
emit(session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz123456，别泄漏' }] } });
await new Promise(r => setTimeout(r, 200));
const jdir = path.join(memDir, 'journal');
const jfiles = fs.readdirSync(jdir);
const jlines = jfiles.flatMap(f => fs.readFileSync(path.join(jdir, f), 'utf8').split('\n').filter(Boolean));
check('journal 已写入', jlines.length === 4, jlines.length);
check('跳过 subagent 会话', !jlines.some(l => l.includes('子代理')), jlines);
check('捕获含用户与助手', jlines.some(l => l.includes('"role":"user"')) && jlines.some(l => l.includes('"role":"assistant"')));
check('journal 密钥已脱敏', !jlines.some(l => l.includes('sk-abcdefghijklmnopqrstuvwxyz123456')) && jlines.some(l => l.includes('[REDACTED]')));
check('写锁已释放', !fs.existsSync(path.join(memDir, '.index.lock')));
check('C1 睡梦提醒出现在注入里', injected().includes('### 睡梦'), injected().slice(-200));

// --- 画像 / 保存 / 去重 ---
const profile = await call('memory_profile_save', { content: '铁凝：喜欢写代码、折腾电脑、关注新技术。自称小肥鱼。中文交流，语气轻松。' });
check('写入 L0 画像', profile.ok === true && profile.tokens > 0, profile);

const s1 = await call('memory_save', {
  title: '项目统一用 pnpm',
  content: '这个项目统一用 pnpm，不用 npm。理由：磁盘占用小，pnpm-workspace 与 DSH profile 兼容。',
  tags: ['工具链', '包管理'],
  importance: 4,
});
check('保存记忆', s1.ok && s1.saved === true, s1);

const s2 = await call('memory_save', {
  title: '项目统一用 pnpm（补充）',
  content: '这个项目统一用 pnpm，不用 npm。原因：磁盘占用小，pnpm-workspace 与 DSH profile 兼容。',
  tags: ['工具链'],
});
check('同主题去重并原地更新', s2.updated === true && s2.id === s1.id, s2);
check('P3 新记忆带有效起点', typeof s1.validFrom === 'string', s1);
check('P3 更新时封存旧版本', s2.historyCount >= 1, s2);
check('显著性自动打分', typeof s1.salience === 'number' && s1.salience >= 3, s1);
check('复习调度字段', s1.stability > 0 && typeof s1.nextReview === 'string', s1);

const noop = await call('memory_save', {
  title: '项目统一用 pnpm（补充）',
  content: '这个项目统一用 pnpm，不用 npm。原因：磁盘占用小，pnpm-workspace 与 DSH profile 兼容。',
  tags: ['工具链'],
});
check('完全重复 → NOOP 不写入', noop.noop === true && noop.saved === false, noop);

const s3 = await call('memory_save', {
  title: '铁凝喜欢表情包',
  content: '聊天时可以发手绘表情包，铁凝喜欢这种轻松的方式；工作产出仍然要严谨。',
  tags: ['沟通'],
  pin: true,
});
check('置顶保存', s3.ok && s3.saved === true, s3);

const sec = await call('memory_save', { title: '测试密钥', content: 'API key: sk-abcdefghijklmnopqrstuvwxyz123456' });
check('拒绝保存密钥', sec.ok === false && sec.code === 'secret_refused', sec);

// --- 检索 / 读取 / 列表 / 统计 ---
const search = await call('memory_search', { query: 'pnpm' });
check('检索命中', search.total >= 1, search);
check('检索无 undefined（lossless JSON）', JSON.stringify(search) === JSON.stringify(JSON.parse(JSON.stringify(search))));

const read = await call('memory_read', { id: s1.id });
check('读取全文', read.ok === true && read.content.includes('# 项目统一用 pnpm'), read);
check('读取也是一次复习（加固）', read.stability > 0 && typeof read.nextReview === 'string', read);

const list = await call('memory_list', { limit: 5 });
check('列表返回 2 条（去重后）', list.total === 2, list);

const stats = await call('memory_stats', {});
check('统计包含注入 token', stats.injectedL1Tokens > 0 && stats.budgetTokens === 600, stats);
check('统计包含捕获数', typeof stats.captured === 'number', stats);
check('统计包含复习与显著性', typeof stats.dueReview === 'number' && typeof stats.salienceAvg === 'number', stats);

// P3 时间有效性
const hist = await call('memory_search', { query: 'pnpm', asOf: s1.validFrom });
check('P3 asOf 能查到历史版本', hist.matches.some(m => m.historical === true), hist);
const cur = await call('memory_search', { query: 'pnpm' });
check('P3 默认只给当前版本', cur.matches.length >= 1 && cur.matches.every(m => m.historical === false), cur);
check('P3 结果带有效期', cur.matches.every(m => typeof m.validFrom === 'string'), cur.matches[0]);

// --- 睡梦机制 ---
const s4 = await call('memory_save', {
  title: 'lockfile 不要手改',
  content: 'pnpm-lock.yaml 只由 pnpm 生成，不要手改；冲突时重新 pnpm install 生成。',
  tags: ['工具链'],
});
check('新增同标签记忆（供 REM 关联）', s4.ok === true, s4);

const dream = await call('memory_dream', { days: 2 });
check('做梦生成报告', dream.ok === true && dream.cues >= 1, { cues: dream.cues, day: dream.day });
check('报告写入文件', fs.existsSync(path.join(memDir, 'dream', `${dream.day}.md`)), dream.reportFile);
check('明确"记住"被识别为候选', dream.candidates.some(c => c.explicit), dream.candidates);
check('三阶段睡眠都跑过（SWS/SHY/REM）', typeof dream.phases.sws === 'number' && typeof dream.phases.shy === 'number' && typeof dream.phases.rem === 'number', dream.phases);
check('睡眠报告含三个阶段标题', dream.report.includes('Phase 1') && dream.report.includes('Phase 2') && dream.report.includes('Phase 3'), dream.report.slice(0, 120));
check('输出到期复习清单', Array.isArray(dream.dueReview), dream.dueReview);
check('REM 建立了关联链接', dream.phases.rem >= 1, dream.phases.rem);
check('做梦后提醒消失', !injected().includes('### 睡梦'), injected().slice(-200));

// --- 面板 ---
check('注册面板路由', routes.length >= 3, routes.map(r => r.path));
const panel = routes.find(r => r.path === '/memory-fish/panel');
const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
await panel.handler({ method: 'GET', headers: { host: '127.0.0.1:36336' } }, res);
check('面板返回 HTML', res.code === 200 && res.body.includes('小肥鱼记忆'), res.code);

const stateRoute = routes.find(r => r.path === '/memory-fish/api/state');
const res2 = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
await stateRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:36336' } }, res2);
const state = JSON.parse(res2.body);
check('状态 API 正常', state.ok === true && state.active === 3 && state.todayMessages === 4, { active: state.active, today: state.todayMessages });
check('状态 API 带复习信息', typeof state.due === 'number' && state.entries.every(e => typeof e.salience === 'number'), { due: state.due });
check('状态 API 带画像', state.profile.includes('铁凝'), state.profile?.slice(0, 20));
check('面板拒绝跨源', await (async () => {
  const r = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  await stateRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:36336', origin: 'http://evil.example.com' } }, r);
  return r.code === 403;
})());

// --- v0.8 Mental model（L0 画像自动重写）---
const { resolveConfig } = await import(pathToFileURL(path.join(root, 'lib/config.mjs')).href);
const { Store } = await import(pathToFileURL(path.join(root, 'lib/store.mjs')).href);
const { buildDream } = await import(pathToFileURL(path.join(root, 'lib/dream.mjs')).href);
const { saveMemoryCore, taskCore, normalizeDueAt } = await import(pathToFileURL(path.join(root, 'lib/core.mjs')).href);
const { estTokens, localDay } = await import(pathToFileURL(path.join(root, 'lib/util.mjs')).href);
const { buildInjection } = await import(pathToFileURL(path.join(root, 'lib/inject.mjs')).href);

// 主实例：归档 / 硬截断 / 重写时间
const profileBefore = fs.readFileSync(path.join(memDir, 'profile.md'), 'utf8');
const arch = await call('memory_profile_archive', {});
check('v0.8 画像归档生成 profile-history 文件', arch.ok === true && arch.file.includes('profile-history') && fs.existsSync(arch.file), arch);
check('v0.8 归档内容等于旧画像', fs.readFileSync(arch.file, 'utf8') === profileBefore);
const longProfile = '铁凝：喜欢写代码、折腾电脑、关注新技术（AI / 开发工具 / 编程前沿）。中文交流，语气轻松。'.repeat(40);
const trunc = await call('memory_profile_save', { content: longProfile });
const storedBody = fs.readFileSync(path.join(memDir, 'profile.md'), 'utf8').replace(/^#.*\n+/, '').trim();
check('v0.8 超长画像被硬截断到 ≤ profileTokens', trunc.truncated === true && estTokens(storedBody) <= 200, { tokens: estTokens(storedBody), reported: trunc.tokens });
const restored = await call('memory_profile_save', { content: '铁凝：喜欢写代码、折腾电脑、关注新技术。自称小肥鱼。中文交流，语气轻松。' });
check('v0.8 画像写入记录重写时间', typeof restored.lastRewrite === 'string' && restored.rewrites >= 1, restored);
const statsMM = await call('memory_stats', {});
check('v0.8 stats 带画像重写状态', typeof statsMM.lastProfileRewrite === 'string' && statsMM.profileRewriteDue === false && statsMM.mentalModel === true, statsMM);

// 主实例 dream（刚刚重写过）：Phase 4 存在但未到期
check('v0.8 睡梦报告含 Phase 4', dream.report.includes('🧠 Mental model') && dream.report.includes('Phase 4') && dream.mentalModel.enabled === true, dream.mentalModel);
check('v0.8 刚重写过 → 画像未到期', dream.report.includes('画像到期：否') && dream.mentalModel.due === false && dream.mentalModel.taskFile === null, dream.mentalModel);

// 隔离实例：精确控制 lastProfileRewrite
const bootFishStore = async (overrides = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-mm-'));
  const store = new Store(dir);
  await store.init();
  const cfg = resolveConfig({ dir, ...overrides });
  return { store, cfg };
};
{
  const { store, cfg } = await bootFishStore({ mentalModel: false });
  const d = await buildDream(store, cfg, 1);
  check('v0.8 mentalModel:false 时报告无 Phase 4', !d.report.includes('Phase 4') && !d.report.includes('画像到期') && d.mentalModel.taskFile === null, d.mentalModel);
}
{
  const { store, cfg } = await bootFishStore({ mentalModel: true, mentalModelEveryDays: 7 });
  fs.writeFileSync(store.profileFile, '# 小肥鱼记忆 · L0 画像\n\n铁凝：偏好中文、语气轻松、喜欢表情包。\n', 'utf8');
  const m = await saveMemoryCore(store, cfg, { title: '画像重写材料记忆', content: '铁凝喜欢写代码和折腾电脑，关注新技术。', tags: ['测试'] });
  const d = await buildDream(store, cfg, 1);
  check('v0.8 从未重写 → 报告「画像到期：是」', d.report.includes('画像到期：是') && d.mentalModel.due === true, d.report.slice(-200));
  check('v0.8 到期时任务文件落盘', typeof d.mentalModel.taskFile === 'string' && fs.existsSync(d.mentalModel.taskFile) && d.mentalModel.taskFile.endsWith('-mental-model.md'), d.mentalModel.taskFile);
  const task = fs.readFileSync(d.mentalModel.taskFile, 'utf8');
  check('v0.8 任务文件含当前画像', task.includes('铁凝：偏好中文、语气轻松、喜欢表情包。'), task.slice(0, 160));
  check('v0.8 任务文件含最近记忆 id/标题/标签/正文', task.includes(m.id) && task.includes('画像重写材料记忆') && task.includes('[测试]') && task.includes('铁凝喜欢写代码和折腾电脑'), task.slice(0, 200));
  check('v0.8 任务文件含 subagent 指令', task.includes('画像重写员') && task.includes('TOKENS:') && task.includes('memory_profile_archive'), task.slice(-300));
}
{
  const { store, cfg } = await bootFishStore({ mentalModel: true, mentalModelEveryDays: 7 });
  store.stats.lastProfileRewrite = new Date().toISOString();
  const d = await buildDream(store, cfg, 1);
  check('v0.8 未到期 → 报告「画像到期：否」且不写任务文件', d.report.includes('画像到期：否') && d.mentalModel.due === false && d.mentalModel.taskFile === null, d.mentalModel);
}

// --- v0.8.1 注入块缓存稳定性（KV 前缀缓存：文案不得随每轮计数/小时变化）---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-inj-'));
  const st = new Store(dir);
  await st.init();
  // v0.9：这组断言测的是 v0.8.1 的「文案形状」（不随计数/小时变化），
  // 注入快照冻结会改变阈值行行为，因此显式用 live 模式保持原语义。
  const cfgInj = resolveConfig({ dir, dreamReminder: true, dreamAfterHours: 24, injectionMode: 'live' });
  st.stats.lastDream = new Date(Date.now() - 30 * 3600000).toISOString();
  st.stats.capturedSinceDream = 3;
  const r1 = buildInjection(st, cfgInj).text;
  st.stats.capturedSinceDream = 9; // 又聊了几轮：注入块不应变化
  const r2 = buildInjection(st, cfgInj).text;
  check('v0.8.1 欠梦提醒不随每轮计数变化', r1 === r2 && r1.includes('### 睡梦'), { same: r1 === r2, hasDream: r1.includes('### 睡梦') });
  check('v0.8.1 欠梦文案用绝对日期、无小时/计数', r1.includes('上次整理') && !r1.includes('距上次做梦') && !r1.includes('新增对话'), r1.split('\n').filter(l => l.includes('睡梦') || l.includes('欠梦')));
  const m = await saveMemoryCore(st, cfgInj, { title: '到期测试记忆', content: '用于测试复习到期的阈值文案，不显示精确条数。', tags: ['测试'] });
  st.entries.find(x => x.id === m.id).nextReview = new Date(Date.now() - 86400000).toISOString();
  const r3 = buildInjection(st, cfgInj).text;
  check('v0.8.1 热索引不再逐条 ⏰（防搜索后抖动）', !r3.split('\n').some(l => l.startsWith('- ⏰')), r3.split('\n').filter(l => l.includes('到期')));
  check('v0.8.1 到期用阈值文案', r3.includes('有记忆到期该复习'), r3.split('\n').filter(l => l.includes('到期')));
  check('v0.8.1 同状态两次渲染字节一致', buildInjection(st, cfgInj).text === r3);
}

// --- v0.9 缓存感知注入（L1 快照冻结 + 重建观测 + 硬预算）---
const bootSnapStore = async (overrides = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-snap-'));
  const store = new Store(dir);
  await store.init();
  const cfg = resolveConfig({ dir, ...overrides });
  return { store, cfg, dir };
};
const buildText = (store, cfg, now) => buildInjection(store, cfg, now).text;
const waitInjectionWrite = async (store) => { try { await store.injectionWrite; } catch { /* 落盘失败不影响断言 */ } };

check('v0.9 默认 injectionMode=session', resolveConfig({ dir: os.tmpdir() }).injectionMode === 'session');
check('v0.9 injectionMode 白名单校验（非法回落 session）',
  resolveConfig({ injectionMode: 'bogus' }).injectionMode === 'session'
  && resolveConfig({ injectionMode: 'daily' }).injectionMode === 'daily'
  && resolveConfig({ injectionMode: 'live' }).injectionMode === 'live');

{
  // b) session 模式：同会话内冻结，invalidate 后重建
  const { store, cfg } = await bootSnapStore();
  await saveMemoryCore(store, cfg, { title: '会话冻结测试 A', content: '会话内冻结测试的第一条记忆内容。' });
  const t1 = buildText(store, cfg);
  await saveMemoryCore(store, cfg, { title: '会话冻结测试 B', content: '会话内冻结测试的第二条记忆内容。' });
  const t2 = buildText(store, cfg);
  check('v0.9 session：同会话内保存新记忆不改变注入块', t1 === t2 && t1.includes('会话冻结测试 A') && !t2.includes('会话冻结测试 B'));
  const rbBefore = store.stats.injectionRebuilds;
  await store.invalidateInjection('session');
  const t3 = buildText(store, cfg);
  check('v0.9 session：invalidate 后新记忆出现且重建 +1',
    t3.includes('会话冻结测试 B') && store.stats.injectionRebuilds === rbBefore + 1);
}

{
  // c) daily 模式：同日冻结，跨日重建
  const { store, cfg } = await bootSnapStore({ injectionMode: 'daily' });
  const now = Date.now();
  await saveMemoryCore(store, cfg, { title: '日界测试记忆 A', content: '每日刷新模式的跨日测试内容甲方。' });
  const t1 = buildText(store, cfg, now);
  await saveMemoryCore(store, cfg, { title: '日界测试记忆 B', content: '每日刷新模式的跨日测试内容乙方。' });
  const t2 = buildText(store, cfg, now);
  const t3 = buildText(store, cfg, now + 86400000);
  check('v0.9 daily：同日保存新记忆不改变注入块', t1 === t2 && !t2.includes('日界测试记忆 B'));
  check('v0.9 daily：跨日后重建并出现新记忆（reason=day）',
    t3.includes('日界测试记忆 B') && t3 !== t2 && store.stats.lastInjectionRebuild.reason === 'day');
}

{
  // d) live 模式：不缓存、不计数
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live' });
  await saveMemoryCore(store, cfg, { title: '实时模式记忆 A', content: '实时模式的第一条记忆内容。' });
  const t1 = buildText(store, cfg);
  await saveMemoryCore(store, cfg, { title: '实时模式记忆 B', content: '实时模式的第二条记忆内容。' });
  const t2 = buildText(store, cfg);
  check('v0.9 live：保存后立即出现在注入块', t2.includes('实时模式记忆 B') && t2 !== t1);
  check('v0.9 live：不写缓存文件、不计重建', (store.stats.injectionRebuilds || 0) === 0 && !fs.existsSync(path.join(store.dir, 'injection-cache.json')));
}

{
  // e) 重建观测：计数、原因、缓存文件
  const { store, cfg, dir } = await bootSnapStore();
  buildText(store, cfg); // 首次构建 reason=init
  await waitInjectionWrite(store);
  check('v0.9 首次构建计入重建（reason=init）',
    store.stats.injectionRebuilds === 1 && store.stats.lastInjectionRebuild.reason === 'init');
  await store.invalidateInjection('dream');
  buildText(store, cfg);
  await waitInjectionWrite(store);
  const cacheFile = path.join(dir, 'injection-cache.json');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* 下面断言会暴露 */ }
  check('v0.9 重建计数递增且原因/时间/日期记录',
    store.stats.injectionRebuilds === 2
    && store.stats.lastInjectionRebuild.reason === 'dream'
    && typeof store.stats.lastInjectionRebuild.at === 'string'
    && store.stats.lastInjectionRebuild.day === localDay()
    && ['init', 'day', 'session', 'dream', 'consolidate'].includes(store.stats.lastInjectionRebuild.reason));
  check('v0.9 注入快照落盘结构正确',
    fs.existsSync(cacheFile) && !!cache && cache.day === localDay() && Array.isArray(cache.lines)
    && typeof cache.due === 'boolean' && cache.reason === 'dream' && fs.readFileSync(cacheFile, 'utf8').includes('builtAt'));
  // 观测计数不能被 mutating 工具的 withLock→load() 回退
  await saveMemoryCore(store, cfg, { title: '观测计数记忆', content: '用于验证重建计数不会被工具内的 stats 重读冲掉。' });
  check('v0.9 工具调用后重建观测不回退', store.stats.injectionRebuilds === 2 && store.stats.lastInjectionRebuild.reason === 'dream');
}

{
  // f) 重启后稳定：新 Store 指向同目录 → 命中缓存，输出一致、不重建
  const { store, cfg, dir } = await bootSnapStore();
  await saveMemoryCore(store, cfg, { title: '重启缓存记忆', content: '用于验证重启后注入快照命中缓存的内容。' });
  const before = buildText(store, cfg);
  await waitInjectionWrite(store);
  const reopened = new Store(dir);
  await reopened.init();
  const rebuilds0 = reopened.stats.injectionRebuilds || 0;
  const after = buildText(reopened, cfg);
  await waitInjectionWrite(reopened);
  check('v0.9 重启后注入块与重启前一致（命中缓存）', after === before, { beforeTail: before.slice(-100), afterTail: after.slice(-100) });
  check('v0.9 重启命中缓存不增加重建计数', (reopened.stats.injectionRebuilds || 0) === rebuilds0);
}

{
  // g) 硬预算：30 条 30-40 字标题 + 长画像，整块 ≤ 600 tokens
  const { store, cfg } = await bootSnapStore();
  const longProfile = '铁凝：喜欢写代码、折腾电脑、关注新技术（AI / 开发工具 / 编程前沿）。中文交流，语气轻松。'.repeat(30);
  fs.writeFileSync(store.profileFile, `# 小肥鱼记忆 · L0 画像\n\n${longProfile}\n`, 'utf8');
  const words = ['缓存', '重建', '预算', '快照', '日界', '阈值', '画像', '检索', '归档', '复习', '显著', '熬夜', '磁盘', '镜像', '线程', '噪音', '糖分', '拉面', '键盘', '屏幕', '像素', '网速', '电池', '咖啡', '内存', '风扇', '固态', '路由', '行号', '标点'];
  const now = new Date().toISOString();
  const nextReview = new Date(Date.now() + 86400000).toISOString();
  for (let i = 0; i < 30; i++) {
    const word = words[i];
    const entry = {
      id: `budget-test-${i}`,
      title: `压力测试${i}号记忆${word}的标题需要三十到四十个汉字长度以便触发注入预算裁剪`,
      content: `${word}压力测试正文，编号${i}，用于验证注入整块硬预算不会越界。`,
      tags: ['压力'], importance: 3, salience: 5, pinned: false,
      created: now, updated: now, validFrom: now, validTo: null, history: [],
      hits: 0, lastHit: null, status: 'active', supersedes: [], links: [],
      chars: 0, tokens: 0, file: '',
      stability: 10, lastReview: now, nextReview, reviews: 0,
    };
    await store.writeMemory(entry, entry.content);
    store.entries.push(entry);
  }
  await store.saveIndex();
  const hot = buildInjection(store, cfg);
  const total = estTokens(hot.text);
  check('v0.9 硬预算：30 条长标题 + 长画像整块 ≤ 600 tokens', total <= 600, { tokens: total, l1: hot.l1Lines, cold: hot.cold });
  check('v0.9 硬预算：从 L1 末尾裁剪且保留画像/规则行',
    hot.l1Lines > 0 && hot.l1Lines < 12 && hot.text.includes('### 画像') && hot.text.includes('> 规则：'), { l1: hot.l1Lines, cold: hot.cold });
}

{
  // 入口层：session/event 检测新会话 → session 模式失效（子代理/同会话后续消息不重复失效）
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-epoch-'));
  const tools2 = {};
  const listeners2 = [];
  let inj2 = () => '';
  const ctx2 = {
    systemPrompt: { getSectionOrder: () => 42, section(c) { inj2 = c.text; } },
    tools: { register(def) { tools2[def.name] = def; } },
    on(event, fn) { listeners2.push({ event, fn }); },
    inject(deps, fn) { if (deps.includes('webServer')) fn({ webServer: { register() {} } }); },
  };
  apply(ctx2, { dir: dir2, dreamReminder: false, injectionMode: 'session' });
  await new Promise(r => setTimeout(r, 300)); // 等 init 完成
  const emit2 = (s, e) => listeners2.filter(l => l.event === 'session/event').forEach(l => l.fn(s, e));
  const call2 = (n, args) => tools2[n].execute(args ?? {}, { signal: { aborted: false } });
  inj2(); // 首次快照（空索引）
  await call2('memory_save', { title: '纪元前记忆', content: '会话纪元测试：会话开始前保存的记忆。' });
  emit2({ id: 'sess-x', header: {} }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '第一个会话开始' }] } });
  const tA = inj2();
  check('v0.9 入口：新会话触发 session 失效（快照重建）', tA.includes('纪元前记忆'), tA.slice(-160));
  await call2('memory_save', { title: '会话内记忆', content: '会话纪元测试：同一会话内保存的记忆。' });
  const tA2 = inj2();
  check('v0.9 入口：同一会话内保存不刷新快照', !tA2.includes('会话内记忆') && tA2 === tA);
  emit2({ id: 'sess-x', header: {} }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '同一会话再说一句' }] } });
  const tA3 = inj2();
  check('v0.9 入口：同会话后续事件不重复失效', !tA3.includes('会话内记忆') && tA3 === tA);
  emit2({ id: 'sess-y', header: {} }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '第二个会话开始' }] } });
  const tB = inj2();
  check('v0.9 入口：换会话后快照重建并出现会话内记忆', tB.includes('会话内记忆') && tB !== tA);
}

// --- v0.9-B 记忆类型 + 待办注入（task/skill 不进热索引、待办实时、预算整合）---
const sectionOf = (text, heading) => {
  const i = String(text).indexOf(heading);
  if (i < 0) return '';
  const rest = String(text).slice(i + heading.length);
  const end = rest.search(/\n#{3} |\n> |\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
};
const dayOffset = (days) => localDay(new Date(Date.now() + days * 86400000));
{
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live' });
  const past = dayOffset(-2);
  const future = dayOffset(3);
  // 1) 新建任务：dueAt 规范化 + 不初始化复习字段
  const added = await taskCore(store, cfg, { action: 'add', title: '升级 Node 版本', content: '把 Node 升到 v24 并跑全量测试。', dueAt: past, priority: 4 });
  check('v0.9-B 新建待办任务（dueAt 规整为本地日）',
    added.ok === true && added.added === true && added.task.dueAt === past && added.remaining.length === 1, added);
  check('v0.9-B task 不初始化复习字段、不计入到期',
    !store.byId(added.id).nextReview && !store.byId(added.id).stability && store.due().every(e => e.kind !== 'task'));
  const inj1 = buildInjection(store, cfg);
  check('v0.9-B 待办块出现且逾期用「⏰ MM-DD」',
    inj1.text.includes('### 待办') && inj1.text.includes(`- ⏰ ${past.slice(5)} 升级 Node 版本`), inj1.text);
  check('v0.9-B task 不进热索引、不触发到期阈值',
    !sectionOf(inj1.text, '### 热索引').includes('升级 Node 版本') && inj1.due === 0 && !inj1.text.includes('⏰ 有记忆到期该复习'));

  // 2) 未来 dueAt / 无 dueAt 格式 + footer 规则行 + token 观测
  const added2 = await taskCore(store, cfg, { action: 'add', title: '写 v0.9 验收报告', content: '整理验收结论发给铁凝。', dueAt: future, priority: 2 });
  const added3 = await taskCore(store, cfg, { action: 'add', title: '整理桌面文件', content: '把桌面上的临时文件归档。' });
  const inj2 = buildInjection(store, cfg);
  check('v0.9-B 待办格式：未来 dueAt 用「· MM-DD」、无 dueAt 用「· 标题」',
    inj2.text.includes(`- · ${future.slice(5)} 写 v0.9 验收报告`) && inj2.text.includes('- · 整理桌面文件'), inj2.text);
  check('v0.9-B 有待办时 footer 出现闭环规则行', inj2.text.includes('> 完成待办后用 memory_task done 标记，并查看剩余。'));
  check('v0.9-B 待办块计入 token 观测', inj2.tasksOpen === 3 && inj2.tasksOverdue === 1 && inj2.taskTokens > 0 && inj2.taskLines === 3, inj2);

  // 3) 同主题 open task 合并更新
  const dup = await taskCore(store, cfg, { action: 'add', title: '升级 Node 版本', content: '把 Node 升到 v24 并跑全量测试。', dueAt: future });
  check('v0.9-B 同主题 open task 合并更新（不新增）',
    dup.updated === true && dup.id === added.id && store.tasks().length === 3, { dup: dup.id, added: added.id, total: store.tasks().length });

  // 4) list 排序：逾期 → dueAt → priority
  const listed = await taskCore(store, cfg, { action: 'list' });
  check('v0.9-B list 排序（逾期→dueAt→priority）',
    listed.tasks[0].id === added.id && listed.tasks[1].id === added2.id && listed.tasks[2].id === added3.id,
    listed.tasks.map(t => `${t.title}@${t.dueAt || '-'}`));

  // 5) done：remaining 闭环、不再注入、非 open 不可重复
  store.byId(added.id).nextReview = new Date(Date.now() - 86400000).toISOString(); // 刻意塞旧复习时间：task 仍不计到期
  const done = await taskCore(store, cfg, { action: 'done', id: added.id });
  check('v0.9-B 完成任务返回 remaining 闭环',
    done.ok === true && done.taskStatus === 'done' && done.remaining.length === 2 && typeof done.doneAt === 'string', done);
  const inj3 = buildInjection(store, cfg);
  check('v0.9-B 已完成任务不再注入且不计到期', !inj3.text.includes('升级 Node 版本') && inj3.due === 0);
  const again = await taskCore(store, cfg, { action: 'done', id: added.id });
  check('v0.9-B 非 open 任务不能重复完成', again.ok === false && again.code === 'not_open', again);

  // 6) 非法输入
  const badDue = await taskCore(store, cfg, { action: 'add', title: '坏日期任务', content: 'x', dueAt: '2026-13-45' });
  check('v0.9-B 非法 dueAt → invalid_input', badDue.ok === false && badDue.code === 'invalid_input', badDue);
  check('v0.9-B normalizeDueAt 本地日规范化',
    normalizeDueAt('2026-10-01') === '2026-10-01' && normalizeDueAt('') === '' && normalizeDueAt('2026-13-45') === false);

  // 7) drop
  const drop = await taskCore(store, cfg, { action: 'drop', id: added3.id });
  check('v0.9-B 丢弃待办', drop.ok === true && drop.taskStatus === 'dropped' && drop.remaining.length === 1, drop);
}

{
  // 重启后 frontmatter 往返（kind/task_status/due_at/priority/note）
  const { store, cfg, dir } = await bootSnapStore({ injectionMode: 'live' });
  const past = dayOffset(-1);
  await taskCore(store, cfg, { action: 'add', title: '持久化待办测试', content: '重启后仍应存在。', dueAt: past, priority: 5, note: '备注：重启验证' });
  const reopened = new Store(dir);
  await reopened.init();
  const t = reopened.openTasks()[0];
  check('v0.9-B task frontmatter 往返（kind/status/dueAt/priority/note）',
    !!t && t.kind === 'task' && t.taskStatus === 'open' && t.dueAt === past && t.priority === 5 && t.note.includes('重启验证'), t);
  check('v0.9-B 重启后待办块仍注入', buildInjection(reopened, cfg).text.includes(`- ⏰ ${past.slice(5)} 持久化待办测试`));
}

{
  // 旧数据迁移：无 kind 默认 fact；task 缺 taskStatus/priority 时补齐且不初始化复习
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-migrate-'));
  fs.mkdirSync(path.join(dir, 'memories'), { recursive: true });
  const now = new Date().toISOString();
  const oldFact = { id: 'old-fact', title: '旧记忆', content: '旧数据没有 kind。', created: now, updated: now, status: 'active', importance: 3, salience: 5, tags: [] };
  const oldTask = { id: 'old-task', title: '旧任务', content: '旧 task 数据缺字段。', created: now, updated: now, status: 'active', importance: 3, salience: 5, kind: 'task', tags: [] };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, entries: [oldFact, oldTask] }));
  const st = new Store(dir);
  await st.init();
  check('v0.9-B migrate 旧数据默认 fact + 补 task 字段',
    st.byId('old-fact').kind === 'fact'
    && st.byId('old-task').taskStatus === 'open' && st.byId('old-task').priority === 3
    && !st.byId('old-task').nextReview && st.openTasks().length === 1);
}

{
  // skill：可落库、不进热索引；memory_save 不允许 kind=task
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live' });
  const sk = await saveMemoryCore(store, cfg, { title: 'shell 排障套路', content: '遇到 PowerShell 输出编码问题时先查 $OutputEncoding，再查控制台代码页。', kind: 'skill' });
  check('v0.9-B skill 类型落库', sk.ok === true && sk.kind === 'skill' && store.byId(sk.id).kind === 'skill', sk);
  check('v0.9-B skill 不进热索引', !sectionOf(buildInjection(store, cfg).text, '### 热索引').includes('shell 排障套路'));
  const badKind = await saveMemoryCore(store, cfg, { title: '坏类型', content: 'x', kind: 'task' });
  check('v0.9-B memory_save 不允许 kind=task', badKind.ok === false && badKind.code === 'invalid_input', badKind);
}

{
  // 待办块行数上限 5 + 溢出提示；块本身受 taskTokens 约束
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live' });
  const titles = ['升级 Node 到 v24', '补 memory_task 冒烟测试', '整理桌面临时文件', '写 v0.9 验收报告', '修复面板待办按钮', '清理日志目录', '复盘缓存失效问题'];
  for (let i = 0; i < 7; i++) {
    await taskCore(store, cfg, { action: 'add', title: titles[i], content: `第 ${i} 条待办；验证待办块最多 5 行与溢出提示。`, priority: (i % 5) + 1 });
  }
  check('v0.9-B 七个不同待办都落库（无意外去重）', store.openTasks().length === 7, store.openTasks().map(t => t.title));
  const inj = buildInjection(store, cfg);
  const taskSec = sectionOf(inj.text, '### 待办');
  check('v0.9-B 待办块最多 5 行 + 溢出提示', inj.taskLines <= 5 && taskSec.includes('…另有') && inj.text.includes('（memory_task list）'), { lines: inj.taskLines, sec: taskSec });
  check('v0.9-B 待办块 token 不超过 taskTokens', inj.taskTokens <= cfg.taskTokens, { tokens: inj.taskTokens, cap: cfg.taskTokens });
}

{
  // session 模式：任务实时刷新，但 L1 快照不重建（待办块不走快照）
  const { store, cfg } = await bootSnapStore();
  const past = dayOffset(-1);
  await saveMemoryCore(store, cfg, { title: '会话内记忆快照', content: '用于验证待办块实时、L1 冻结。' });
  const before = buildInjection(store, cfg).text;
  const rb = store.stats.injectionRebuilds;
  await taskCore(store, cfg, { action: 'add', title: '会话内实时待办', content: '任务块不走 L1 快照。', dueAt: past });
  const after = buildInjection(store, cfg).text;
  check('v0.9-B session 模式待办块实时刷新且不重建 L1 快照',
    after.includes(`- ⏰ ${past.slice(5)} 会话内实时待办`)
    && store.stats.injectionRebuilds === rb
    && sectionOf(after, '### 热索引') === sectionOf(before, '### 热索引'),
    { rebuilt: store.stats.injectionRebuilds !== rb });
}

{
  // 预算整合：长画像 + 6 条长标题待办 + 12 条记忆 → 整块 ≤ budgetTokens
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live' });
  fs.writeFileSync(store.profileFile, `# 小肥鱼记忆 · L0 画像\n\n${'铁凝：喜欢写代码、折腾电脑、关注新技术（AI / 开发工具 / 编程前沿）。中文交流，语气轻松。'.repeat(30)}\n`, 'utf8');
  const taskTitles = ['升级 Node 到 v24 并验证插件', '补 memory_task 的冒烟测试', '整理桌面临时文件并归档', '写 v0.9 验收报告发铁凝', '修复面板待办完成按钮', '清理 journal 日志目录'];
  for (let i = 0; i < 6; i++) {
    await taskCore(store, cfg, {
      action: 'add',
      title: taskTitles[i],
      content: `预算整合测试任务 ${i}，验证待办块与热索引共享同一份注入预算。`,
      dueAt: dayOffset(i),
      priority: 3,
    });
  }
  const now = new Date().toISOString();
  for (let i = 0; i < 12; i++) {
    const entry = {
      id: `budget-b-${i}`,
      title: `预算整合记忆${i}号标题也需要三十个汉字左右来占用热索引预算`,
      content: `预算整合记忆正文 ${i}。`,
      kind: 'fact',
      tags: ['预算'], importance: 3, salience: 5, pinned: false,
      created: now, updated: now, validFrom: now, validTo: null, history: [],
      hits: 0, lastHit: null, status: 'active', supersedes: [], links: [],
      chars: 0, tokens: 0, file: '',
      stability: 10, lastReview: now, nextReview: new Date(Date.now() + 86400000).toISOString(), reviews: 0,
    };
    await store.writeMemory(entry, entry.content);
    store.entries.push(entry);
  }
  await store.saveIndex();
  const hot = buildInjection(store, cfg);
  check('v0.9-B 预算整合：长画像 + 待办 + 12 条记忆 ≤ budgetTokens',
    estTokens(hot.text) <= cfg.budgetTokens && hot.text.includes('### 待办') && hot.taskTokens > 0,
    { tokens: estTokens(hot.text), budget: cfg.budgetTokens, l1: hot.l1Lines, taskTokens: hot.taskTokens });
}

// --- v0.9-C skill 类型 + dream Phase 6 + 轻量溯源（task/skill 排除出 dream 的合并/衰减/画像材料）---
const rawEntry = (over = {}) => {
  const now = new Date().toISOString();
  return {
    id: over.id, title: '占位', content: '占位正文。', kind: 'fact',
    tags: [], importance: 3, salience: 5, pinned: false,
    created: now, updated: now, validFrom: now, validTo: null, history: [], sources: [],
    hits: 0, lastHit: null, status: 'active', supersedes: [], links: [],
    chars: 0, tokens: 0, file: '',
    stability: 10, lastReview: now, nextReview: new Date(Date.now() + 86400000).toISOString(), reviews: 0,
    ...over,
  };
};
const pushRaw = async (store, over) => {
  const e = rawEntry(over);
  await store.writeMemory(e, e.content);
  store.entries.push(e);
  return e;
};
{
  // SWS：只合并 fact；skill/task 不参与
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: false, mentalModel: false, dreamReminder: false });
  const f1 = await pushRaw(store, { id: 'c-sws-f1', title: '发布流程规范', content: '发布前先跑测试，再打包，最后推送版本标签。' });
  const f2 = await pushRaw(store, { id: 'c-sws-f2', title: '发布流程规范', content: '发布前先跑测试，再打包，最后推送版本标签并记录。' });
  const s1 = await pushRaw(store, { id: 'c-sws-s1', kind: 'skill', title: '技能甲：用 rg 搜索代码', content: '技能甲：用 rg 搜索代码比 grep 快。' });
  const s2 = await pushRaw(store, { id: 'c-sws-s2', kind: 'skill', title: '技能甲：用 rg 搜索代码', content: '技能甲：用 rg 搜索代码比 grep 快很多。' });
  const t1 = await pushRaw(store, { id: 'c-sws-t1', kind: 'task', taskStatus: 'open', dueAt: '', doneAt: null, priority: 3, note: '', title: '任务甲：升级 Node', content: '任务甲：升级 Node 到 v24。' });
  const t2 = await pushRaw(store, { id: 'c-sws-t2', kind: 'task', taskStatus: 'open', dueAt: '', doneAt: null, priority: 3, note: '', title: '任务甲：升级 Node', content: '任务甲：升级 Node 到 v24 并验证。' });
  const d = await buildDream(store, cfg, 1);
  check('v0.9-C SWS 只合并 fact（skill/task 不参与）',
    d.phases.sws.merged.length === 1
    && [f1.id, f2.id].includes(d.phases.sws.merged[0].kept)
    && [f1.id, f2.id].includes(d.phases.sws.merged[0].dropped)
    && [s1, s2, t1, t2].every(e => store.byId(e.id).status === 'active'),
    d.phases.sws.merged);
}
{
  // SHY：只衰减 fact；skill/task 不参与
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: false, mentalModel: false, dreamReminder: false });
  const old = new Date(Date.now() - 120 * 86400000).toISOString();
  const oldNext = new Date(Date.now() - 100 * 86400000).toISOString();
  const factOld = await pushRaw(store, { id: 'c-shy-fact', title: '很久以前的事实', content: '这是一条很久以前的事实记忆。', updated: old, created: old, stability: 3, nextReview: oldNext });
  const skillOld = await pushRaw(store, { id: 'c-shy-skill', kind: 'skill', title: '很久以前的技能', content: '这是一条很久以前提炼的技能。', updated: old, created: old });
  const taskOld = await pushRaw(store, { id: 'c-shy-task', kind: 'task', taskStatus: 'open', dueAt: '', doneAt: null, priority: 3, note: '', title: '很久以前的待办', content: '这是一条很久以前的待办任务。', updated: old, created: old });
  const d = await buildDream(store, cfg, 1);
  check('v0.9-C SHY 只衰减 fact（skill/task 不参与）',
    d.phases.shy.demoted.some(x => x.id === factOld.id)
    && !d.phases.shy.demoted.some(x => x.id === skillOld.id || x.id === taskOld.id)
    && store.byId(skillOld.id).status === 'active' && store.byId(taskOld.id).status === 'active',
    d.phases.shy.demoted);
}
{
  // Phase 4：画像材料只保留 fact（排除 task/skill）
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: false, mentalModel: true, mentalModelEveryDays: 7, dreamReminder: false });
  const f = await saveMemoryCore(store, cfg, { title: '用户偏好中文交流', content: '铁凝偏好中文交流，语气轻松。' });
  const sk = await saveMemoryCore(store, cfg, { title: '不该进画像的技能', content: '技能不该进 L0 画像材料。', kind: 'skill' });
  const tk = await taskCore(store, cfg, { action: 'add', title: '不该进画像的待办', content: '待办不该进 L0 画像材料。' });
  const d = await buildDream(store, cfg, 1);
  const mentalText = fs.readFileSync(d.mentalModel.taskFile, 'utf8');
  check('v0.9-C Phase4 画像材料含 fact', d.mentalModel.due === true && mentalText.includes(f.id) && mentalText.includes('用户偏好中文交流'));
  check('v0.9-C Phase4 画像材料排除 task/skill',
    !mentalText.includes('不该进画像的技能') && !mentalText.includes('不该进画像的待办')
    && !mentalText.includes(sk.id) && !mentalText.includes(tk.id));
}
{
  // Phase 6：有已完成 task → 生成 skill 任务文件（在 dream 报告之前生成，报告引用路径）
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: true, mentalModel: false, dreamReminder: false });
  const yesterday = dayOffset(-1);
  await store.saveDreamReport(yesterday, '# 睡梦报告\n\n- 昨天复盘了发布流程。\n');
  const t = await taskCore(store, cfg, { action: 'add', title: '给插件加水印', content: '给 SVG 图加水印并导出 PNG。', note: '验收：输出可预览' });
  const doneRes = await taskCore(store, cfg, { action: 'done', id: t.id, note: '用 sharp 处理，验收通过' });
  store.byId(t.id).tags = ['部署'];
  const memTagged = await saveMemoryCore(store, cfg, { title: '水印处理统一用 sharp', content: '水印处理统一用 sharp，避免 canvas 原生依赖。', tags: ['部署'] });
  const memOther = await saveMemoryCore(store, cfg, { title: '导出图片统一 PNG', content: '导出图片统一 PNG 300dpi。', tags: ['导出'] });
  const d = await buildDream(store, cfg, 1);
  const se = d.skillExtraction;
  check('v0.9-C Phase 6 有已完成 task → enabled/due/taskFile/completedCount',
    se.enabled === true && se.due === true && typeof se.taskFile === 'string'
    && fs.existsSync(se.taskFile) && se.taskFile.endsWith('-skill-task.md') && se.completedCount === 1, se);
  const taskText = fs.readFileSync(se.taskFile, 'utf8');
  check('v0.9-C Phase 6 任务文件含 task 材料（id/标题/正文/备注/完成时间）',
    taskText.includes(t.id) && taskText.includes('给插件加水印')
    && taskText.includes('给 SVG 图加水印并导出 PNG') && taskText.includes('验收：输出可预览')
    && taskText.includes('用 sharp 处理，验收通过') // done 时追加的完成备注
    && taskText.includes('完成于：') && taskText.includes(doneRes.doneAt));
  check('v0.9-C Phase 6 任务文件含相关记忆（同标签优先）',
    taskText.includes(memTagged.id) && taskText.includes(memOther.id)
    && taskText.includes('水印处理统一用 sharp')
    && taskText.indexOf(memTagged.id) < taskText.indexOf(memOther.id));
  check('v0.9-C Phase 6 任务文件含最近睡梦摘要', taskText.includes(`### ${yesterday}`) && taskText.includes('昨天复盘了发布流程'));
  check('v0.9-C Phase 6 任务文件含给 subagent 的指令',
    taskText.includes('技能提炼员') && taskText.includes('TITLE:') && taskText.includes('SKILL:')
    && taskText.includes('TAGS:') && taskText.includes('SOURCES:') && taskText.includes("memory_save(kind='skill'")
    && taskText.includes('不要调用任何工具'));
  check('v0.9-C dream 报告含 Phase 6 节并引用任务文件',
    d.report.includes('## 🧠 Phase 6 · Skill 提炼') && d.report.includes('技能提炼：是')
    && d.report.includes(se.taskFile) && fs.existsSync(d.file));
  check('v0.9-C 生成任务文件后 lastSkillExtract 更新并持久化',
    typeof store.stats.lastSkillExtract === 'string'
    && JSON.parse(fs.readFileSync(store.statsFile, 'utf8')).lastSkillExtract === store.stats.lastSkillExtract);
  const lastExtract = store.stats.lastSkillExtract;
  const d2 = await buildDream(store, cfg, 1);
  check('v0.9-C 再次做梦不重复生成（due:false/taskFile:null/报告否）',
    d2.skillExtraction.due === false && d2.skillExtraction.taskFile === null && d2.skillExtraction.completedCount === 0
    && d2.report.includes('技能提炼：否') && store.stats.lastSkillExtract === lastExtract);
}
{
  // >10 个已完成 task：任务文件材料 ≤10 条，completedCount 为总完成数
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: true, mentalModel: false, dreamReminder: false });
  for (let i = 0; i < 12; i++) {
    const t = await taskCore(store, cfg, { action: 'add', title: `批量完成${i}号任务`, content: `批量完成测试任务 ${i}，用于验证材料上限。` });
    await taskCore(store, cfg, { action: 'done', id: t.id });
  }
  const d = await buildDream(store, cfg, 1);
  const text = fs.readFileSync(d.skillExtraction.taskFile, 'utf8');
  const sec = text.slice(text.indexOf('## 1.'), text.indexOf('## 2.'));
  const materialCount = (sec.match(/完成于：/g) || []).length;
  check('v0.9-C Phase 6 材料最多 10 个 task（completedCount 为总数）',
    d.skillExtraction.completedCount === 12 && materialCount === 10,
    { count: d.skillExtraction.completedCount, materialCount });
}
{
  // Phase 6 关闭：enabled:false、不生成、报告无 Phase 6 节
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: false, mentalModel: false, dreamReminder: false });
  const t = await taskCore(store, cfg, { action: 'add', title: '禁用提炼测试任务', content: '完成后也不该生成 skill 任务。' });
  await taskCore(store, cfg, { action: 'done', id: t.id });
  const d = await buildDream(store, cfg, 1);
  check('v0.9-C skillExtraction:false → enabled:false 且不生成/不显示 Phase 6',
    d.skillExtraction.enabled === false && d.skillExtraction.due === false && d.skillExtraction.taskFile === null
    && !d.report.includes('Phase 6') && !d.report.includes('Skill 提炼')
    && !fs.readdirSync(store.dreamDir).some(f => f.includes('-skill-task')));
}
{
  // 无已完成 task → due:false、taskFile:null
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: true, mentalModel: false, dreamReminder: false });
  const d = await buildDream(store, cfg, 1);
  check('v0.9-C 无已完成 task → due:false taskFile:null',
    d.skillExtraction.enabled === true && d.skillExtraction.due === false
    && d.skillExtraction.taskFile === null && d.skillExtraction.completedCount === 0
    && d.report.includes('技能提炼：否'));
}
{
  // 已完成 task 需 status==='active'
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: true, mentalModel: false, dreamReminder: false });
  const t = await taskCore(store, cfg, { action: 'add', title: '归档任务不算', content: 'status 非 active 不算已完成的材料。' });
  await taskCore(store, cfg, { action: 'done', id: t.id });
  store.byId(t.id).status = 'archived';
  const d = await buildDream(store, cfg, 1);
  check('v0.9-C 非 active 的已完成 task 不计入 Phase 6', d.skillExtraction.due === false && d.skillExtraction.completedCount === 0);
}
{
  // doneAt 不晚于 lastSkillExtract → 不重复生成
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: true, mentalModel: false, dreamReminder: false });
  const t = await taskCore(store, cfg, { action: 'add', title: '已完成但已提炼过', content: '上次提炼之后没有新完成的任务。' });
  await taskCore(store, cfg, { action: 'done', id: t.id });
  store.stats.lastSkillExtract = new Date().toISOString();
  const d = await buildDream(store, cfg, 1);
  check('v0.9-C doneAt 不晚于 lastSkillExtract → 不重复生成',
    d.skillExtraction.due === false && d.skillExtraction.taskFile === null);
}
{
  // sources 溯源 + kind 不降级
  const { store, cfg, dir } = await bootSnapStore({ injectionMode: 'live', noopThreshold: 2, skillExtraction: false, mentalModel: false, dreamReminder: false });
  const src1 = await taskCore(store, cfg, { action: 'add', title: '来源任务一', content: '给 sources 测试提供来源一。' });
  const src2 = await taskCore(store, cfg, { action: 'add', title: '来源任务二', content: '给 sources 测试提供来源二。' });
  const sk = await saveMemoryCore(store, cfg, { title: '部署技能：先跑测试', content: '部署前先跑冒烟测试，确认 ALL PASS 再发布。', kind: 'skill', sources: [src1.id, src2.id, 'mem-x'] });
  check('v0.9-C sources 新条目落库', sk.ok === true && Array.isArray(sk.sources) && sk.sources.length === 3 && sk.sources[0] === src1.id, sk.sources);
  const fmText = fs.readFileSync(store.byId(sk.id).file, 'utf8');
  check('v0.9-C frontmatter sources 逗号风格', fmText.includes(`sources: ${src1.id}, ${src2.id}, mem-x`), fmText.split('\n').filter(l => l.startsWith('sources:')));
  const reopened = new Store(dir);
  await reopened.init();
  check('v0.9-C 重启后 sources 解析往返',
    Array.isArray(reopened.byId(sk.id).sources) && reopened.byId(sk.id).sources.length === 3 && reopened.byId(sk.id).sources[2] === 'mem-x');
  const sk2 = await saveMemoryCore(store, cfg, { title: '部署技能：先跑测试', content: '部署前先跑冒烟测试，确认 ALL PASS 再发布。', kind: 'skill', sources: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] });
  check('v0.9-C 更新分支 sources 取并集并保留最近 5 个',
    sk2.updated === true && sk2.sources.length === 5 && sk2.sources[4] === 'm6' && !sk2.sources.includes(src1.id), sk2.sources);
  const downgrade = await saveMemoryCore(store, cfg, { title: '部署技能：先跑测试', content: '部署前先跑冒烟测试，确认 ALL PASS 再发布。', kind: 'fact' });
  check('v0.9-C kind 不可降级：skill 不被同主题 fact 覆盖',
    downgrade.updated === true && store.byId(sk.id).kind === 'skill' && downgrade.kind === 'skill', { kind: store.byId(sk.id).kind });
  const f = await saveMemoryCore(store, cfg, { title: '面板端口固定 60398', content: 'DSH 面板固定端口 60398。' });
  const up = await saveMemoryCore(store, cfg, { title: '面板端口固定 60398', content: 'DSH 面板固定端口 60398。', kind: 'skill' });
  check('v0.9-C fact→skill 允许升级', up.updated === true && store.byId(f.id).kind === 'skill', up.kind);
}
{
  // skill 不进 L1 热索引 / 不进待办块；fact/task 各就各位
  const { store, cfg } = await bootSnapStore({ injectionMode: 'live', skillExtraction: false, mentalModel: false, dreamReminder: false });
  await saveMemoryCore(store, cfg, { title: '普通事实记忆条目', content: '这是一条普通事实。' });
  await saveMemoryCore(store, cfg, { title: '提炼出来的技能条目', content: '这是一条技能。', kind: 'skill', sources: ['t-source-1'] });
  await taskCore(store, cfg, { action: 'add', title: '待办任务条目', content: '这是一条待办。' });
  const inj = buildInjection(store, cfg);
  check('v0.9-C skill 不进 L1 热索引也不进待办块',
    !inj.text.includes('提炼出来的技能条目')
    && !sectionOf(inj.text, '### 热索引').includes('技能条目') && !sectionOf(inj.text, '### 待办').includes('技能条目'));
  check('v0.9-C fact/task 各就各位',
    sectionOf(inj.text, '### 热索引').includes('普通事实记忆条目') && sectionOf(inj.text, '### 待办').includes('待办任务条目'));
}

// --- 整理 / 置顶 / 遗忘 ---
const cons = await call('memory_consolidate', { dryRun: false });
check('整理报告可序列化', typeof cons.mergedCount === 'number', cons);
const unpin = await call('memory_pin', { id: s3.id, pinned: false });
check('取消置顶', unpin.pinned === false, unpin);
const forgot = await call('memory_forget', { id: s3.id });
check('遗忘记忆', forgot.forgotten === true, forgot);

const block = injected();
check('注入块含画像', block.includes('铁凝'), block);
check('注入块含热索引', block.includes('项目统一用 pnpm'), block);
check('遗忘后不再注入', !block.includes('铁凝喜欢表情包'), block);
const stats2 = await call('memory_stats', {});
check('注入预算 ≤ 600 tokens', stats2.injectedL1Tokens <= 600, stats2.injectedL1Tokens);

// --- v0.9-B 待办任务（主实例：工具 / 注入 / 检索 / 面板全链路）---
{
  const past = dayOffset(-1);
  const dueBeforeB = stats2.dueReview;
  const tAdd = await call('memory_task', { action: 'add', title: '主实例待办：写测试', content: '给 memory_task 补冒烟测试。', dueAt: past, priority: 5 });
  check('v0.9-B 主实例新增任务返回 remaining 闭环',
    tAdd.ok === true && tAdd.added === true && Array.isArray(tAdd.remaining) && tAdd.remaining.length === 1, tAdd);
  const blockB = injected();
  check('v0.9-B 注入块实时出现待办区（不用等会话刷新）',
    blockB.includes('### 待办') && blockB.includes(`- ⏰ ${past.slice(5)} 主实例待办：写测试`) && blockB.includes('完成待办后用 memory_task done'), blockB);
  check('v0.9-B 任务不进热索引', !sectionOf(blockB, '### 热索引').includes('主实例待办'), sectionOf(blockB, '### 热索引'));
  const stB = await call('memory_stats', {});
  check('v0.9-B stats 待办与类型构成',
    stB.tasksOpen === 1 && stB.tasksOverdue === 1 && stB.taskTokens > 0
    && stB.kindCounts.task === 1 && stB.kindCounts.fact >= 2, { open: stB.tasksOpen, overdue: stB.tasksOverdue, counts: stB.kindCounts });
  check('v0.9-B task 不计入待复习', stB.dueReview === dueBeforeB, { before: dueBeforeB, after: stB.dueReview });
  const listAll = await call('memory_list', { limit: 50 });
  const listFacts = await call('memory_list', { limit: 50, kind: 'fact' });
  const listTasks = await call('memory_list', { limit: 50, kind: 'task' });
  check('v0.9-B memory_list kind 过滤（默认 all 兼容）',
    listAll.total === listFacts.total + listTasks.total
    && listTasks.entries.every(e => e.kind === 'task') && listFacts.entries.every(e => e.kind !== 'task'),
    { all: listAll.total, facts: listFacts.total, tasks: listTasks.total });
  const searchTask = await call('memory_search', { query: 'memory_task 补冒烟' });
  check('v0.9-B search 结果带 kind/taskStatus/dueAt',
    searchTask.matches.some(m => m.kind === 'task' && m.taskStatus === 'open' && m.dueAt === past), searchTask.matches);
  const doneB = await call('memory_task', { action: 'done', id: tAdd.id });
  check('v0.9-B 完成任务 remaining 清空', doneB.ok === true && doneB.taskStatus === 'done' && doneB.remaining.length === 0, doneB);
  const afterDone = await call('memory_search', { query: '主实例待办' });
  check('v0.9-B 完成后不再注入但 search 可查',
    !injected().includes('主实例待办：写测试') && afterDone.matches.some(m => m.taskStatus === 'done'), afterDone.matches);
  const badAction = await call('memory_task', { action: 'bogus' });
  check('v0.9-B 非法 action → invalid_input', badAction.ok === false && badAction.code === 'invalid_input');
  const badDone = await call('memory_task', { action: 'done', id: 'not-exist' });
  check('v0.9-B 不存在任务 → not_found', badDone.ok === false && badDone.code === 'not_found');
  const skillB = await call('memory_save', { title: '主实例技能：先跑测试', content: '改动插件后先跑 node tests/smoke.mjs，ALL PASS 再提交。', kind: 'skill' });
  const stSkill = await call('memory_stats', {});
  check('v0.9-B skill 不进热索引但计入 kindCounts',
    skillB.kind === 'skill' && stSkill.kindCounts.skill === 1 && !sectionOf(injected(), '### 热索引').includes('主实例技能'),
    { counts: stSkill.kindCounts });
  const res3 = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  await stateRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:36336' } }, res3);
  const stateB = JSON.parse(res3.body);
  check('v0.9-B 面板 state 带 tasks/tasksOpen/tasksOverdue 且记忆列表不含 task',
    Array.isArray(stateB.tasks) && stateB.tasksOpen === 0 && typeof stateB.tasksOverdue === 'number'
    && stateB.entries.every(e => e.kind !== 'task'), { open: stateB.tasksOpen });
  check('v0.9-B 面板 HTML 含待办区块与完成/丢弃按钮',
    res.body.includes('待办（open task）') && res.body.includes('taskDone') && res.body.includes('taskDrop'));
  const t2 = await call('memory_task', { action: 'add', title: '面板操作任务', content: '从面板按钮丢弃。' });
  const actionRoute = routes.find(r => r.path === '/memory-fish/api/action');
  const reqDrop = { method: 'POST', headers: { host: '127.0.0.1:36336' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action: 'taskDrop', id: t2.id })); } };
  const res4 = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  await actionRoute.handler(reqDrop, res4);
  const dropRes = JSON.parse(res4.body);
  check('v0.9-B 面板 taskDrop 生效', dropRes.ok === true && dropRes.taskStatus === 'dropped', dropRes);
}

// --- v0.9-C sources / skill / Phase 6（主实例：工具链 + dream 全链路）---
{
  const srcTask = await call('memory_task', { action: 'add', title: '溯源来源任务', content: '给 sources 测试提供来源 task id。' });
  const skillC = await call('memory_save', { title: 'v0.9-C 溯源技能', content: '用 sources 字段把技能指回来源任务 id，最多五个。', kind: 'skill', sources: [srcTask.id, 'manual-id'] });
  check('v0.9-C memory_save 落库 sources',
    skillC.ok === true && Array.isArray(skillC.sources) && skillC.sources.length === 2 && skillC.sources[0] === srcTask.id, skillC);
  const rd = await call('memory_read', { id: skillC.id });
  check('v0.9-C memory_read 返回 sources/kind', Array.isArray(rd.sources) && rd.sources.includes(srcTask.id) && rd.kind === 'skill', rd.sources);
  const se = await call('memory_search', { query: '溯源技能' });
  check('v0.9-C memory_search 返回 sources',
    se.matches.some(m => m.id === skillC.id && Array.isArray(m.sources) && m.sources.includes(srcTask.id)), se.matches);
  const li = await call('memory_list', { limit: 50, kind: 'skill' });
  check('v0.9-C memory_list 返回 sources', li.entries.some(e => e.id === skillC.id && Array.isArray(e.sources)), li.entries);
  const stC = await call('memory_stats', {});
  check('v0.9-C stats 带 skill 观测',
    stC.kindCounts.skill >= 2 && stC.skillExtraction === true && stC.lastSkillExtract === null,
    { counts: stC.kindCounts, last: stC.lastSkillExtract });
  const dreamC = await call('memory_dream', { days: 1 });
  check('v0.9-C memory_dream 返回 skillExtraction 并生成任务文件',
    dreamC.skillExtraction && dreamC.skillExtraction.enabled === true && dreamC.skillExtraction.due === true
    && typeof dreamC.skillExtraction.taskFile === 'string' && fs.existsSync(dreamC.skillExtraction.taskFile)
    && dreamC.skillExtraction.completedCount >= 1, dreamC.skillExtraction);
  check('v0.9-C dream 报告含 Phase 6 与任务文件路径',
    dreamC.report.includes('## 🧠 Phase 6 · Skill 提炼') && dreamC.report.includes('技能提炼：是')
    && dreamC.report.includes(dreamC.skillExtraction.taskFile), dreamC.report.slice(-400));
  const stC2 = await call('memory_stats', {});
  check('v0.9-C lastSkillExtract 在主实例更新并持久化',
    typeof stC2.lastSkillExtract === 'string'
    && JSON.parse(fs.readFileSync(path.join(memDir, 'stats.json'), 'utf8')).lastSkillExtract === stC2.lastSkillExtract);
  const dreamC2 = await call('memory_dream', { days: 1 });
  check('v0.9-C 主实例再次做梦不重复生成', dreamC2.skillExtraction.due === false && dreamC2.skillExtraction.taskFile === null);
}

console.log('\n--- injected block ---');
console.log(block);
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed === 0 ? 0 : 1);



