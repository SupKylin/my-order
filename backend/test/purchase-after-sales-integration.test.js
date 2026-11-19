import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import {
  db,
  User,
  Store,
  Order,
  OrderItem,
  Purchase,
  Upload,
  AuditLog,
  PurchaseAfterSale as Ticket,
  PurchaseAfterSaleRecord as Record,
} from '../src/models.js';
import {
  purchaseAfterSaleOptions,
  createPurchaseAfterSale as create,
  replyPurchaseAfterSale as reply,
  listPurchaseAfterSales as list,
  getPurchaseAfterSale as detail,
  changePurchaseAfterSaleStatus as status,
  markSupplierFeedback,
  savePurchaseRefundAmount as saveRefund,
} from '../src/services/purchase-after-sales.js';
import { migratePurchaseAfterSales } from '../src/migrations/purchase-after-sales.js';
import { getItem, listOrders } from '../src/services/orders.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { drainAudit } from '../src/services/audit.js';
import { exportOrders } from '../src/services/order-export.js';
import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';

const isolated = /^my_order_after_sales_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
const users = {},
  items = {},
  sessions = {};
let connection,
  created = false,
  server,
  base,
  storeA,
  ticketId,
  originalItem,
  originalPurchase;
const message = (content = '售后问题', images = []) => ({
  content,
  images,
  requestId: randomUUID(),
});
const rejects = (run, code) =>
  assert.rejects(run, (error) => error.status === code || error.statusCode === code);

