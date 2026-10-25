import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 跨进程串行化：用 lock 文件把"读索引 → 改 → 写索引"包起来。
 * 同一时刻只允许一个 DSH 实例改记忆；拿不到锁会在 timeout 后报错，
 * 调用方可以重试（不会永久卡死）。
 */
export async function withLock(dir, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, '.index.lock');
  const start = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await fs.open(lock, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // 锁刚被释放
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('memory-fish: index lock timeout (another DSH instance may be writing)');
      }
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch { /* ignore */ }
    await fs.unlink(lock).catch(() => {});
  }
}
