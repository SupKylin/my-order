import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { walmartImage } from '../product-image.js';

const maxImageBytes = 5 * 1024 * 1024;

/** 单次下载有大小和超时上限，只允许官方地址且不跟随重定向。 */
export async function downloadThumbnail(url) {
  // 先检查原生依赖，避免依赖缺失时仍下载整张原图。
  const { default: sharp } = await import('sharp');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok || Number(response.headers.get('content-length')) > maxImageBytes) {
    await response.body?.cancel();
    throw new Error('商品图片下载失败');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxImageBytes) throw new Error('商品图片过大');
    chunks.push(chunk);
  }
  return sharp(Buffer.concat(chunks), { limitInputPixels: 40000000, failOn: 'error' })
    .rotate()
    .resize(96, 96, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
}

/** 持久化缩略图；所有导出和后台预热共享并发限额及同地址的在途请求。 */
export function createThumbnailCache({
  directory = path.join(config.storage, 'cache', 'product-thumbnails-v1'),
  download = downloadThumbnail,
  concurrency = 6,
  ttl = 7 * 24 * 60 * 60 * 1000,
  failureTtl = 5 * 60 * 1000,
  now = Date.now,
} = {}) {
  const pending = new Map();
  const failures = new Map();
  const queue = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length) {
      const task = queue.shift();
      active += 1;
      task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };
  const schedule = (run) =>
    new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      drain();
    });
  async function load(url) {
    const filename = path.join(directory, createHash('sha256').update(url).digest('hex') + '.png');
    try {
      const stat = await fs.stat(filename);
      if (now() - stat.mtimeMs < ttl) return await fs.readFile(filename);
    } catch {
      /* 首次导出或文件已被清理时重新生成。 */
    }
    if ((failures.get(url) || 0) > now()) return null;
    return schedule(async () => {
      try {
        const buffer = await download(url);
        await fs.mkdir(directory, { recursive: true });
        const temporary = filename + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(temporary, buffer);
          await fs.rename(temporary, filename);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        failures.delete(url);
        return buffer;
      } catch {
        // 短期失败不反复下载，且限制失败地址集合，避免长期运行无限增长。
        for (const [key, expiry] of failures) if (expiry <= now()) failures.delete(key);
        if (failures.size >= 5000) failures.delete(failures.keys().next().value);
        failures.set(url, now() + failureTtl);
        return null;
      }
    });
  }
  return {
    get(value) {
      const url = walmartImage(value);
      if (!url) return Promise.resolve(null);
      if (!pending.has(url))
        pending.set(
          url,
          load(url).finally(() => pending.delete(url)),
        );
      return pending.get(url);
    },
  };
}

export const thumbnailCache = createThumbnailCache();

/** 连续补位的任务池，不等待同批最慢请求；内存中只保留有限工作任务。 */
export async function thumbnailWorkers(values, task, concurrency = 6) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) await task(values[next++]);
    }),
  );
}