async function refundFixture(name) {
  const order = await Order.create({ orderNumber: `REFUND-${name}` });
  const item = await OrderItem.create({
    orderId: order.id,
    shopName: '售后A',
    walmartSku: name,
    purchaseChannelKey: name,
  });
  await Purchase.create({ itemId: item.id, purchaseAmount: '25.00' });
  const ticket = await create({ itemId: item.id, ...message('采购退款测试') }, users.operator);
  return { item, ticket };
}
before(async () => {
  if (!isolated) return;
  // 本地可配置真实机器人，隔离测试不得继承启用状态。
  config.wecom.webhook = '';
  config.wecom.appUrl = '';
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
  for (const key of [
    'supplierFeedbackAt',
    'supplierFeedbackBy',
    'supplierFeedbackName',
    'purchaseRefundAmount',
  ])
    await db.getQueryInterface().removeColumn('purchase_after_sales', key);
  // 模拟已有旧通知表，增量升级应补列，重复执行安全。
  await db.getQueryInterface().removeColumn('after_sale_notifications', 'parts');
  await db.getQueryInterface().removeColumn('after_sale_notifications', 'nextPart');
  await migratePurchaseAfterSales();
  await migratePurchaseAfterSales();
  const passwordHash = await hashPassword('After-sale-test-123');
  for (const [name, role] of [
    ['admin', 'admin'],
    ['operator', 'operations'],
    ['buyer', 'purchasing'],
    ['other', 'operations'],
  ]) {
    users[name] = await User.create({ username: name, displayName: name, role, passwordHash });
  }
  storeA = await Store.create({
    systemStoreName: '售后A',
    walmartStoreName: 'A',
    ownerId: users.operator.id,
  });
  await Store.create({ systemStoreName: '售后B', walmartStoreName: 'B', ownerId: users.other.id });
  const order = await Order.create({ orderNumber: 'AFTER-SALE-ORDER' });
  for (const [name, shopName, fulfillmentParty] of [
    ['a', '售后A', 'SellerFulfilled'],
    ['a2', '售后A', 'SellerFulfilled'],
    ['b', '售后B', 'SellerFulfilled'],
    ['wfs', '售后A', 'WFSFulfilled'],
  ]) {
    items[name] = await OrderItem.create({
      orderId: order.id,
      shopName,
      walmartSku: name,
      productName: `售后商品${name}`,
      purchaseChannelKey: name,
      fulfillmentParty,
      orderAmount: '10',
    });
    await Purchase.create({
      itemId: items[name].id,
      purchaseStatus: '采购中',
      followupNote: '保留原备注',
    });
  }
  originalItem = (await items.a.reload()).toJSON();
  originalPurchase = (await Purchase.findOne({ where: { itemId: items.a.id } })).toJSON();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const name of Object.keys(users)) {
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: name, password: 'After-sale-test-123' }),
    });
    assert.equal(response.status, 200);
    sessions[name] = {
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
test('运营创建多图工单，幂等重试；原订单和采购数据不变，标记仅在对应明细', async () => {
  const imagePaths = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    await Upload.create({
      id,
      filename: `${id}.webp`,
      kind: 'image',
      uploadedBy: users.operator.id,
    });
    imagePaths.push(`/uploads/images/${id}.webp`);
  }
  const input = { itemId: items.a.id, ...message('需要联系供应商退货', imagePaths) };
  ticketId = (await create(input, users.operator)).id;
  assert.equal((await create(input, users.operator)).id, ticketId);
  assert.equal(await Record.count({ where: { ticketId } }), 1);
  const result = await detail(ticketId, {}, users.buyer);
  assert.deepEqual(result.records[0].images, imagePaths);
  assert.equal(result.records[0].actorName, 'operator');
  assert.deepEqual((await items.a.reload()).toJSON(), originalItem);
  assert.deepEqual(
    (await Purchase.findOne({ where: { itemId: items.a.id } })).toJSON(),
    originalPurchase,
  );
  assert.equal((await getItem(items.a.id, users.admin)).purchaseAfterSale.id, ticketId);
  assert.equal((await getItem(items.a.id, users.admin)).afterSales, '是');
  assert.equal((await getItem(items.a2.id, users.admin)).purchaseAfterSale, null);
  assert.equal((await getItem(items.a2.id, users.admin)).afterSales, '否');
  const orders = await listOrders({ page: 1, pageSize: 20 }, users.operator);
  assert.equal(orders.total, 3);
  assert(orders.rows.some((row) => row.purchaseAfterSale?.id === ticketId));
  assert.equal((await listOrders({ purchaseStatus: ['采购中'] }, users.operator)).total, 3);
});
test('不同账号并发创建同一商品只产生一个工单，同订单不同商品可独立创建', async () => {
  const results = await Promise.allSettled([
    create({ itemId: items.a2.id, ...message('甲') }, users.operator),
    create({ itemId: items.a2.id, ...message('乙') }, users.buyer),
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(await Ticket.count({ where: { itemId: items.a2.id } }), 1);
  assert.equal(await Ticket.count({ where: { itemId: [items.a.id, items.a2.id] } }), 2);
});
test('后端强制店铺权限及WFS只读；列表、详情、回复和状态均不能越权', async () => {
  await rejects(() => create({ itemId: items.b.id, ...message() }, users.operator), 403);
  await rejects(() => create({ itemId: items.wfs.id, ...message() }, users.admin), 403);
  await rejects(() => detail(ticketId, {}, users.other), 403);
  await rejects(() => reply(ticketId, message(), users.other), 403);
  await rejects(() => status(ticketId, { status: 'completed', version: 1 }, users.other), 403);
  assert.equal((await list({}, users.other)).total, 0);
  assert.equal((await list({}, users.buyer)).total, 2);
  assert.equal((await list({ q: 'AFTER-SALE-ORDER' }, users.operator)).total, 2);
  assert.equal((await list({ q: '不存在' }, users.operator)).total, 0);
});
test('校验空内容、超长内容、图片归属和数量；失败不留下空工单', async () => {
  const otherImage = randomUUID();
  await Upload.create({
    id: otherImage,
    filename: `${otherImage}.webp`,
    kind: 'image',
    uploadedBy: users.other.id,
  });
  for (const data of [
    message('   '),
    message('x'.repeat(12001)),
    message('x', ['https://example.com/a.png']),
    message('x', [`/uploads/images/${otherImage}.webp`]),
    message('x', Array(21).fill('/uploads/images/x.webp')),
  ]) {
    await rejects(() => create({ itemId: items.b.id, ...data }, users.admin), 400);
  }
  assert.equal(await Ticket.count({ where: { itemId: items.b.id } }), 0);
});
test('采购回复、并发消息均保留；重复提交不增加记录，不能用同标识替换内容', async () => {
  const input = message('已联系供应商，等待处理');
  const first = await reply(ticketId, input, users.buyer);
  const second = await reply(ticketId, input, users.buyer);
  assert.equal(first.id, second.id);
  await rejects(() => reply(ticketId, { ...input, content: '覆盖旧记录' }, users.buyer), 409);
  await Promise.all([
    reply(ticketId, message('运营补充'), users.operator),
    reply(ticketId, message('采购补充'), users.buyer),
  ]);
  const data = await detail(ticketId, {}, users.operator);
  assert.equal(data.records.length, 4);
  assert.deepEqual(
    data.records.slice(0, 2).map((r) => r.content),
    ['需要联系供应商退货', '已联系供应商，等待处理'],
  );
  assert.deepEqual(
    data.records
      .slice(2)
      .map((r) => r.content)
      .sort(),
    ['运营补充', '采购补充'].sort(),
  );
  assert.equal(data.version, 4);
});
test('结束时保护并发新消息，结束不可回复；有权限运营可重开，全程保留事件和原记录', async () => {
  await rejects(() => status(ticketId, { status: 'completed', version: 1 }, users.admin), 409);
  let data = await detail(ticketId, {}, users.operator);
  await Ticket.update({ purchaseRefundAmount: '0.00' }, { where: { id: ticketId } });
  await status(ticketId, { status: 'completed', version: data.version }, users.buyer);
  await rejects(() => reply(ticketId, message('不应写入'), users.operator), 409);
  data = await detail(ticketId, {}, users.operator);
  assert.equal(data.status, 'completed');
  assert.equal((await getItem(items.a.id, users.admin)).afterSales, '是');
  assert(data.completedAt);
  assert.equal(data.records.at(-1).kind, 'completed');
  assert.equal((await list({ status: 'completed' }, users.operator)).total, 1);
  await status(ticketId, { status: 'open', version: data.version }, users.operator);
  data = await detail(ticketId, {}, users.operator);
  assert.equal(data.completedAt, null);
  assert.equal((await getItem(items.a.id, users.admin)).afterSales, '是');
  assert.equal(data.records.at(-1).kind, 'reopened');
  await reply(ticketId, message('重新沟通'), users.operator);
  assert.equal((await detail(ticketId, {}, users.buyer)).records.length, 7);
});
test('记录按ID时间序分页，读取不写审计；账号改名不改变历史发送人，归属变更及时限制访问', async () => {
  await Record.bulkCreate(
    Array.from({ length: 55 }, (_, i) => ({
      ticketId,
      requestId: randomUUID(),
      kind: 'message',
      actorId: users.buyer.id,
      actorName: 'buyer',
      actorRole: 'purchasing',
      content: `历史记录${i}`,
      images: [],
    })),
  );
  const auditCount = await AuditLog.count({ where: { action: 'purchase_after_sale' } });
  const newest = await detail(ticketId, {}, users.operator);
  assert.equal(newest.records.length, 50);
  assert.deepEqual(await detail(ticketId, { knownVersion: newest.version }, users.operator), {
    unchanged: true,
  });
  assert.equal(newest.hasMore, true);
  const oldest = await detail(ticketId, { before: newest.before }, users.operator);
  assert.equal(oldest.records.length, 12);
  assert.equal(oldest.hasMore, false);
  assert(oldest.records.at(-1).id < newest.records[0].id);
  assert.equal(await AuditLog.count({ where: { action: 'purchase_after_sale' } }), auditCount);
  await users.operator.update({ displayName: '新姓名' });
  assert.equal(oldest.records[0].actorName, 'operator');
  await storeA.update({ ownerId: users.other.id });
  assert.equal((await list({}, users.operator)).total, 0);
  await rejects(() => detail(ticketId, {}, users.operator), 403);
  await rejects(() => detail(ticketId, { knownVersion: newest.version }, users.operator), 403);
  assert.equal((await list({}, users.other)).total, 2);
  await storeA.update({ ownerId: users.operator.id });
});
test('HTTP菜单权限、CSRF、生效标记和不可修改/删除API', async () => {
  for (const name of ['admin', 'operator', 'buyer']) {
    const response = await fetch(base + '/purchase-after-sales', { headers: sessions[name] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 2);
  }
  assert.equal((await fetch(base + '/purchase-after-sales')).status, 401);
  const bad = await fetch(base + '/purchase-after-sales', {
    method: 'POST',
    headers: { ...sessions.operator, 'X-CSRF-Token': 'invalid' },
    body: JSON.stringify({ itemId: items.b.id, ...message() }),
  });
  assert.equal(bad.status, 403);
  const record = await Record.findOne({ where: { ticketId }, order: [['id', 'ASC']] });
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    for (const suffix of [`/${ticketId}`, `/${ticketId}/records/${record.id}`]) {
      const response = await fetch(base + '/purchase-after-sales' + suffix, {
        method,
        headers: sessions.admin,
        body: JSON.stringify({ content: '篡改' }),
      });
      assert.equal(response.status, 404);
    }
  }
  assert.equal((await record.reload()).content, '需要联系供应商退货');
  const response = await fetch(base + `/purchase-after-sales/${ticketId}/records`, {
    method: 'POST',
    headers: sessions.buyer,
    body: JSON.stringify(message('API采购回复')),
  });
  assert.equal(response.status, 201);
});
test('同一消息同时重试只保存一次，订单变成WFS后已有工单只读', async () => {
  const input = message('网络重试同一条消息');
  const result = await Promise.all([
    reply(ticketId, input, users.buyer),
    reply(ticketId, input, users.buyer),
  ]);
  assert.equal(result[0].id, result[1].id);
  assert.equal(await Record.count({ where: { ticketId, requestId: input.requestId } }), 1);
  await items.a.update({ fulfillmentParty: 'WFS' });
  const data = await detail(ticketId, {}, users.operator);
  assert.equal(data.item.manualEditable, false);
  await rejects(() => reply(ticketId, message(), users.operator), 403);
  await rejects(
    () => status(ticketId, { status: 'completed', version: data.version }, users.buyer),
    403,
  );
  await items.a.update({ fulfillmentParty: 'SellerFulfilled' });
});
test('店铺多选、所属账号与创建日期按北京日边界取交集，处理中数量独立于状态筛选', async () => {
  const b = await create({ itemId: items.b.id, ...message('其他店铺工单') }, users.other);
  const second = await Ticket.findOne({ where: { itemId: items.a2.id } });
  await Ticket.update(
    { createdAt: new Date('2026-11-04T16:00:00Z'), status: 'open' },
    { where: { id: ticketId }, silent: true },
  );
  await Ticket.update(
    { createdAt: new Date('2026-11-05T15:59:59Z'), status: 'completed' },
    { where: { id: second.id }, silent: true },
  );
  await Ticket.update(
    { createdAt: new Date('2026-11-05T16:00:00Z'), status: 'open' },
    { where: { id: b.id }, silent: true },
  );
  const period = { startDate: '2026-11-05', endDate: '2026-11-05' };
  let result = await list(
    { ...period, shopNames: JSON.stringify(['售后A', '售后B']) },
    users.admin,
  );
  assert.equal(result.total, 2);
  assert.equal(result.openCount, 1);
  result = await list({ ...period, status: 'completed' }, users.admin);
  assert.equal(result.total, 1);
  assert.equal(result.openCount, 1);
  result = await list({ ...period, status: 'open' }, users.admin);
  assert.equal(result.total, 1);
  assert.equal(result.openCount, 1);
  result = await list({ shopNames: ['售后A'], ownerId: users.other.id }, users.admin);
  assert.equal(result.total, 0);
  assert.equal(result.openCount, 0);
  result = await list({ ownerId: users.operator.id }, users.admin);
  assert.equal(result.total, 2);
  assert.equal(result.openCount, 1);
  result = await list({ ownerId: users.other.id }, users.operator);
  assert.equal(result.total, 0);
  assert.equal(result.openCount, 0);
  result = await list({ shopNames: ['售后B'] }, users.operator);
  assert.equal(result.total, 0);
  assert.equal(result.openCount, 0);
  result = await list({ ...period, q: '不存在' }, users.admin);
  assert.equal(result.openCount, 0);
  assert.equal(
    (await list({ startDate: '2026-11-06', endDate: '2026-11-06' }, users.other)).total,
    1,
  );
  for (const query of [
    { startDate: '2026-02-30' },
    { endDate: 'invalid' },
    { startDate: '2026-11-06', endDate: '2026-11-05' },
    { ownerId: 'x' },
    { shopNames: '[oops' },
  ])
    await rejects(() => list(query, users.admin), 400);
  const options = await purchaseAfterSaleOptions(users.operator);
  assert.deepEqual(
    options.stores.map((s) => s.name),
    ['售后A'],
  );
  assert.equal(options.stores[0].ownerId, users.operator.id);
  assert(!JSON.stringify(options).includes('passwordHash'));
  assert(!JSON.stringify(options).includes('clientSecret'));
  const response = await fetch(base + '/purchase-after-sales/options', {
    headers: sessions.operator,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stores.length, 1);
});
test('处理中汇总跨分页；完毕与重新打开后立即变化，店铺归属权限同时影响数量', async () => {
  const order = await Order.create({ orderNumber: 'SUMMARY-PAGES' });
  for (let i = 0; i < 21; i++) {
    const item = await OrderItem.create({
      orderId: order.id,
      shopName: '售后A',
      walmartSku: `PAGE-${i}`,
      purchaseChannelKey: `PAGE-${i}`,
    });
    await Ticket.create({
      itemId: item.id,
      createdBy: users.operator.id,
      creatorName: 'operator',
      lastActivityAt: new Date(),
    });
  }
  let result = await list({ q: 'SUMMARY-PAGES', page: 1, pageSize: 20 }, users.operator);
  assert.equal(result.rows.length, 20);
  assert.equal(result.openCount, 21);
  result = await list({ q: 'SUMMARY-PAGES', page: 2, pageSize: 20 }, users.operator);
  assert.equal(result.rows.length, 1);
  assert.equal(result.openCount, 21);
  const ticket = result.rows[0];
  await Ticket.update({ purchaseRefundAmount: '0.00' }, { where: { id: ticket.id } });
  await status(ticket.id, { status: 'completed', version: ticket.version }, users.operator);
  result = await list({ q: 'SUMMARY-PAGES', status: 'completed' }, users.operator);
  assert.equal(result.total, 1);
  assert.equal(result.openCount, 20);
  await status(ticket.id, { status: 'open', version: ticket.version + 1 }, users.buyer);
  assert.equal((await list({ q: 'SUMMARY-PAGES' }, users.operator)).openCount, 21);
  await storeA.update({ ownerId: users.other.id });
  assert.equal((await list({ q: 'SUMMARY-PAGES' }, users.operator)).openCount, 0);
  assert.equal((await list({ q: 'SUMMARY-PAGES' }, users.other)).openCount, 21);
  await storeA.update({ ownerId: users.operator.id });
});

test('采购渠道/状态多选、空值与权限取交集，处理中独立于售后状态', async () => {
  await Purchase.update(
    { purchaseChannel: ['渠道A', '渠道B'], purchaseStatus: '采购失败' },
    { where: { itemId: items.a.id } },
  );
  await Purchase.update(
    { purchaseChannel: null, purchaseStatus: ' \t ' },
    { where: { itemId: items.a2.id } },
  );
  await Purchase.update(
    { purchaseChannel: ['渠道B'], purchaseStatus: '采购中' },
    { where: { itemId: items.b.id } },
  );
  let result = await list(
    { purchaseChannel: ['渠道A', '渠道B'], purchaseStatus: ['采购失败', '采购中'] },
    users.admin,
  );
  assert.equal(result.total, 2);
  const own = result.rows.find((r) => r.item.id === items.a.id);
  assert.deepEqual(own.item.purchaseChannel, ['渠道A', '渠道B']);
  assert.equal(own.item.purchaseStatus, '采购失败');
  result = await list({ purchaseChannel: ['渠道B'], purchaseStatus: ['采购中'] }, users.operator);
  assert.equal(result.total, 0);
  result = await list(
    { q: 'AFTER-SALE-ORDER', purchaseChannelEmpty: true, purchaseStatusEmpty: true },
    users.admin,
  );
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].item.id, items.a2.id);
  const all = await list(
    {
      q: 'AFTER-SALE-ORDER',
      purchaseChannel: ['渠道B'],
      purchaseChannelEmpty: true,
      purchaseStatus: ['采购中'],
      purchaseStatusEmpty: true,
    },
    users.admin,
  );
  assert.equal(all.total, 2);
  assert.equal(
    (
      await list(
        { q: 'SUMMARY-PAGES', purchaseChannelEmpty: true, purchaseStatusEmpty: true },
        users.admin,
      )
    ).total,
    21,
  );
  const completed = await list(
    {
      q: 'AFTER-SALE-ORDER',
      purchaseChannelEmpty: true,
      purchaseStatusEmpty: true,
      status: 'completed',
    },
    users.admin,
  );
  assert.equal(completed.openCount, result.openCount);
  await rejects(() => list({ purchaseStatus: '[oops' }, users.admin), 400);
});

test('企业微信通知事务入队、幂等、状态不推送、重试与失败上限，测试不访问外网', async () => {
  const { AfterSaleNotification: Notification } = await import('../src/models.js');
  const { deliverAfterSaleNotification } = await import('../src/services/wecom-after-sales.js');
  const original = { ...config.wecom };
  config.wecom.webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only';
  config.wecom.appUrl = 'http://example.test';
  try {
    const order = await Order.create({ orderNumber: 'NOTIFY-ORDER' });
    const item = await OrderItem.create({
      orderId: order.id,
      shopName: '售后A',
      walmartSku: 'NOTIFY',
      purchaseChannelKey: 'NOTIFY',
    });
    const input = { itemId: item.id, ...message('新建工单通知') };
    const ticket = await create(input, users.operator);
    await create(input, users.operator);
    assert.equal(await Notification.count(), 1);
    const purchase = await Purchase.create({
      itemId: item.id,
      purchaseChannel: ['通知渠道A', '通知渠道B'],
      purchaseStatus: '采购成功（已出跟踪号）',
    });
    let current = await detail(ticket.id, {}, users.operator);
    assert.deepEqual(current.item.purchaseChannel, ['通知渠道A', '通知渠道B']);
    assert.equal(current.item.purchaseStatus, '采购成功（已出跟踪号）');
    const replyInput = message('采购人员回复');
    await reply(ticket.id, replyInput, users.buyer);
    // 修改后再刷新详情获得新值；同一回复重试不改写已入队的通知快照。
    await purchase.update({ purchaseChannel: ['通知渠道C'], purchaseStatus: '采购失败' });
    await reply(ticket.id, replyInput, users.buyer);
    assert.equal(await Notification.count(), 2);
    current = await detail(ticket.id, {}, users.buyer);
    assert.deepEqual(current.item.purchaseChannel, ['通知渠道C']);
    assert.equal(current.item.purchaseStatus, '采购失败');
    const d = await detail(ticket.id, {}, users.admin);
    await Ticket.update({ purchaseRefundAmount: '0.00' }, { where: { id: ticket.id } });
    await status(ticket.id, { status: 'completed', version: d.version }, users.admin);
    assert.equal(await Notification.count(), 2);
    await rejects(() => reply(ticket.id, message('不推送失败回复'), users.buyer), 409);
    assert.equal(await Notification.count(), 2);
    const pending = await Notification.findAll({ order: [['id', 'ASC']] });
    assert(pending[0].content.includes('新工单'));
    assert(pending[1].content.includes('新回复'));
    assert(pending[0].content.includes('采购渠道：未分配\n'));
    assert(pending[1].content.includes('采购渠道：通知渠道A / 通知渠道B\n'));
    assert(pending.every((row) => !row.content.includes('采购状态：')));
    assert(!pending[1].content.includes('通知渠道C'));
    assert(!JSON.stringify(pending).includes('test-only'));
    let calls = 0;
    const transport = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.msgtype, 'markdown_v2');
      assert.equal(body.images, undefined);
      assert(Buffer.byteLength(body.markdown_v2.content) <= 4096);
      assert(body.markdown_v2.content.includes('采购渠道：'));
      assert(!body.markdown_v2.content.includes('采购状态：'));
      assert(!body.markdown_v2.content.includes('通知渠道C'));
      return { ok: true, json: async () => ({ errcode: 0 }) };
    };
    await deliverAfterSaleNotification(async () => ({
      ok: true,
      json: async () => ({ errcode: 45009 }),
    }));
    assert.equal((await pending[0].reload()).attempts, 1);
    assert.equal(pending[0].status, 'pending');
    await deliverAfterSaleNotification(transport);
    assert.equal((await pending[1].reload()).status, 'sent');
    await pending[0].update({ nextAttemptAt: new Date(0) });
    await deliverAfterSaleNotification(transport);
    assert.equal((await pending[0].reload()).status, 'sent');
    assert.equal(calls, 2);
    await deliverAfterSaleNotification(transport);
    assert.equal(calls, 2);
    await pending[0].update({ status: 'pending', attempts: 4, nextAttemptAt: new Date(0) });
    await deliverAfterSaleNotification(async () => {
      throw new Error(config.wecom.webhook);
    });
    assert.equal((await pending[0].reload()).status, 'failed');
    assert.equal(pending[0].attempts, 5);
    assert(!pending[0].lastError.includes('test-only'));
    // 与工单同事务入队；事务失败不能残留通知。
    const { queueAfterSaleNotification } = await import('../src/services/wecom-after-sales.js');
    await assert.rejects(
      db.transaction(async (transaction) => {
        await queueAfterSaleNotification(
          { id: ticket.id },
          item,
          { id: 999999, actorName: 'test', content: 'rollback', images: [], createdAt: new Date() },
          'reply',
          transaction,
        );
        throw new Error('rollback');
      }),
    );
    assert.equal(await Notification.count({ where: { recordId: 999999 } }), 0);
  } finally {
    Object.assign(config.wecom, original);
  }
});

