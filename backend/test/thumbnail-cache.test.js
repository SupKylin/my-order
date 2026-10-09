import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createThumbnailCache, thumbnailWorkers } from '../src/lib/excel/thumbnail-cache.js';
import { beginExport, exportProgress } from '../src/services/export-progress.js';

test('并发请求和新缓存实例复用同一文件，地址变化重新下载，失败短期不重试', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0,
    time = Date.now();
  const download = async (url) => {
    calls++;
    if (url.endsWith('bad')) throw Error('failed');
    return Buffer.from('image');
  };
  const options = { directory, download, now: () => time, failureTtl: 100 };
  const cache = createThumbnailCache(options);
  const url = 'https://i5.walmartimages.com/good';
  await Promise.all(Array.from({ length: 8 }, () => cache.get(url)));
  assert.equal(calls, 1);
  assert.equal((await createThumbnailCache(options).get(url)).toString(), 'image');
  assert.equal(calls, 1);
  await cache.get(url + '2');
  assert.equal(calls, 2);
  const bad = 'https://i5.walmartimages.com/bad';
  assert.equal(await cache.get(bad), null);
  await cache.get(bad);
  assert.equal(calls, 3);
  time += 101;
  await cache.get(bad);
  assert.equal(calls, 4);
  await cache.get('https://example.com/private');
  assert.equal(calls, 4);
});

test('共享限额且慢请求不阻塞空闲位置，图片过期重新生成', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let releaseSlow, nextStarted;
  const slow = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const started = new Promise((resolve) => {
    nextStarted = resolve;
  });
  let active = 0,
    peak = 0,
    calls = 0;
  const cache = createThumbnailCache({
    directory,
    concurrency: 2,
    ttl: 0,
    download: async (url) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (url.endsWith('/0')) await slow;
      if (url.endsWith('/2')) nextStarted();
      active--;
      return Buffer.from('image');
    },
  });
  const urls = Array.from({ length: 5 }, (_, i) => 'https://i5.walmartimages.com/' + i);
  const work = thumbnailWorkers(urls, (url) => cache.get(url), 2);
  await started;
  assert.equal(active, 1);
  assert.equal(peak, 2);
  releaseSlow();
  await work;
  await cache.get(urls[0]);
  assert.equal(calls, 6);
});

test('导出进度仅本人可读，重复编号不覆盖他人任务', () => {
  const id = 'export-progress-test-001';
  const update = beginExport(id, 1);
  update({ stage: 'images', completedImages: 2, imageCount: 5 });
  assert.equal(exportProgress(id, 1).completedImages, 2);
  assert.deepEqual(exportProgress(id, 2), { stage: 'waiting' });
  assert.throws(() => beginExport(id, 2), /重复/);
  assert.throws(() => beginExport('../bad', 1), /无效/);
  update({ stage: 'done' });
  assert.equal(exportProgress(id, 1).stage, 'done');
});
