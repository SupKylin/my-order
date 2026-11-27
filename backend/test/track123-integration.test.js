import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { once } from 'node:events';
import { config } from '../src/config.js';
import { db, Order, OrderItem, Purchase, Store, User } from '../src/models.js';
import { hashPassword } from '../src/auth.js';
import { createApp } from '../src/app.js';

const isolated = /^my_order_track123_test_\d+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection;
let created = false;
let server;
let base;
let item;
let originalFetch;

async function request(path, method = 'GET', body, session = {}) {
  const response = await originalFetch(base + path, {
    method,
    headers: {
      Origin: 'http://localhost:5173',
      'X-Requested-With': 'XMLHttpRequest',
      ...(session.cookie ? { Cookie: session.cookie } : {}),
      ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

async function login(username) {
  const response = await request('/api/auth/login', 'POST', {
    username,
    password: 'test-password',
  });
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get('set-cookie').split(';')[0],
    csrf: response.data.csrfToken,
  };
}

before(async () => {
  if (!isolated) return;
  connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.username,
    password: config.db.password,
  });
  await connection.query(
    `CREATE DATABASE ${mysql.escapeId(config.db.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  );
  created = true;
  await db.sync();
  const passwordHash = await hashPassword('test-password');
  await User.bulkCreate([
    { username: 'admin', displayName: 'Admin', passwordHash, role: 'admin' },
    { username: 'operations', displayName: 'Operations', passwordHash, role: 'operations' },
  ]);
  const order = await Order.create({ orderNumber: 'TRACK-ORDER' });
  item = await OrderItem.create({
    orderId: order.id,
    shopName: 'Unassigned Store',
    purchaseChannelKey: '',
  });
  await Purchase.create({ itemId: item.id, trackingNumber: 'INTERNAL-123' });
  config.track123.apiSecret = 'test-api-secret';
  originalFetch = globalThis.fetch;
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (originalFetch) globalThis.fetch = originalFetch;
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});

test('现有会话和店铺权限保护注册及查询，单号由服务器读取', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.track123.com/')) return originalFetch(url, options);
    calls.push({
      url,
      body: JSON.parse(options.body),
      secret: options.headers['Track123-Api-Secret'],
    });
    const data = String(url).endsWith('/query')
      ? {
          accepted: {
            content: [
              {
                trackNo: 'INTERNAL-123',
                transitStatus: 'IN_TRANSIT',
                customerEmail: 'private@example.com',
                localLogisticsInfo: { trackingDetails: [{ eventDetail: 'Departed' }] },
              },
            ],
          },
          rejected: [],
        }
      : { accepted: [{ trackNo: 'INTERNAL-123' }], rejected: [] };
    return new Response(JSON.stringify({ code: '00000', data }));
  };
  const path = `/api/orders/${item.id}/tracking`;
  assert.equal((await request(path)).status, 401);
  const operations = await login('operations');
  assert.equal((await request(path, 'GET', null, operations)).status, 403);
  assert.equal((await request(path + '/register', 'POST', {}, operations)).status, 403);
  const admin = await login('admin');
  assert.equal(
    (await request(path + '/register', 'POST', {}, { cookie: admin.cookie })).status,
    403,
  );
  const registration = await request(path + '/register', 'POST', { trackNo: 'FORGED' }, admin);
  assert.equal(registration.status, 200);
  assert.equal(registration.data.accepted, true);
  const tracking = await request(path, 'GET', null, admin);
  assert.equal(tracking.status, 200);
  assert.equal(tracking.data.shipments[0].transitStatus, 'IN_TRANSIT');
  assert.equal(JSON.stringify(tracking.data).includes('private@example.com'), false);
  assert.deepEqual(
    calls.map((call) => call.body),
    [[{ trackNo: 'INTERNAL-123' }], { trackNoInfos: [{ trackNo: 'INTERNAL-123' }] }],
  );
  assert.ok(calls.every((call) => call.secret === 'test-api-secret'));
});

test('物流追踪列表只返回有权访问且填了内部单号的明细', async () => {
  const operationsUser = await User.findOne({ where: { username: 'operations' } });
  await Store.create({
    walmartStoreName: 'Accessible Store',
    systemStoreName: 'Accessible Store',
    ownerId: operationsUser.id,
  });
  const order = await Order.create({ orderNumber: 'VISIBLE-ORDER' });
  const visible = await OrderItem.create({
    orderId: order.id,
    shopName: 'Accessible Store',
    purchaseChannelKey: '',
  });
  await Purchase.create({ itemId: visible.id, trackingNumber: 'VISIBLE-TRACK' });
  const blank = await OrderItem.create({
    orderId: order.id,
    shopName: 'Accessible Store',
    purchaseChannelKey: 'other',
  });
  await Purchase.create({ itemId: blank.id, trackingNumber: '   ' });

  assert.equal((await request('/api/orders/tracking-items')).status, 401);
  const operations = await login('operations');
  const scoped = await request('/api/orders/tracking-items', 'GET', null, operations);
  assert.equal(scoped.status, 200);
  assert.deepEqual(
    scoped.data.rows.map((row) => row.trackingNumber),
    ['VISIBLE-TRACK'],
  );
  const admin = await login('admin');
  const all = await request('/api/orders/tracking-items', 'GET', null, admin);
  assert.equal(all.data.total, 2);
  const searched = await request('/api/orders/tracking-items?q=INTERNAL-123', 'GET', null, admin);
  assert.deepEqual(
    searched.data.rows.map((row) => row.trackingNumber),
    ['INTERNAL-123'],
  );
});

test('MCP 文档接口仅管理员可读且不发送业务数据或密钥', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://docs.track123.com/mcp'))
      return originalFetch(url, options);
    calls.push(JSON.parse(options.body));
    return new Response(
      `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text: '{"/tk/v2.1/track/query":{"post":"Get trackings"}}' }] }, jsonrpc: '2.0', id: 1 })}\n\n`,
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };
  const operations = await login('operations');
  assert.equal(
    (await request('/api/track123-docs/endpoints', 'GET', null, operations)).status,
    403,
  );
  const admin = await login('admin');
  const result = await request('/api/track123-docs/endpoints', 'GET', null, admin);
  assert.equal(result.status, 200);
  assert.equal(result.data[0].path, '/tk/v2.1/track/query');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, 'list-endpoints');
  assert.equal(JSON.stringify(calls).includes('test-api-secret'), false);
});