test('合并图文分段保存进度，失败续发并生成图片副本，兼容旧文本队列', async () => {
  const { AfterSaleNotification: Notification } = await import('../src/models.js');
  const { deliverAfterSaleNotification, queueAfterSaleNotification } =
    await import('../src/services/wecom-after-sales.js');
  const { default: sharp } = await import('sharp');
  const original = { ...config.wecom },
    originalStorage = config.storage;
  const storage = await mkdtemp(path.join(os.tmpdir(), 'wecom-queue-'));
  config.storage = storage;
  config.wecom.webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only';
  config.wecom.appUrl = 'http://example.test';
  try {
    await mkdir(path.join(storage, 'images'));
    const images = [];
    for (const color of ['#ff0000', '#0000ff']) {
      const name = `${randomUUID()}.webp`;
      await writeFile(
        path.join(storage, 'images', name),
        await sharp({ create: { width: 20, height: 20, channels: 3, background: color } })
          .webp()
          .toBuffer(),
      );
      images.push(`/uploads/images/${name}`);
    }
    await db.transaction((transaction) =>
      queueAfterSaleNotification(
        { id: ticketId },
        items.a,
        {
          id: 999998,
          actorName: 'tester',
          content: '完整售后😀\n'.repeat(800),
          images,
          createdAt: new Date(),
        },
        'reply',
        transaction,
      ),
    );
    const row = await Notification.findOne({ where: { recordId: 999998 } });
    assert.equal(row.parts.flatMap((p) => p.images).length, 2);
    const textCount = row.parts.findIndex((p) => p.images.length);
    const delivered = [];
    let failImage = true;
    const transport = async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (payload.markdown_v2?.content.includes('![售后图片') && failImage) {
        failImage = false;
        return { ok: false, status: 502 };
      }
      delivered.push(payload);
      return { ok: true, json: async () => ({ errcode: 0 }) };
    };
    for (let i = 0; i < textCount; i++) {
      await deliverAfterSaleNotification(transport);
      assert.equal((await row.reload()).nextPart, i + 1);
    }
    await deliverAfterSaleNotification(transport);
    assert.equal((await row.reload()).nextPart, textCount);
    assert.equal(row.attempts, 1);
    assert.equal(row.status, 'pending');
    // 模拟重启后重新从数据库读取进度；不重复已发送文本。
    await row.update({ nextAttemptAt: new Date(0) });
    await deliverAfterSaleNotification(transport);
    assert.equal((await row.reload()).nextPart, textCount + 1);
    while ((await row.reload()).status === 'pending') await deliverAfterSaleNotification(transport);
    assert.equal(row.status, 'sent');
    assert.equal(delivered.length, row.parts.length);
    assert(delivered.every((p) => p.msgtype === 'markdown_v2' && p.images === undefined));
    const combined = delivered.map((p) => p.markdown_v2.content).join('');
    assert(combined.indexOf('![售后图片1]') < combined.indexOf('![售后图片2]'));
    for (const image of images) {
      const filename = path.basename(image).replace('.webp', '.wecom.jpg');
      assert.equal((await sharp(path.join(storage, 'images', filename)).metadata()).format, 'jpeg');
    }
    const legacy = await Notification.create({
      recordId: 999997,
      ticketId,
      content: '旧版待发文本',
    });
    await deliverAfterSaleNotification(transport);
    assert.equal((await legacy.reload()).status, 'sent');
    assert.equal(delivered.at(-1).text.content, '旧版待发文本');
  } finally {
    Object.assign(config.wecom, original);
    config.storage = originalStorage;
    await rm(storage, { recursive: true, force: true });
  }
});

