import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import sharp from 'sharp';
import {
  notificationSettings,
  notificationContent,
  notificationParts,
  notificationImage,
  prepareNotificationImage,
  sendWecom,
} from '../src/services/wecom-after-sales.js';

test('通知限定官方Webhook及合法站点，错误不回显密钥', () => {
  const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-test';
  assert.equal(notificationSettings(webhook, 'http://example.test').appUrl, 'http://example.test');
  for (const url of [
    'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
    'https://example.test/send?key=x',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
  ])
    assert.throws(() => notificationSettings(url, 'http://example.test'));
  assert.throws(() => notificationSettings(webhook, 'javascript:alert(1)'));
  assert.throws(() => notificationSettings(webhook, 'http://example.test/path'));
});

test('完整中文及emoji按字节分段，重组不丢内容，多图保持顺序且保留工单链接', () => {
  const text = notificationContent(
    {
      ticketId: 123,
      recordId: 456,
      kind: 'reply',
      shopName: '店'.repeat(191),
      orderNumber: '1'.repeat(191),
      walmartSku: '商品'.repeat(191),
      actorName: '人'.repeat(100),
      content: '售后😀'.repeat(3000),
      imageCount: 20,
      createdAt: '2026-11-05T00:00:00Z',
    },
    'http://example.test',
  );
  const images = [1, 2].map((n) => `/uploads/images/00000000-0000-4000-8000-00000000000${n}.webp`);
  const parts = notificationParts(text, images, 123, 456, 'http://example.test');
  assert(parts.length > 1);
  assert(
    parts.every(
      (p) => p.msgtype === 'markdown_v2' && Buffer.byteLength(p.markdown_v2.content) <= 4096,
    ),
  );
  const joined = parts.map((p) => p.markdown_v2.content.replace(/^【[^\n]+】\n/, '')).join('');
  assert(joined.includes('售后😀'.repeat(3000)));
  assert(!joined.includes('\ufffd'));
  assert.deepEqual(
    parts.flatMap((p) => p.images),
    images,
  );
  assert(joined.includes('[查看工单](http://example.test/purchase-after-sales?ticket=123)'));
  for (const n of [1, 2])
    assert(
      joined.includes(
        `![售后图片${n}](http://example.test/uploads/images/00000000-0000-4000-8000-00000000000${n}.wecom.jpg)`,
      ),
    );
  assert(text.includes('新回复'));
  assert(text.includes('附图：20 张'));
  assert(text.endsWith('http://example.test/purchase-after-sales?ticket=123'));
  assert(!text.includes('\ufffd'));
});

