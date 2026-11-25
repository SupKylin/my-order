import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import {
  db,
  User,
  Store,
  Order,
  OrderItem,
  Purchase,
  PurchaseAfterSale,
  AuditLog,
} from '../src/models.js';
import { migrateOrderLoss } from '../src/migrations/order-loss.js';
import { updateLossMark } from '../src/services/order-loss.js';
import { getItem, listOrders, editItem } from '../src/services/orders.js';
import {
  listPurchaseAfterSales,
  getPurchaseAfterSale,
} from '../src/services/purchase-after-sales.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { drainAudit } from '../src/services/audit.js';

const isolated = /^my_order_loss_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
const users = {},
  sessions = {};
let connection,
  created = false,
  server,
  base,
  serial = 0;
const rejectStatus = (run, status) =>
  assert.rejects(run, (e) => (e.status || e.statusCode) === status);
async function fixture({ owner = 'operations', wfs = false, status = 'open' } = {}) {
  const key = `LOSS-${++serial}`;
  const order = await Order.create({ orderNumber: key });
  const item = await OrderItem.create({
    orderId: order.id,
    shopName: owner,
    walmartSku: key,
    purchaseChannelKey: key,
    orderAmount: '100',
    fulfillmentParty: wfs ? 'WFSFulfilled' : 'SellerFulfilled',
  });
  const purchase = await Purchase.create({
    itemId: item.id,
    purchaseAmount: '50',
    purchaseCost: '40',
    commissionRate: '15',
    settlement: '已结算',
    purchaseDiscount: '0.8',
  });
  const ticket = await PurchaseAfterSale.create({
    itemId: item.id,
    status,
    createdBy: users.admin.id,
    creatorName: 'admin',
    lastActivityAt: new Date(),
    purchaseRefundAmount: '0',
  });
  return { item, purchase, ticket };
}
const entry = (item) => ({ id: item.id, version: item.version });
before(async () => {
  if (!isolated) return;
  config.wecom.webhook = '';
  config.wecom.channelChangeWebhook = '';
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
  const passwordHash = await hashPassword('Loss-test-123');
  for (const role of ['admin', 'supervisor', 'purchasing', 'operations'])
    users[role] = await User.create({ username: role, displayName: role, role, passwordHash });
  await Store.create({
    systemStoreName: 'operations',
    walmartStoreName: 'operations',
    ownerId: users.operations.id,
  });
  await Store.create({ systemStoreName: 'other', walmartStoreName: 'other' });
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const role of Object.keys(users)) {
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: role, password: 'Loss-test-123' }),
    });
    assert.equal(response.status, 200);
    sessions[role] = {
      Cookie: response.headers.get('set-cookie').split(';')[0],
      'X-CSRF-Token': (await response.json()).csrfToken,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
  }
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await drainAudit();
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});

