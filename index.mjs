/**
 * dsh-memory-fish — 小肥鱼记忆
 *
 * 上下文成本恒定的本地记忆插件：
 *   L0 画像 (≤200 tok, 常驻) + L1 热索引 (≤400 tok, 常驻)
 *   L2 温记忆 (磁盘, memory_search/read 取) + L3 冷档案 (从不注入)
 *
 * 零依赖、零服务端、零进程。数据全部是 Markdown + JSON。
 */

import path from 'node:path';
import { resolveConfig } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { buildInjection } from './lib/inject.mjs';
import { registerTools } from './lib/tools.mjs';
import { registerPanelRoutes } from './lib/panel.mjs';
import { nowIso, messageText, redactSecrets } from './lib/util.mjs';
import { configureLogger, log } from './lib/log.mjs';

export const name = 'dsh-memory-fish';
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const store = new Store(cfg.dir);
  configureLogger({ enabled: cfg.debug, file: path.join(cfg.dir, 'debug.log') });

  // 启动时初始化（失败不拖垮宿主）
  store.init().catch(() => {});

  // ---- 注入 ----
  try {
    if (ctx.systemPrompt !== undefined) {
      let order = 500;
      try {
        const raw = ctx.systemPrompt.getSectionOrder?.('TOOL_GOAL');
        if (typeof raw === 'number' && Number.isFinite(raw)) order = raw;
      } catch { /* 用默认 */ }
      ctx.systemPrompt.section({
        name: 'dsh-memory-fish:auto',
        order,
        text: () => {
          try {
            return buildInjection(store, cfg).text;
          } catch {
            return '';
          }
        },
      });
    }
  } catch { /* 没有 systemPrompt 服务：工具仍然可用 */ }


  const toolImpl = {};

  // ---- 自动捕获 + v0.9 会话纪元（注入快照失效） ----
  try {
    if (typeof ctx.on === 'function') {
      let lastSessionId = '';
      ctx.on('session/event', (session, event) => {
        try {
          if (!event || typeof event !== 'object') return;
          const isSubagent = session?.header?.origin === 'subagent';
          // v0.9：会话 id 变化且模式为 session 时，让 L1 快照失效（每个会话最多一次）。
          // 子代理会话不参与主会话的刷新纪元，否则会把热索引来回刷新。
          if (!isSubagent) {
            const sid = session?.id !== undefined && session?.id !== null ? String(session.id) : '';
            if (cfg.injectionMode === 'session' && sid && sid !== lastSessionId) {
              lastSessionId = sid;
              store.invalidateInjection('session').catch(() => {});
            }
          }
          if (!cfg.autoCapture) return;
          if (cfg.skipSubagentSessions && isSubagent) return;
          const types = ['user/message', 'assistant/message'];
          if (!types.includes(event.type)) return;
          const message = event.type === 'user/message' ? event.data : event.data?.message;
          if (!message || message.role === 'system') return;
          const kind = message.source?.kind;
          if (event.type === 'user/message' && kind && kind !== 'user') return; // 跳过注入的合成上下文
          if (message.source?.kind === 'tool') return;
          const text = messageText(message).trim();
          if (!text) return;
          const role = event.type === 'assistant/message' ? 'assistant' : 'user';
          store.appendJournal({
            ts: nowIso(),
            session: String(session?.id ?? ''),
            role,
            text: redactSecrets(text).slice(0, cfg.captureMaxChars),
          }).catch(() => {});
          store.stats.captured = (store.stats.captured || 0) + 1;
        } catch { /* 捕获/失效失败绝不影响会话 */ }
      });
    }
  } catch { /* 宿主没有事件总线 */ }

  registerTools(ctx, store, cfg, toolImpl);

  // ---- journal 清理（启动 5 秒后跑一次，不拖慢启动） ----
  setTimeout(() => { store.pruneJournal(cfg.journalKeepDays).catch(() => {}); }, 5000);

  // ---- 可视化面板：宿主的 webServer 路由；没有也不影响工具 ----
  try {
    const injectFn = ctx.inject;
    if (typeof injectFn === 'function') {
      injectFn.call(ctx, ['webServer'], (webCtx) => {
        try {
          registerPanelRoutes(webCtx?.webServer, store, cfg, toolImpl);
        } catch { /* 面板挂了也不影响记忆工具 */ }
      });
    }
  } catch { /* 宿主没有 webServer 服务 */ }
}
