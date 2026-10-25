import fs from 'node:fs';
import path from 'node:path';

/**
 * 极简调试日志：默认关闭（不产生任何 IO），
 * 配置 debug: true 时把结构化日志追加到 <dir>/debug.log（超过 1MB 自动清空）。
 */
let enabled = false;
let file = null;

export function configureLogger({ enabled: on = false, file: target = null } = {}) {
  enabled = Boolean(on);
  file = target || null;
  if (enabled && file) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  }
}

function format(part) {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return part.message;
  try { return JSON.stringify(part); } catch { return String(part); }
}

function write(level, parts) {
  if (!enabled) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: parts.map(format).join(' '),
  });
  try {
    if (!file) return;
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.writeFileSync(file, '');
    fs.appendFileSync(file, line + '\n');
  } catch { /* 日志失败绝不影响主流程 */ }
}

export const log = {
  debug: (...parts) => write('debug', parts),
  info: (...parts) => write('info', parts),
  warn: (...parts) => write('warn', parts),
  error: (...parts) => write('error', parts),
};
