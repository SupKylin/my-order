import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import express from 'express';
import { config } from '../src/config.js';
import {
  db,
  User,
  Store,
  Order,
  OrderItem,
  Purchase,
  DictionaryOption,
  AuditLog,
} from '../src/models.js';
import {
  getItem,
  listOrders,
  updatePurchaseStatus,
  updateOrderStatus,
} from '../src/services/orders.js';
import { exportOrders } from '../src/services/order-export.js';
import { installAuditHooks } from '../src/services/audit.js';
import { auditContext } from '../src/lib/audit-context.js';
import { createOrdersRouter } from '../src/routes/orders.js';
import { authorizeApi } from '../src/permissions.js';
import { errorHandler } from '../src/middleware/error-handler.js';

// 仅在一次性测试库中验证批量事务，绝不写入本地或线上业务库。
const isolated = /^my_order_batch_status_test_\d+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection,
  created = false,
  actor,
  operator,
  server;
let sequence = 0;
const success = '采购成功（未出跟踪号）';
const tracked = '采购成功（已出跟踪号）';
const cancelled = '采购成功（砍单）';
const previousTime = new Date('2026-10-01T03:00:00Z');
const entries = (rows) => rows.map(({ id, version }) => ({ id, version }));
async function makeItem(purchase = {}, item = {}) {
  const index = ++sequence;
  const order = await Order.create({ orderNumber: `BATCH-${index}` });
  const row = await OrderItem.create({
    orderId: order.id,
    shopName: 'OWN',
    walmartSku: `SKU-${index}`,
    purchaseChannelKey: 'test',
    quantity: 1,
    ...item,
  });
  await Purchase.create({
    itemId: row.id,
    purchaseNote: '原备注',
    purchaseQuantity: 3,
    ...purchase,
  });
  return getItem(row.id);
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
  installAuditHooks();
  actor = await User.create({
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    passwordHash: 'test',
  });
  operator = await User.create({
    username: 'operator',
    displayName: '运营',
    role: 'operations',
    passwordHash: 'test',
  });
  await Store.create({
    systemStoreName: 'OWN',
    walmartStoreName: 'OWN',
    ownerId: operator.id,
    clientId: 'test',
    clientSecret: 'test',
  });
  await Store.create({
    systemStoreName: 'OTHER',
    walmartStoreName: 'OTHER',
    ownerId: actor.id,
    clientId: 'test',
    clientSecret: 'test',
  });
  await DictionaryOption.bulkCreate([
    ...[success, tracked, cancelled, '采购中', '采购失败', '取消订单'].map((value) => ({
      kind: 'purchaseStatus',
      value,
    })),
    { kind: 'purchaseStatus', value: '停用状态', active: false },
    { kind: 'orderStatus', value: '已发货' },
  ]);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});

test('批量采购状态正确记录、保留、清空成功时间，保留其他采购字段并记录变更', async () => {
  const originals = [null, '采购中', '采购失败', '取消订单', cancelled, success, tracked];
  const rows = [];
  for (const purchaseStatus of originals)
    rows.push(
      await makeItem({
        purchaseStatus,
        purchaseConfirmedAt: [success, tracked].includes(purchaseStatus) ? previousTime : null,
      }),
    );
  const start = Date.now();
  const result = await auditContext.run(
    {
      actor: { id: actor.id },
      id: 'batch-test',
      method: 'POST',
      path: '/orders/batch-purchase-status',
    },
    () => updatePurchaseStatus({ items: entries(rows), purchaseStatus: success }, actor),
  );
  assert.equal(result.updated, rows.length);
  const updated = [];
  for (const [index, row] of rows.entries()) {
    const saved = await getItem(row.id);
    updated.push(saved);
    assert.equal(saved.purchaseStatus, success);
    assert.equal(saved.version, row.version + 1);
    assert.equal(saved.purchaseNote, '原备注');
    assert.equal(saved.purchaseQuantity, 3);
    if (index < 5) assert.ok(new Date(saved.purchaseConfirmedAt).getTime() >= start - 1000);
    else assert.equal(new Date(saved.purchaseConfirmedAt).getTime(), previousTime.getTime());
  }
  assert.equal(await AuditLog.count({ where: { action: 'batch_update_purchase_status' } }), 1);
  const fieldLogs = await AuditLog.findAll({ where: { action: 'update_record' } });
  assert.ok(fieldLogs.some((log) => log.details?.changes?.purchaseStatus?.after === success));
  await updatePurchaseStatus({ items: entries(updated), purchaseStatus: tracked }, actor);
  for (const row of updated) {
    const saved = await getItem(row.id);
    assert.equal(
      new Date(saved.purchaseConfirmedAt).getTime(),
      new Date(row.purchaseConfirmedAt).getTime(),
    );
    await updatePurchaseStatus({ items: entries([saved]), purchaseStatus: cancelled }, actor);
    assert.equal((await getItem(row.id)).purchaseConfirmedAt, null);
  }
});