test('反馈供应商默认否，采购与管理员可标记；并发幂等、只记录首次操作且不发通知', async () => {
  const { AfterSaleNotification: Notification } = await import('../src/models.js');
  const order = await Order.create({ orderNumber: 'FEEDBACK-TEST' });
  const item = await OrderItem.create({
    orderId: order.id,
    shopName: '售后A',
    walmartSku: 'FEEDBACK',
    purchaseChannelKey: 'FEEDBACK',
  });
  const ticket = await create({ itemId: item.id, ...message() }, users.operator);
  let result = await detail(ticket.id, {}, users.buyer);
  assert.equal(result.supplierFeedback, false);
  const beforeItem = (await item.reload()).toJSON();
  const notificationCount = await Notification.count();
  const recordsCount = await Record.count({ where: { ticketId: ticket.id } });
  await rejects(() => markSupplierFeedback(ticket.id, users.operator), 403);
  const denied = await fetch(`${base}/purchase-after-sales/${ticket.id}/supplier-feedback`, {
    method: 'POST',
    headers: sessions.operator,
    body: '{}',
  });
  assert.equal(denied.status, 403);
  const noCsrf = { ...sessions.buyer };
  delete noCsrf['X-CSRF-Token'];
  assert.equal(
    (
      await fetch(`${base}/purchase-after-sales/${ticket.id}/supplier-feedback`, {
        method: 'POST',
        headers: noCsrf,
        body: '{}',
      })
    ).status,
    403,
  );
  await Promise.all([
    markSupplierFeedback(ticket.id, users.buyer),
    markSupplierFeedback(ticket.id, users.buyer),
  ]);
  result = await detail(ticket.id, {}, users.operator);
  assert.equal(result.supplierFeedback, true);
  assert.equal(result.supplierFeedbackBy, users.buyer.id);
  assert.equal(result.supplierFeedbackName, users.buyer.displayName);
  assert(result.supplierFeedbackAt);
  assert.equal(result.version, 2);
  const again = await markSupplierFeedback(ticket.id, users.admin);
  assert.equal(
    new Date(again.supplierFeedbackAt).getTime(),
    new Date(result.supplierFeedbackAt).getTime(),
  );
  assert.equal(again.supplierFeedbackBy, users.buyer.id);
  assert.equal(
    await AuditLog.count({
      where: {
        action: 'purchase_after_sale',
        entityId: String(ticket.id),
        'details.kind': 'supplier_feedback',
      },
    }),
    1,
  );
  assert.equal(await Notification.count(), notificationCount);
  assert.equal(await Record.count({ where: { ticketId: ticket.id } }), recordsCount);
  assert.deepEqual((await item.reload()).toJSON(), beforeItem);
  assert.equal((await list({ q: 'FEEDBACK-TEST' }, users.operator)).rows[0].supplierFeedback, true);
  await Ticket.update({ purchaseRefundAmount: '0.00' }, { where: { id: ticket.id } });
  await status(ticket.id, { status: 'completed', version: result.version }, users.admin);
  result = await detail(ticket.id, {}, users.admin);
  await status(ticket.id, { status: 'open', version: result.version }, users.admin);
  assert.equal((await detail(ticket.id, {}, users.admin)).supplierFeedback, true);
  await item.update({ fulfillmentParty: 'WFSFulfilled' });
  await rejects(() => markSupplierFeedback(ticket.id, users.buyer), 403);
  await rejects(() => markSupplierFeedback(99999999, users.admin), 404);
});