test('WebP转换微信图片，base64与MD5对应原字节，超限压缩且不修改原文件', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'wecom-image-'));
  const name = '00000000-0000-4000-8000-000000000001.webp';
  const file = path.join(storage, 'images', name);
  try {
    await mkdir(path.dirname(file));
    for (const large of [false, true]) {
      const source = large
        ? await sharp(randomBytes(2200 * 2200 * 3), {
            raw: { width: 2200, height: 2200, channels: 3 },
          })
            .webp({ lossless: true })
            .toBuffer()
        : await sharp({ create: { width: 30, height: 30, channels: 4, background: '#0055ff88' } })
            .webp()
            .toBuffer();
      await writeFile(file, source);
      const payload = await notificationImage(`/uploads/images/${name}`, storage);
      const image = Buffer.from(payload.image.base64, 'base64');
      assert.equal(payload.msgtype, 'image');
      assert(image.length <= 2 * 1024 * 1024);
      assert.equal(payload.image.md5, createHash('md5').update(image).digest('hex'));
      assert.equal((await sharp(image).metadata()).format, large ? 'jpeg' : 'png');
      assert.deepEqual(await readFile(file), source);
    }
    await assert.rejects(() => notificationImage('/uploads/images/../../secret', storage));
    await assert.rejects(() => notificationImage('https://example.test/image.webp', storage));
    await rm(file);
    await assert.rejects(() => notificationImage(`/uploads/images/${name}`, storage));
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test('仅errcode零视作成功，HTTP/异常/无效响应保留安全错误码', async () => {
  assert.deepEqual(await sendWecom('test', 'unused', async () => ({ ok: false, status: 502 })), {
    ok: false,
    error: 'HTTP_502',
  });
  assert.deepEqual(
    await sendWecom('test', 'unused', async () => ({ ok: true, json: async () => ({}) })),
    { ok: false, error: 'INVALID_RESPONSE' },
  );
  assert.deepEqual(
    await sendWecom('test', 'unused', async () => {
      throw new Error('secret');
    }),
    { ok: false, error: 'NETWORK_OR_RESPONSE_ERROR' },
  );
});

test('常规内容与20图合并一条，转义用户Markdown', () => {
  const images = Array.from(
    { length: 20 },
    (_, i) => `/uploads/images/00000000-0000-4000-8000-${String(i).padStart(12, '0')}.webp`,
  );
  const parts = notificationParts(
    '内容 **文本** ![伪图](https://bad.test/pic) <@all>\n第二行',
    images,
    1,
    2,
    'http://47.102.186.54',
  );
  assert.equal(parts.length, 1);
  assert.equal(parts[0].images.length, 20);
  const content = parts[0].markdown_v2.content;
  assert(!content.includes('![伪图]'));
  assert(!content.includes('<@all>'));
  assert(Buffer.byteLength(content) <= 4096);
});
test('生成持久化JPEG副本，重复准备复用，不修改原图', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'wecom-combined-'));
  const name = '00000000-0000-4000-8000-000000000001.webp';
  try {
    await mkdir(path.join(storage, 'images'));
    const source = await sharp({
      create: { width: 10, height: 10, channels: 3, background: 'red' },
    })
      .webp()
      .toBuffer();
    const file = path.join(storage, 'images', name);
    await writeFile(file, source);
    const relative = await prepareNotificationImage('/uploads/images/' + name, storage);
    const data = await readFile(path.join(storage, 'images', path.basename(relative)));
    assert.equal((await sharp(data).metadata()).format, 'jpeg');
    assert.equal(await prepareNotificationImage('/uploads/images/' + name, storage), relative);
    assert.deepEqual(await readFile(file), source);
    await assert.rejects(() => prepareNotificationImage('/uploads/images/../../secret', storage));
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test('微信JPEG链接无需登录可加载，响应为图片且字节完整', async () => {
  const { createApp } = await import('../src/app.js');
  const { imageDir } = await import('../src/services/storage.js');
  const name = `${randomUUID()}.wecom.jpg`;
  const file = path.join(imageDir, name);
  const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } })
    .jpeg()
    .toBuffer();
  const server = createApp().listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await mkdir(imageDir, { recursive: true });
    await writeFile(file, buffer);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/uploads/images/${name}`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/jpeg/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer);
  } finally {
    await rm(file, { force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('大量图片和长站点地址只按完整图片语法拆分，空图片仍合并文字', () => {
  const origin =
    'https://' + 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.' + 'c'.repeat(60) + '.test';
  const images = Array.from(
    { length: 20 },
    (_, i) => `/uploads/images/00000000-0000-4000-8000-${String(i).padStart(12, '0')}.webp`,
  );
  const parts = notificationParts('售后内容', images, 1, 2, origin);
  assert(parts.length > 1);
  assert.deepEqual(
    parts.flatMap((p) => p.images),
    images,
  );
  for (const part of parts) {
    assert(Buffer.byteLength(part.markdown_v2.content) <= 4096);
    assert.equal(
      (part.markdown_v2.content.match(/!\[售后图片\d+\]\(https:\/\/[^)]+\)/g) || []).length,
      part.images.length,
    );
  }
  assert.equal(notificationParts('只有文字', [], 1, 2, origin).length, 1);
});