test('非法或停用状态、无权限、WFS、版本冲突及不存在的记录全部回滚', async () => {
  const first = await makeItem({ purchaseStatus: '采购中' });
  const other = await makeItem({}, { shopName: 'OTHER' });
  const wfs = await makeItem({}, { fulfillmentParty: 'WFSFulfilled' });
  const logCount = await AuditLog.count();
  const cases = [
    [{ items: entries([first, other]), purchaseStatus: success }, operator],
    [{ items: entries([first, wfs]), purchaseStatus: success }, actor],
    [{ items: entries([first, { ...other, version: 0 }]), purchaseStatus: success }, actor],
    [{ items: [...entries([first]), { id: 999999, version: 1 }], purchaseStatus: success }, actor],
    ...['停用状态', '不存在', '', null].map((purchaseStatus) => [
      { items: entries([first]), purchaseStatus },
      actor,
    ]),
    [{ items: entries([first, first]), purchaseStatus: success }, actor],
    [{ items: [], purchaseStatus: success }, actor],
    [{ items: Array(501).fill(entries([first])[0]), purchaseStatus: success }, actor],
  ];
  for (const [input, user] of cases) {
    await assert.rejects(updatePurchaseStatus(input, user));
    const saved = await getItem(first.id);
    assert.equal(saved.purchaseStatus, '采购中');
    assert.equal(saved.version, first.version);
    assert.equal(saved.purchaseConfirmedAt, null);
    assert.equal(await AuditLog.count(), logCount);
  }
  await updatePurchaseStatus({ items: entries([first]), purchaseStatus: success }, operator);
  await updatePurchaseStatus(
    { items: entries([other]), purchaseStatus: success },
    { id: actor.id, role: 'purchasing' },
  );
});

test('运营状态原有批量接口不修改采购状态，新采购接口可正常提交', async () => {
  const row = await makeItem({ purchaseStatus: success, purchaseConfirmedAt: previousTime });
  await updateOrderStatus({ items: entries([row]), orderStatus: '已发货' }, actor);
  const saved = await getItem(row.id);
  assert.equal(saved.orderStatus, '已发货');
  assert.equal(saved.purchaseStatus, success);
  assert.equal(new Date(saved.purchaseConfirmedAt).getTime(), previousTime.getTime());
  const app = express();
  app.use(
    express.json(),
    (req, res, next) => {
      req.user = operator;
      next();
    },
    authorizeApi,
    createOrdersRouter(),
    errorHandler,
  );
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/orders/batch-purchase-status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: entries([saved]), purchaseStatus: '采购失败' }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { updated: 1 });
  assert.equal((await getItem(row.id)).purchaseStatus, '采购失败');
});

test('多渠道与未分配取并集，兼容旧值，并与其他筛选、权限和两类导出一致', async () => {
  const raws = [
    '渠道甲',
    '["渠道乙","渠道甲"]',
    '["渠道乙"]',
    '["渠道丙"]',
    null,
    '',
    '[]',
    'null',
    '""',
    '["未分配"]',
    '["渠道甲长名"]',
  ];
  const rows = [];
  for (const raw of raws) {
    const row = await makeItem({ purchaseStatus: '采购中' }, { productName: 'CHANNEL-FIXTURE' });
    await db.query('UPDATE purchases SET purchaseChannel = ? WHERE itemId = ?', {
      replacements: [raw, row.id],
    });
    rows.push(row);
  }
  await makeItem(
    { purchaseChannel: ['渠道甲'], purchaseStatus: '采购中' },
    { shopName: 'OTHER', productName: 'CHANNEL-FIXTURE' },
  );
  await makeItem(
    { purchaseChannel: ['渠道甲'], purchaseStatus: '采购失败' },
    { productName: 'CHANNEL-FIXTURE' },
  );
  const filter = {
    q: 'CHANNEL-FIXTURE',
    purchaseStatus: ['采购中'],
    purchaseChannel: ['渠道甲', '渠道乙'],
    purchaseChannelEmpty: true,
    pageSize: 2,
  };
  const expected = rows
    .filter((_, i) => [0, 1, 2, 4, 5, 6, 7, 8].includes(i))
    .map((row) => row.orderNumber)
    .sort();
  const result = await listOrders(filter, operator);
  assert.equal(result.total, expected.length);
  assert.equal(result.rows.length, 2);
  assert.equal(
    (
      await listOrders(
        {
          ...filter,
          purchaseChannel: JSON.stringify(filter.purchaseChannel),
          purchaseChannelEmpty: 'true',
        },
        operator,
      )
    ).total,
    expected.length,
  );
  assert.equal(
    (
      await listOrders(
        { ...filter, purchaseChannel: '渠道甲', purchaseChannelEmpty: false },
        operator,
      )
    ).total,
    2,
  );
  assert.equal(
    (
      await listOrders(
        { ...filter, purchaseChannel: ['未分配'], purchaseChannelEmpty: false },
        operator,
      )
    ).total,
    1,
  );
  assert.equal(
    (await listOrders({ ...filter, purchaseChannel: [], purchaseChannelEmpty: false }, operator))
      .total,
    raws.length,
  );
  for (const purchaseTemplate of [true, false]) {
    const chunks = [];
    const stream = new Writable({
      write(chunk, encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    stream.setHeader = () => {};
    await exportOrders({ filters: filter }, stream, purchaseTemplate, { user: operator });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks));
    const sheet = workbook.worksheets[0];
    const numbers = [];
    sheet.eachRow((row, index) => {
      if (index > 1) numbers.push(row.getCell(2).text);
    });
    assert.deepEqual(numbers.sort(), expected);
  }
});
