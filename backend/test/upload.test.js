import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createExcelUpload, EXCEL_MAX_BYTES } from '../src/middleware/upload.js';
import { errorHandler } from '../src/middleware/error-handler.js';

async function fixture(t, maxBytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'order-upload-test-'));
  const app = express();
  app.post('/', createExcelUpload({ directory, maxBytes }), async (req, res) => {
    const size = (await fs.stat(req.file.path)).size;
    const buffered = Boolean(req.file.buffer);
    await fs.rm(req.file.path);
    res.json({ size, buffered });
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, directory };
}

test('Excel uploads accept inclusive limit, reject one byte over, and clean disk files', async (t) => {
  assert.equal(EXCEL_MAX_BYTES, 2147483648);
  const { url, directory } = await fixture(t, 1024);
  for (const size of [1023, 1024, 1025]) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(size)]), 'orders.xlsx');
    const response = await fetch(url, { method: 'POST', body: form });
    const result = await response.json();
    if (size <= 1024) {
      assert.equal(response.status, 200);
      assert.deepEqual(result, { size, buffered: false });
    } else {
      assert.equal(response.status, 400);
      assert.match(result.message, /Excel 上限 2 GB/);
    }
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('Excel upload default accepts files above the former 50 MB cap without a memory buffer', async (t) => {
  const { url } = await fixture(t);
  const size = 50 * 1024 * 1024 + 1;
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(size)]), 'orders.xlsx');
  const response = await fetch(url, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { size, buffered: false });
});

test('aborted Excel upload removes its partial file', async (t) => {
  const { url, directory } = await fixture(t);
  const request = http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=upload-test' },
  });
  request.on('error', () => {});
  request.write(
    '--upload-test\r\nContent-Disposition: form-data; name="file"; filename="orders.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n',
  );
  request.write(Buffer.alloc(64 * 1024));
  for (let i = 0; i < 100 && !(await fs.readdir(directory)).length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await fs.readdir(directory)).length, 1);
  request.destroy();
  for (let i = 0; i < 100 && (await fs.readdir(directory)).length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await fs.readdir(directory), []);
});