test('旧表增量升级默认未标记，重复迁移保留标记', async () => {
  const { item } = await fixture();
  await db.getQueryInterface().removeColumn('order_items', 'isLoss');
  await migrateOrderLoss();
  assert.equal((await item.reload()).isLoss, false);
  await updateLossMark({ items: [entry(item)], isLoss: true }, users.admin);
  await migrateOrderLoss();
  assert.equal((await item.reload()).isLoss, true);
});
test('四角色接口均可标记和取消，订单/售后列表详情一致，财务及工单不变', async () => {
  for (const role of Object.keys(users)) {
    const { item, purchase, ticket } = await fixture({ status: 'completed' });
    const moneyBefore = (await getItem(item.id, users[role])).orderProfit;
    const purchaseBefore = (await purchase.reload()).toJSON(),
      ticketBefore = (await ticket.reload()).toJSON();
    for (const isLoss of [true, false]) {
      const response = await fetch(base + '/orders/batch-loss-mark', {
        method: 'POST',
        headers: sessions[role],
        body: JSON.stringify({ items: [entry(await item.reload())], isLoss }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).updated, 1);
      const order = await getItem(item.id, users[role]);
      assert.equal(order.isLoss, isLoss);
      assert.equal(order.orderProfit, moneyBefore);
      const orders = await listOrders({ q: item.walmartSku }, users[role]);
      assert.equal(orders.rows[0].isLoss, isLoss);
      const tickets = await listPurchaseAfterSales({ q: item.walmartSku }, users[role]);
      assert.equal(tickets.rows[0].item.isLoss, isLoss);
      assert.equal(tickets.rows[0].item.version, order.version);
      assert.equal((await getPurchaseAfterSale(ticket.id, {}, users[role])).item.isLoss, isLoss);
    }
    assert.deepEqual((await purchase.reload()).toJSON(), purchaseBefore);
    assert.deepEqual((await ticket.reload()).toJSON(), ticketBefore);
  }
});
test('跨页21条批量更新和撤销，无工单也可标记，记录审计', async () => {
  const items = [];
  for (let n = 0; n < 21; n++) items.push((await fixture()).item);
  await PurchaseAfterSale.destroy({ where: { itemId: items[0].id } });
  const result = await updateLossMark({ items: items.map(entry), isLoss: true }, users.operations);
  assert.equal(result.updated, 21);
  for (const row of result.rows)
    assert.equal((await getItem(row.id, users.operations)).isLoss, true);
  const audit = await AuditLog.findOne({
    where: { action: 'mark_order_loss' },
    order: [['id', 'DESC']],
  });
  assert.equal(audit.details.changes.length, 21);
  const again = await updateLossMark(
    { items: result.rows.map(entry), isLoss: true },
    users.operations,
  );
  assert.equal(again.updated, 0);
  assert.deepEqual(again.rows, result.rows);
  const cleared = await updateLossMark(
    { items: result.rows.map(entry), isLoss: false },
    users.operations,
  );
  assert.equal(cleared.updated, 21);
});
test('越权、WFS、版本冲突和缺失行均整批回滚', async () => {
  for (const kind of ['scope', 'wfs', 'conflict', 'missing']) {
    const first = (await fixture()).item;
    const second = (
      await fixture({ owner: kind === 'scope' ? 'other' : 'operations', wfs: kind === 'wfs' })
    ).item;
    const secondEntry = entry(second);
    if (kind === 'conflict') await second.update({ version: second.version + 1 });
    if (kind === 'missing') secondEntry.id = 99999999;
    const beforeAudit = await AuditLog.count({ where: { action: 'mark_order_loss' } });
    await rejectStatus(
      () => updateLossMark({ items: [entry(first), secondEntry], isLoss: true }, users.operations),
      { scope: 403, wfs: 403, conflict: 409, missing: 404 }[kind],
    );
    assert.equal((await first.reload()).isLoss, false);
    assert.equal(first.version, 1);
    assert.equal(await AuditLog.count({ where: { action: 'mark_order_loss' } }), beforeAudit);
  }
});
test('并发相同版本只有一次提交成功', async () => {
  const { item } = await fixture();
  const input = { items: [entry(item)], isLoss: true };
  const results = await Promise.allSettled([
    updateLossMark(input, users.admin),
    updateLossMark(input, users.purchasing),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await item.reload()).version, 2);
});
test('参数严格校验，不能通过通用编辑绕过专用接口', async () => {
  const { item } = await fixture();
  for (const input of [
    { items: [], isLoss: true },
    { items: Array(501).fill(entry(item)), isLoss: true },
    { items: [entry(item), entry(item)], isLoss: true },
    { items: [entry(item)], isLoss: 'true' },
    { items: [{ id: item.id }], isLoss: true },
  ])
    await rejectStatus(() => updateLossMark(input, users.admin), 400);
  await rejectStatus(
    () => updateLossMark({ items: [entry(item)], isLoss: true }, { role: 'invalid' }),
    403,
  );
  await assert.rejects(() =>
    editItem(item.id, { version: item.version, fields: { isLoss: true } }, users.admin),
  );
  assert.equal((await item.reload()).isLoss, false);
  const unauthenticated = await fetch(base + '/orders/batch-loss-mark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ items: [entry(item)], isLoss: true }),
  });
  assert.equal(unauthenticated.status, 401);
});
