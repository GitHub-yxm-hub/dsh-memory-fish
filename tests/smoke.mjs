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
check('注册 11 个工具', Object.keys(tools).length === 11);

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
const { saveMemoryCore } = await import(pathToFileURL(path.join(root, 'lib/core.mjs')).href);
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

console.log('\n--- injected block ---');
console.log(block);
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed === 0 ? 0 : 1);



