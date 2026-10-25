import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------- 配置

export const DEFAULTS = {
  debug: false,          // 调试日志（写 <dir>/debug.log）
  dir: path.join(os.homedir(), '.dsh', 'memory-fish'),
  budgetTokens: 600,       // L0 + L1 硬预算
  profileTokens: 200,      // L0 预算
  maxHotLines: 12,         // L1 最多行数（人脑工作记忆 4±1，取 8-12）
  archiveAfterDays: 60,    // 衰减归档阈值（天，低 salience 才适用）
  dedupeThreshold: 0.75,   // 写入去重相似度（>= 更新）
  noopThreshold: 0.92,     // 新颖性门控：>= 视为完全重复，不写只记一次检索
  salienceBase: 3,         // 显著性基础分
  reviewEnabled: true,     // 复习调度（SM-2 简化版）
  autoCapture: true,       // 自动捕获：把对话写进 journal（L3 原始层，永不注入）
  captureMaxChars: 4000,   // 单条消息最多记录字符数
  skipSubagentSessions: true,
  journalKeepDays: 30,     // journal 保留天数
  dreamDays: 2,            // 做梦默认回顾最近几天的 journal
  dreamAutoSave: false,    // 做梦时是否自动落库（默认只给候选）
  dreamReminder: true,     // C1：到点后在注入块里提醒做梦（不依赖宿主调度器）
  dreamAfterHours: 24,     // 距上次做梦超过多少小时算"欠一次"
  mentalModel: true,       // v0.8：L0 画像自动重写（mental model，由 subagent 执行）
  mentalModelEveryDays: 7, // 距上次画像重写超过 N 天算到期
  panelPath: '/memory-fish/panel',
  apiBase: '/memory-fish/api',
};

/** 运行期合并用户配置；只接受已知字段。 */
export function resolveConfig(input = {}) {
  const base = { ...DEFAULTS };
  const out = { ...base };
  if (input && typeof input === 'object') {
    for (const key of Object.keys(base)) {
      if (input[key] !== undefined) out[key] = input[key];
    }
  }
  // 数值字段兜底，避免用户填字符串把预算算崩
  for (const key of ['budgetTokens', 'profileTokens', 'maxHotLines', 'archiveAfterDays', 'dedupeThreshold', 'noopThreshold', 'captureMaxChars', 'journalKeepDays', 'dreamDays', 'dreamAfterHours', 'mentalModelEveryDays']) {
    const n = Number(out[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}