test('最高管理员可反馈已结束工单，忽略伪造清空输入，反馈事务失败时不留标记', async () => {
  const order = await Order.create({ orderNumber: 'FEEDBACK-ADMIN' });
  const item = await OrderItem.create({
    orderId: order.id,
    shopName: '售后B',
    walmartSku: 'FEEDBACK-ADMIN',
    purchaseChannelKey: 'FEEDBACK-ADMIN',
  });
  const ticket = await create({ itemId: item.id, ...message() }, users.other);
  await Ticket.update({ purchaseRefundAmount: '0.00' }, { where: { id: ticket.id } });
  await status(ticket.id, { status: 'completed', version: 1 }, users.admin);
  const oldCreate = AuditLog.create;
  AuditLog.create = async () => {
    throw new Error('simulated audit failure');
  };
  try {
    await assert.rejects(() => markSupplierFeedback(ticket.id, users.admin));
  } finally {
    AuditLog.create = oldCreate;
  }
  assert.equal((await detail(ticket.id, {}, users.admin)).supplierFeedback, false);
  const response = await fetch(`${base}/purchase-after-sales/${ticket.id}/supplier-feedback`, {
    method: 'POST',
    headers: sessions.admin,
    body: JSON.stringify({ supplierFeedback: false, supplierFeedbackBy: users.other.id }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.supplierFeedback, true);
  assert.equal(data.supplierFeedbackBy, users.admin.id);
  assert.equal((await detail(ticket.id, {}, users.admin)).status, 'completed');
  await rejects(() => detail(ticket.id, {}, users.operator), 403);
});
test('未反馈汇总跨页并独立于状态和反馈筛选，遵守其他条件和数据权限', async () => {
  const order = await Order.create({ orderNumber: 'UNFEEDBACK-SUMMARY' });
  const tickets = [];
  for (let i = 0; i < 23; i++) {
    const item = await OrderItem.create({
      orderId: order.id,
      shopName: i === 22 ? '售后B' : '售后A',
      walmartSku: `UF-${i}`,
      purchaseChannelKey: `UF-${i}`,
    });
    await Purchase.create({
      itemId: item.id,
      purchaseChannel: ['汇总渠道'],
      purchaseStatus: '采购中',
    });
    tickets.push(
      await Ticket.create({
        itemId: item.id,
        status: i === 21 ? 'completed' : 'open',
        createdBy: users.operator.id,
        creatorName: 'operator',
        createdAt: new Date('2026-11-05T03:00:00Z'),
        lastActivityAt: new Date(),
        supplierFeedbackAt: i === 0 ? new Date() : null,
      }),
    );
  }
  const query = {
    q: 'UNFEEDBACK-SUMMARY',
    shopNames: ['售后A'],
    ownerId: users.operator.id,
    startDate: '2026-11-05',
    endDate: '2026-11-05',
    purchaseChannel: ['汇总渠道'],
    purchaseStatus: ['采购中'],
  };
  let result = await list({ ...query, page: 1, pageSize: 20 }, users.operator);
  assert.equal(result.total, 22);
  assert.equal(result.rows.length, 20);
  assert.equal(result.unfeedbackCount, 21);
  result = await list({ ...query, page: 2, pageSize: 20 }, users.operator);
  assert.equal(result.rows.length, 2);
  assert.equal(result.unfeedbackCount, 21);
  result = await list({ ...query, supplierFeedback: 'yes', status: 'completed' }, users.operator);
  assert.equal(result.total, 0);
  assert.equal(result.unfeedbackCount, 21);
  assert.equal(result.openCount, 1);
  result = await list({ ...query, supplierFeedback: 'no', status: 'completed' }, users.operator);
  assert.equal(result.total, 1);
  assert.equal(result.unfeedbackCount, 21);
  assert.equal(result.openCount, 20);
  await markSupplierFeedback(tickets[21].id, users.buyer);
  result = await list({ ...query, supplierFeedback: 'yes', status: 'completed' }, users.operator);
  assert.equal(result.total, 1);
  assert.equal(result.unfeedbackCount, 20);
  await markSupplierFeedback(tickets[21].id, users.buyer);
  assert.equal((await list(query, users.operator)).unfeedbackCount, 20);
  assert.equal((await list({ q: query.q }, users.admin)).unfeedbackCount, 21);
  assert.equal((await list({ ...query, shopNames: ['售后B'] }, users.operator)).unfeedbackCount, 0);
  assert.equal(
    (await list({ ...query, ownerId: users.other.id }, users.operator)).unfeedbackCount,
    0,
  );
  for (const extra of [
    { q: 'not-found' },
    { purchaseChannel: ['not-found'] },
    { purchaseStatus: ['采购失败'] },
    { startDate: '2026-11-06', endDate: '2026-11-06' },
  ])
    assert.equal((await list({ ...query, ...extra }, users.admin)).unfeedbackCount, 0);
  await rejects(() => list({ ...query, supplierFeedback: 'invalid' }, users.admin), 400);
});

test('采购售后取工单而非旧标记：分页筛选、统计及完整导出一致，保留历史字段', async () => {
  const order = await Order.create({ orderNumber: 'TICKET-SOURCE-ONLY' });
  const ids = [];
  for (const [index, oldFlag, ticketStatus] of [
    [0, '是', null],
    [1, '否', 'open'],
    [2, null, 'completed'],
    [3, null, null],
  ]) {
    const item = await OrderItem.create({
      orderId: order.id,
      shopName: '售后A',
      walmartSku: `SOURCE-${index}`,
      purchaseChannelKey: `SOURCE-${index}`,
    });
    ids.push(item.id);
    await Purchase.create({
      itemId: item.id,
      afterSales: oldFlag,
      afterSalesResult: '已结束',
      afterSalesScreenshot: 'legacy-image',
      afterSalesResultScreenshot: 'legacy-result',
    });
    if (ticketStatus)
      await Ticket.create({
        itemId: item.id,
        status: ticketStatus,
        createdBy: users.admin.id,
        creatorName: 'admin',
        lastActivityAt: new Date(),
      });
    assert.equal((await getItem(item.id, users.admin)).afterSales, ticketStatus ? '是' : '否');
  }
  for (const flag of ['是', '否']) {
    const query = { q: 'TICKET-SOURCE-ONLY', afterSales: flag, pageSize: 1 };
    const first = await listOrders(query, users.operator),
      second = await listOrders({ ...query, page: 2 }, users.operator);
    assert.equal(first.total, 2);
    assert.equal(second.total, 2);
    assert.equal(first.rows.length, 1);
    assert.equal(second.rows.length, 1);
    assert(first.rows.every((r) => r.afterSales === flag));
    assert.notEqual(first.rows[0].id, second.rows[0].id);
    assert.equal((await listOrders(query, users.other)).total, 0);
    const chunks = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    stream.setHeader = () => {};
    await exportOrders({ filters: query }, stream, false, users.operator);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.concat(chunks));
    const sheet = book.worksheets[0],
      headers = sheet.getRow(1).values;
    assert.equal(sheet.rowCount, 3);
    for (const r of [2, 3]) {
      assert.equal(sheet.getRow(r).getCell(headers.indexOf('是否采购售后')).text, flag);
      assert.equal(sheet.getRow(r).getCell(headers.indexOf('售后截图')).text, 'legacy-image');
      assert.equal(sheet.getRow(r).getCell(headers.indexOf('售后结果')).text, '已结束');
      assert.equal(sheet.getRow(r).getCell(headers.indexOf('售后结果截图')).text, 'legacy-result');
    }
  }
  const response = await fetch(base + '/dashboard', { headers: sessions.admin });
  assert.equal((await response.json()).afterSales, await Ticket.count());
  const original = await Purchase.findOne({ where: { itemId: ids[0] } });
  assert.equal(original.afterSales, '是');
  for (const role of ['admin', 'operator', 'buyer'])
    for (const key of [
      'afterSales',
      'afterSalesScreenshot',
      'afterSalesResult',
      'afterSalesResultScreenshot',
    ]) {
      const response = await fetch(`${base}/orders/${ids[0]}`, {
        method: 'PUT',
        headers: sessions[role],
        body: JSON.stringify({
          version: 1,
          fields: { [key]: null },
          baseFields: { [key]: original[key] },
        }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /采购售后工单/);
    }
  assert.equal((await original.reload()).afterSales, '是');
  await rejects(() => listOrders({ afterSales: 'invalid' }, users.admin), 400);
});

test('采购退款金额为空禁止关闭，0可保存关闭，列表详情一致且不改订单采购或通知', async () => {
  const { item, ticket } = await refundFixture('ZERO');
  const beforeItem = (await item.reload()).toJSON();
  const purchase = await Purchase.findOne({ where: { itemId: item.id } }),
    beforePurchase = purchase.toJSON();
  const { AfterSaleNotification: Notification } = await import('../src/models.js');
  const notifications = await Notification.count(),
    records = await Record.count({ where: { ticketId: ticket.id } });
  assert.equal((await detail(ticket.id, {}, users.admin)).purchaseRefundAmount, null);
  // 关闭接口不接受未保存或伪造的金额绕过数据库校验。
  const denied = await fetch(`${base}/purchase-after-sales/${ticket.id}/status`, {
    method: 'POST',
    headers: sessions.operator,
    body: JSON.stringify({ status: 'completed', version: 1, purchaseRefundAmount: '0' }),
  });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).message, /采购退款金额/);
  assert.equal((await detail(ticket.id, {}, users.admin)).status, 'open');
  const saved = await fetch(`${base}/purchase-after-sales/${ticket.id}/refund-amount`, {
    method: 'PUT',
    headers: sessions.operator,
    body: JSON.stringify({ version: 1, purchaseRefundAmount: 0 }),
  });
  assert.equal(saved.status, 200);
  const data = await saved.json();
  assert.equal(data.purchaseRefundAmount, '0.00');
  assert.equal((await detail(ticket.id, {}, users.admin)).purchaseRefundAmount, '0.00');
  assert.equal(
    (await list({ q: 'REFUND-ZERO' }, users.operator)).rows[0].purchaseRefundAmount,
    '0.00',
  );
  assert.equal(await Record.count({ where: { ticketId: ticket.id } }), records);
  await status(ticket.id, { status: 'completed', version: data.version }, users.buyer);
  await rejects(
    () =>
      saveRefund(ticket.id, { purchaseRefundAmount: '10', version: data.version + 1 }, users.admin),
    409,
  );
  assert.deepEqual((await item.reload()).toJSON(), beforeItem);
  assert.deepEqual((await purchase.reload()).toJSON(), beforePurchase);
  assert.equal(await Notification.count(), notifications);
});

test('采购退款金额拒绝非法格式，支持精确2位金额和显式清空，权限及WFS保护有效', async () => {
  const { item, ticket } = await refundFixture('VALIDATION');
  for (const amount of [
    -1,
    '-0.01',
    '1.001',
    '1e2',
    'abc',
    true,
    [],
    {},
    undefined,
    '10000000000000000',
    'NaN',
    'Infinity',
  ])
    await rejects(
      () => saveRefund(ticket.id, { purchaseRefundAmount: amount, version: 1 }, users.admin),
      400,
    );
  await rejects(
    () => saveRefund(ticket.id, { purchaseRefundAmount: '1', version: 1 }, users.other),
    403,
  );
  let d = await saveRefund(
    ticket.id,
    { purchaseRefundAmount: '9999999999999999.99', version: 1 },
    users.admin,
  );
  assert.equal(d.purchaseRefundAmount, '9999999999999999.99');
  await migratePurchaseAfterSales(); // 幂等迁移不得覆盖已维护的金额。
  assert.equal(
    (await detail(ticket.id, {}, users.buyer)).purchaseRefundAmount,
    d.purchaseRefundAmount,
  );
  d = await saveRefund(
    ticket.id,
    { purchaseRefundAmount: ' 12.30 ', version: d.version },
    users.buyer,
  );
  assert.equal(d.purchaseRefundAmount, '12.30');
  const same = await saveRefund(
    ticket.id,
    { purchaseRefundAmount: '12.3', version: d.version },
    users.buyer,
  );
  assert.equal(same.version, d.version);
  d = await saveRefund(
    ticket.id,
    { purchaseRefundAmount: '  ', version: d.version },
    users.operator,
  );
  assert.equal(d.purchaseRefundAmount, null);
  await rejects(
    () => status(ticket.id, { status: 'completed', version: d.version }, users.admin),
    400,
  );
  const audit = await AuditLog.findOne({
    where: {
      entityId: String(ticket.id),
      action: 'purchase_after_sale',
      'details.kind': 'refund_amount',
    },
    order: [['id', 'DESC']],
  });
  assert.deepEqual(audit.details.before, { purchaseRefundAmount: '12.30' });
  assert.deepEqual(audit.details.after, { purchaseRefundAmount: null });
  await item.update({ fulfillmentParty: 'WFSFulfilled' });
  await rejects(
    () => saveRefund(ticket.id, { purchaseRefundAmount: '0', version: d.version }, users.buyer),
    403,
  );
});

test('退款金额修改采用版本和事务保护，旧版本不能覆盖，审计失败整笔回滚', async () => {
  const { ticket } = await refundFixture('CONCURRENT');
  const results = await Promise.allSettled([
    saveRefund(ticket.id, { purchaseRefundAmount: '10.10', version: 1 }, users.admin),
    saveRefund(ticket.id, { purchaseRefundAmount: '20.20', version: 1 }, users.buyer),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  const d = await detail(ticket.id, {}, users.admin);
  await rejects(() => status(ticket.id, { status: 'completed', version: 1 }, users.admin), 409);
  const oldCreate = AuditLog.create;
  AuditLog.create = async () => {
    throw new Error('refund audit failure');
  };
  try {
    await assert.rejects(() =>
      saveRefund(ticket.id, { purchaseRefundAmount: '30', version: d.version }, users.admin),
    );
  } finally {
    AuditLog.create = oldCreate;
  }
  const after = await detail(ticket.id, {}, users.admin);
  assert.equal(after.version, d.version);
  assert.equal(after.purchaseRefundAmount, d.purchaseRefundAmount);
});

test('历史已完毕工单不回填金额或改状态，重开后空值不能再次关闭', async () => {
  const { ticket } = await refundFixture('LEGACY');
  await Ticket.update(
    { status: 'completed', completedAt: new Date() },
    { where: { id: ticket.id } },
  );
  await migratePurchaseAfterSales();
  await migratePurchaseAfterSales();
  let d = await detail(ticket.id, {}, users.admin);
  assert.equal(d.status, 'completed');
  assert.equal(d.purchaseRefundAmount, null);
  await status(ticket.id, { status: 'open', version: d.version }, users.operator);
  d = await detail(ticket.id, {}, users.admin);
  await rejects(
    () => status(ticket.id, { status: 'completed', version: d.version }, users.buyer),
    400,
  );
  d = await saveRefund(ticket.id, { purchaseRefundAmount: '0', version: d.version }, users.buyer);
  await status(ticket.id, { status: 'completed', version: d.version }, users.operator);
});
