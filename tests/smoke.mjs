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

apply(ctx, { dir: memDir, budgetTokens: 600, profileTokens: 200, dreamAfterHours: 0 });
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
check('注册 10 个工具', Object.keys(tools).length === 10);

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



