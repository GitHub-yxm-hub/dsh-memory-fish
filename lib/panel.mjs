import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { dayOf, isDue, out, profileRewriteStatus } from './util.mjs';
import { buildInjection } from './inject.mjs';

// ---------------------------------------------------------------- 面板 / 做梦

/** 面板请求来源校验：只允许本机同源请求（防 DNS rebinding / 跨站写入）。 */
export function trustedRequest(request, expectedMethod) {
  if (expectedMethod && request.method && request.method !== expectedMethod) return false;
  const h = request.headers ?? {};
  const site = h['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  if (typeof h.origin === 'string') {
    try { if (new URL(h.origin).host !== h.host) return false; } catch { return false; }
  }
  if (h.host !== undefined) {
    const okHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h.host)
      || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(h.host)
      || /^\[[0-9a-f:]+\](:\d+)?$/i.test(h.host);
    if (!okHost) return false;
  }
  return true;
}

export function replyJson(response, code, payload) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}


const PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小肥鱼记忆</title>
<style>
:root{--bg:#0f1419;--card:#171d26;--line:#263041;--fg:#e6edf3;--dim:#8b98a9;--accent:#4cc2ff;--warn:#ffb454;--ok:#5ee0a0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,"Segoe UI",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}h1 span{color:var(--dim);font-size:13px;font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{color:var(--dim);font-size:12px}.card .v{font-size:22px;font-weight:600;margin-top:2px}
.bar{height:8px;background:#0b0f14;border-radius:4px;overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--ok),var(--accent))}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
.panel h2{font-size:14px;margin:0 0 10px;color:var(--accent);font-weight:600}
textarea,input{width:100%;background:#0b0f14;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}
textarea{min-height:96px;resize:vertical}
button{background:#1e2a3a;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:#04121c;border-color:var(--accent);font-weight:600}
button.danger{color:#ff8b8b}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mem{border-bottom:1px solid var(--line);padding:8px 0;display:flex;gap:10px;align-items:flex-start}
.mem:last-child{border-bottom:0}
.mem .t{flex:1}.mem .t b{font-weight:600}.mem .m{color:var(--dim);font-size:12px}
.tag{display:inline-block;background:#1b2636;color:var(--accent);border-radius:6px;padding:0 6px;font-size:11px;margin-left:6px}
.pin{color:var(--warn)}
pre{white-space:pre-wrap;background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:260px;overflow:auto;font-size:12px}
.muted{color:var(--dim);font-size:12px}
</style></head><body><div class="wrap">
<h1>小肥鱼记忆 <span>dsh-memory-fish · 本地文件，零服务端</span></h1>
<div class="cards" id="cards"></div>
<div class="panel"><h2>L0 画像（常驻注入）</h2>
<textarea id="profile"></textarea>
<div class="row" style="margin-top:8px"><button class="primary" id="saveProfile">保存画像</button><span class="muted" id="profileHint"></span></div></div>
<div class="panel"><h2>记忆（热索引 + 冷区）</h2>
<div class="row"><input id="q" placeholder="搜索记忆（标题/标签/正文）" style="flex:1"><button id="searchBtn">搜索</button><button id="resetBtn">重置</button></div>
<div id="list" style="margin-top:8px"></div></div>
<div class="panel"><h2>睡梦机制（每天回顾对话，提炼记忆）</h2>
<div class="muted" id="dreamInfo">还没有做梦记录</div>
<div class="row" style="margin-top:8px"><button id="dreamBtn">现在做梦</button><button id="consolidateBtn">整理记忆</button><span class="muted" id="dreamHint"></span></div>
<pre id="dreamReport" style="margin-top:10px">—</pre></div>
</div>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.json()}
function card(k,v,extra){return '<div class="card"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div>'+(extra||'')+'</div>'}
async function refresh(){
  const s=await api('api/state');
  const pct=Math.min(100,Math.round(s.injected/budgetMax*100));
  $('#cards').innerHTML=card('注入 tokens',s.injected+' / '+budgetMax,'<div class="bar"><i style="width:'+pct+'%"></i></div>')
    +card('活跃记忆',s.active)+card('置顶',s.pinned)+card('待复习',s.due||0)+card('归档/遗忘',s.archived)
    +card('今日对话',s.todayMessages)+card('候选线索',s.dreamCues);
  if(document.activeElement!==$('#profile'))$('#profile').value=s.profile;
  $('#profileHint').textContent='约 '+s.profileTokens+' tokens';
  $('#dreamInfo').textContent='最近一次做梦：'+(s.lastDream||'无')+' · 已做 '+s.dreams+' 次 · 画像重写：'+(s.lastProfileRewrite?String(s.lastProfileRewrite).slice(0,10):'从未')+(s.profileDue?'（已到期）':'');
  $('#dreamReport').textContent=s.dreamReport||'—';
  render(s.entries);
}
const budgetMax=600;
function render(entries){
  if(!entries.length){$('#list').innerHTML='<div class="muted">还没有记忆</div>';return}
  $('#list').innerHTML=entries.map(e=>'<div class="mem"><div class="t"><b>'+((e.due&&!e.pinned)?'<span class="pin">⏰ </span>':(e.pinned?'<span class="pin">★ </span>':''))+esc(e.title)+'</b>'
    +e.tags.map(t=>'<span class="tag">'+esc(t)+'</span>').join('')
    +'<div class="m">'+esc(e.updated)+' · 生效 '+esc(e.validFrom||'')+' · 显著性 '+(e.salience??5)+' · 重要度 '+e.importance+' · 命中 '+e.hits+(e.nextReview?' · 复习 '+esc(e.nextReview.slice(0,10)):'')+'</div></div>'
    +'<div class="row"><button onclick="act(\\''+(e.pinned?'unpin':'pin')+'\\',\\''+esc(e.id)+'\\')">'+(e.pinned?'取消置顶':'置顶')+'</button>'
    +'<button class="danger" onclick="act(\\'forget\\',\\''+esc(e.id)+'\\')">遗忘</button></div></div>').join('');
}
async function act(action,id){
  const r=await api('api/action',{action,id});
  if(!r.ok)alert(r.message||'操作失败');
  refresh();
}
$('#saveProfile').onclick=async()=>{const r=await api('api/action',{action:'profile',content:$('#profile').value});$('#profileHint').textContent=r.ok?'已保存（约 '+r.tokens+' tokens）':'失败';refresh()};
$('#searchBtn').onclick=async()=>{const q=$('#q').value.trim();if(!q)return refresh();const r=await api('api/action',{action:'search',query:q});render(r.matches||[])};
$('#resetBtn').onclick=()=>{$('#q').value='';refresh()};
$('#dreamBtn').onclick=async()=>{$('#dreamHint').textContent='做梦ing…';const r=await api('api/action',{action:'dream'});$('#dreamHint').textContent=r.ok?('SWS 合并 '+r.phases.sws+' · SHY 归档 '+r.phases.shy+' · REM 链接 '+r.phases.rem+' · 待复习 '+r.due):'失败';refresh()};
$('#consolidateBtn').onclick=async()=>{$('#dreamHint').textContent='整理中…';const r=await api('api/action',{action:'consolidate'});$('#dreamHint').textContent=r.ok?('合并 '+r.merged+' 条 / 归档 '+r.archived+' 条'):'失败';refresh()};
refresh();setInterval(refresh,8000);
</script></body></html>`;

// ---------------------------------------------------------------- 面板路由（模块级，便于测试）

export function registerPanelRoutes(webServer, store, cfg, toolImpl) {
  if (!webServer || typeof webServer.register !== 'function') return;

  const latestDream = async () => {
    try {
      const files = (await fs.readdir(store.dreamDir)).filter(f => f.endsWith('.md') && !f.includes('-mental-model')).sort();
      if (!files.length) return '';
      const text = await fs.readFile(path.join(store.dreamDir, files[files.length - 1]), 'utf8');
      return text.slice(0, 4000);
    } catch { return ''; }
  };

  webServer.register({
    kind: 'exact',
    path: cfg.panelPath,
    handler: async (request, response) => {
      if (!trustedRequest(request, 'GET')) { replyJson(response, 403, { ok: false, error: 'cross-origin refused' }); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PANEL_HTML);
    },
  });

  webServer.register({
    kind: 'exact',
    path: `${cfg.apiBase}/state`,
    handler: async (request, response) => {
      if (!trustedRequest(request, 'GET')) { replyJson(response, 403, { ok: false, error: 'cross-origin refused' }); return; }
      try {
        if (!store.entries.length) await store.load();
        const hot = buildInjection(store, cfg);
        const profileRaw = fsSync.existsSync(store.profileFile) ? fsSync.readFileSync(store.profileFile, 'utf8') : '';
        const journal = await store.readJournal(1);
        const dreamReport = await latestDream();
        const entries = store.visible().slice(0, 200).map(e => out({
          id: e.id, title: e.title, pinned: !!e.pinned, tags: e.tags || [],
          importance: e.importance ?? 3, salience: e.salience ?? 5,
          stability: e.stability ?? null, nextReview: e.nextReview ?? null,
          due: isDue(e), reviews: e.reviews || 0,
          validFrom: dayOf(e.validFrom || e.created), historyCount: (e.history || []).length,
          updated: dayOf(e.updated), hits: e.hits || 0,
        }));
        replyJson(response, 200, {
          ok: true,
          injected: hot.l1Tokens,
          budget: cfg.budgetTokens,
          profileTokens: hot.profileTokens,
          profile: profileRaw.replace(/^#.*\n+/, '').trim(),
          active: store.entries.filter(e => e.status === 'active').length,
          archived: store.entries.filter(e => e.status !== 'active').length,
          pinned: store.entries.filter(e => e.status === 'active' && e.pinned).length,
          due: store.due().length,
          todayMessages: journal.length,
          dreamCues: dreamReport ? (dreamReport.match(/^\d+\. /gm) || []).length : 0,
          dreams: store.stats.dreams || 0,
          lastDream: store.stats.lastDream || '',
          lastProfileRewrite: store.stats.lastProfileRewrite || '',
          profileRewrites: store.stats.profileRewrites || 0,
          profileDue: profileRewriteStatus(cfg, store.stats).due,
          dreamReport,
          entries,
        });
      } catch (error) {
        replyJson(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  webServer.register({
    kind: 'exact',
    path: `${cfg.apiBase}/action`,
    handler: async (request, response) => {
      if (!trustedRequest(request, 'POST')) { replyJson(response, 403, { ok: false, error: 'cross-origin refused' }); return; }
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const result = await runPanelAction(String(body.action ?? ''), body, store, cfg, toolImpl);
        replyJson(response, 200, result);
      } catch (error) {
        replyJson(response, 400, { ok: false, message: String(error?.message ?? error) });
      }
    },
  });
}

export async function runPanelAction(action, body, store, cfg, toolImpl) {
  const exec = { signal: { aborted: false } };
  if (action === 'pin') return await toolImpl.memory_pin.execute({ id: body.id, pinned: true }, exec);
  if (action === 'unpin') return await toolImpl.memory_pin.execute({ id: body.id, pinned: false }, exec);
  if (action === 'forget') return await toolImpl.memory_forget.execute({ id: body.id }, exec);
  if (action === 'profile') return await toolImpl.memory_profile_save.execute({ content: body.content }, exec);
  if (action === 'save') return await toolImpl.memory_save.execute(body, exec);
  if (action === 'search') return await toolImpl.memory_search.execute({ query: body.query, includeArchived: true }, exec);
  if (action === 'dream') {
    const r = await toolImpl.memory_dream.execute({ autoSave: body.autoSave === true }, exec);
    return out({ ok: true, cues: r.cues, day: r.day, phases: r.phases, due: (r.dueReview || []).length });
  }
  if (action === 'consolidate') {
    const r = await toolImpl.memory_consolidate.execute({}, exec);
    return out({ ok: true, merged: r.mergedCount, archived: r.archivedCount });
  }
  return { ok: false, message: 'unknown action' };
}
