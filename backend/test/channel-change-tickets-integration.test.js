import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { exportOrders } from '../src/services/order-export.js';
import { purchaseAssignmentSummary } from '../src/services/purchase-assignment-summary.js';
import { DataTypes } from 'sequelize';
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
  DictionaryOption,
  ChannelChangeTicket as Ticket,
  ChannelChangeRecord as Record,
  AfterSaleNotification as Notification,
} from '../src/models.js';
import {
  createChannelChange as create,
  listChannelChanges as list,
  getChannelChange as detail,
  replyChannelChange as reply,
  changeChannelTicketStatus as status,
  applyChannelChange as applyService,
  batchApplyChannelChanges as batchApply,
} from '../src/services/channel-change-tickets.js';
import { migrateChannelChangeTickets } from '../src/migrations/channel-change-tickets.js';
import {
  getItem,
  listOrders,
  assignItems,
  editItem,
  updateFollowupNote,
} from '../src/services/orders.js';
import { createPurchaseAfterSale } from '../src/services/purchase-after-sales.js';
import { deliverAfterSaleNotification } from '../src/services/wecom-after-sales.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { drainAudit } from '../src/services/audit.js';
const isolated = /^my_order_channel_change_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
let connection,
  created = false,
  server,
  base;
const users = {},
  sessions = {};
const message = (content = '申请调整采购渠道', images = []) => ({
  content,
  images,
  requestId: randomUUID(),
});
const rejects = (fn, code) => assert.rejects(fn, (e) => e.status === code || e.statusCode === code);
async function fixture(name, owner = 'operator', party = 'SellerFulfilled') {
  const order = await Order.create({ orderNumber: `CHANGE-${name}` });
  const item = await OrderItem.create({
    orderId: order.id,
    shopName: owner,
    purchaseChannelKey: name,
    walmartSku: name,
    productName: `商品${name}`,
    orderAmount: '50',
    quantity: 2,
    fulfillmentParty: party,
  });
  const purchase = await Purchase.create({
    itemId: item.id,
    purchaseChannel: ['旧渠道'],
    allocatable: '是',
    purchaseStatus: '采购中',
    purchaseAmount: '20',
    purchaseQuantity: 2,
    followupNote: '不得覆盖',
  });
  return { item, purchase };
}
const input = (item, extra = {}) => ({
  itemId: item.id,
  itemVersion: item.version,
  ...message(),
  ...extra,
});
const apply = (id, body, user) =>
  applyService(id, { targetChannels: ['新渠道', '备用渠道'], ...body }, user);
const currentVersion = async (id) => (await Ticket.findByPk(id)).version;
before(async () => {
  if (!isolated) return;
  config.wecom.webhook = '';
  config.wecom.channelChangeWebhook = '';
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
  // 模拟旧队列：原通知不丢失，recordId的原唯一约束仍保留。
  await Notification.create({ recordId: 9876, ticketId: 9876, content: '旧通知', status: 'sent' });
  await db.getQueryInterface().removeColumn('after_sale_notifications', 'channelChangeRecordId');
  await db.getQueryInterface().changeColumn('after_sale_notifications', 'recordId', {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
  });
  await db.getQueryInterface().removeColumn('channel_change_tickets', 'beforePurchase');
  await db.getQueryInterface().removeColumn('channel_change_tickets', 'targetPurchase');
  await db.getQueryInterface().removeColumn('channel_change_tickets', 'executedBefore');
  await db.getQueryInterface().removeColumn('channel_change_tickets', 'executedAfter');
  await migrateChannelChangeTickets();
  await migrateChannelChangeTickets();
  assert.equal((await Notification.findOne({ where: { recordId: 9876 } })).content, '旧通知');
  const passwordHash = await hashPassword('Channel-test-123');
  for (const [name, role] of [
    ['admin', 'admin'],
    ['supervisor', 'supervisor'],
    ['buyer', 'purchasing'],
    ['operator', 'operations'],
    ['other', 'operations'],
  ]) {
    users[name] = await User.create({ username: name, displayName: name, role, passwordHash });
  }
  for (const name of ['operator', 'other'])
    await Store.create({ systemStoreName: name, walmartStoreName: name, ownerId: users[name].id });
  for (const value of ['旧渠道', '新渠道', '备用渠道', '外部变更'])
    await DictionaryOption.create({ kind: 'purchaseChannel', value });
  await DictionaryOption.create({ kind: 'purchaseChannel', value: '停用渠道', active: false });
  await DictionaryOption.create({ kind: 'purchasePlatform', value: 'Amazon', active: true });
  await DictionaryOption.create({ kind: 'purchaseStatus', value: '采购失败', active: true });
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const name of Object.keys(users)) {
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: name, password: 'Channel-test-123' }),
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

test('创建保留原渠道与采购信息，多图、重试、商品详情及订单标记正确', async () => {
  const { item, purchase } = await fixture('create');
  const before = (await purchase.reload()).toJSON();
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
  const body = input(item, { images: imagePaths });
  const ticket = await create(body, users.operator);
  assert.equal((await create(body, users.operator)).id, ticket.id);
  assert.deepEqual((await purchase.reload()).toJSON(), before);
  const row = await detail(ticket.id, {}, users.operator);
  assert.equal(row.item.id, item.id);
  assert.equal(row.item.quantity, 2);
  assert.equal(row.item.purchaseAmount, '20');
  assert.deepEqual(row.beforeChannels, ['旧渠道']);
  assert.deepEqual(row.targetChannels, []);
  assert.deepEqual(row.records[0].images, imagePaths);
  assert.equal((await getItem(item.id, users.operator)).channelChangeTicket.id, ticket.id);
  const orders = await listOrders({ q: 'CHANGE-create' }, users.operator);
  assert.equal(orders.total, 1);
  assert.equal(orders.rows[0].channelChangeTicket.id, ticket.id);
});
test('并发创建最多一个未关闭工单；不同请求不会追加到已有工单', async () => {
  const { item } = await fixture('concurrent');
  const results = await Promise.allSettled([
    create(input(item), users.operator),
    create(input(item), users.buyer),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await Ticket.count({ where: { itemId: item.id, status: 'open' } }), 1);
});
test('运营数据隔离、WFS只读和采购执行权限覆盖全部写入口', async () => {
  const { item } = await fixture('scope');
  const ticket = await create(input(item), users.operator);
  await rejects(() => create(input(item), users.other), 403);
  await rejects(() => detail(ticket.id, {}, users.other), 403);
  await rejects(() => reply(ticket.id, message(), users.other), 403);
  await rejects(() => status(ticket.id, { status: 'completed', version: 1 }, users.other), 403);
  await rejects(() => apply(ticket.id, { version: 1 }, users.operator), 403);
  assert.equal((await list({ itemId: item.id }, users.other)).total, 0);
  const wfs = await fixture('wfs', 'operator', 'WFSFulfilled');
  await rejects(() => create(input(wfs.item), users.admin), 403);
  await item.update({ fulfillmentParty: 'WFSFulfilled' });
  await rejects(() => reply(ticket.id, message(), users.admin), 403);
  await rejects(() => status(ticket.id, { status: 'completed', version: 1 }, users.admin), 403);
  await rejects(() => apply(ticket.id, { version: 1 }, users.admin), 403);
});
test('确认变更原子更新渠道、分配时间和订单版本，重复确认不再更新时间', async () => {
  const { item, purchase } = await fixture('apply');
  const ticket = await create(input(item), users.operator);
  const oldVersion = item.version;
  await apply(ticket.id, { version: 1 }, users.buyer);
  await item.reload();
  await purchase.reload();
  assert.deepEqual(purchase.purchaseChannel, ['新渠道', '备用渠道']);
  assert.equal(item.version, oldVersion + 1);
  assert.equal(purchase.followupNote, '不得覆盖');
  assert.equal(purchase.supplierAssignmentStatus, '已分配');
  const assignedAt = purchase.purchaseAssignedAt.getTime();
  await rejects(() => apply(ticket.id, { version: 1 }, users.supervisor), 403);
  await apply(ticket.id, { version: 1 }, users.admin);
  assert.equal((await purchase.reload()).purchaseAssignedAt.getTime(), assignedAt);
  assert.equal(await Record.count({ where: { ticketId: ticket.id, kind: 'applied' } }), 1);
});
test('旧渠道变化、未审核、无效字典或停用渠道禁止确认，不改订单与工单', async () => {
  for (const mode of ['channel', 'allocatable', 'inactive']) {
    const { item, purchase } = await fixture(mode);
    const ticket = await create(input(item), users.operator);
    if (mode === 'channel')
      await assignItems(
        { items: [{ id: item.id, version: item.version }], purchaseChannel: ['外部变更'] },
        users.buyer,
      );
    if (mode === 'allocatable') await purchase.update({ allocatable: '否' });
    if (mode === 'inactive')
      await DictionaryOption.update(
        { active: false },
        { where: { value: '新渠道', kind: 'purchaseChannel' } },
      );
    const before = (await purchase.reload()).toJSON();
    await assert.rejects(() => apply(ticket.id, { version: 1 }, users.admin));
    assert.deepEqual((await purchase.reload()).toJSON(), before);
    assert.equal((await Ticket.findByPk(ticket.id)).appliedAt, null);
    await DictionaryOption.update(
      { active: true },
      { where: { value: '新渠道', kind: 'purchaseChannel' } },
    );
  }
});

test('确认时审计失败整笔回滚，并发确认仅更新一次', async () => {
  const { item, purchase } = await fixture('rollback');
  const ticket = await create(input(item), users.operator);
  const before = (await purchase.reload()).toJSON();
  AuditLog.addHook('beforeCreate', 'test-channel-rollback', (row) => {
    if (row.action === 'channel_change_ticket' && row.details.kind === 'applied')
      throw new Error('模拟审计失败');
  });
  try {
    await assert.rejects(() => apply(ticket.id, { version: 1 }, users.admin), /模拟审计失败/);
  } finally {
    AuditLog.removeHook('beforeCreate', 'test-channel-rollback');
  }
  assert.deepEqual((await purchase.reload()).toJSON(), before);
  assert.equal((await Ticket.findByPk(ticket.id)).appliedAt, null);
  assert.equal((await item.reload()).version, 1);
  await Promise.all([
    apply(ticket.id, { version: 1 }, users.admin),
    apply(ticket.id, { version: 1 }, users.buyer),
  ]);
  assert.equal((await item.reload()).version, 2);
  assert.equal(await Record.count({ where: { ticketId: ticket.id, kind: 'applied' } }), 1);
});

test('同一商品并发重开两个历史工单只允许一个成功', async () => {
  const { item } = await fixture('reopen-concurrent');
  const first = await create(input(item), users.operator);
  await status(first.id, { status: 'completed', version: 1 }, users.operator);
  const second = await create(input(item), users.operator);
  await status(second.id, { status: 'completed', version: 1 }, users.operator);
  const results = await Promise.allSettled([
    status(first.id, { status: 'open', version: 2 }, users.admin),
    status(second.id, { status: 'open', version: 2 }, users.buyer),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal(await Ticket.count({ where: { itemId: item.id, status: 'open' } }), 1);
});
test('关闭可重新申请；重开检查同商品活动工单；重开已执行工单不再次执行', async () => {
  const { item, purchase } = await fixture('history');
  const first = await create(input(item), users.operator);
  await status(first.id, { status: 'completed', version: 1 }, users.operator);
  assert.deepEqual((await purchase.reload()).purchaseChannel, ['旧渠道']);
  const second = await create(input(item), users.operator);
  await rejects(() => status(first.id, { status: 'open', version: 2 }, users.admin), 409);
  assert.equal((await getItem(item.id, users.operator)).channelChangeTicket.id, second.id);
  await status(second.id, { status: 'completed', version: 1 }, users.operator);
  await status(first.id, { status: 'open', version: 2 }, users.operator);
  assert.equal((await getItem(item.id, users.operator)).channelChangeTicket.id, first.id);
  await apply(first.id, { version: 3 }, users.admin);
  const assignedAt = (await purchase.reload()).purchaseAssignedAt.getTime();
  await status(first.id, { status: 'completed', version: 4 }, users.operator);
  await status(first.id, { status: 'open', version: 5 }, users.operator);
  await apply(first.id, { version: 6 }, users.admin);
  assert.equal((await purchase.reload()).purchaseAssignedAt.getTime(), assignedAt);
  assert.equal((await list({ itemId: item.id }, users.admin)).total, 2);
});
test('聊天跨账号追加、幂等、分页、关闭及版本冲突', async () => {
  const { item } = await fixture('chat');
  const ticket = await create(input(item), users.operator);
  const body = message('采购回复');
  const result = await reply(ticket.id, body, users.buyer);
  assert.equal((await reply(ticket.id, body, users.buyer)).id, result.id);
  await rejects(() => reply(ticket.id, { ...body, content: '改写' }, users.buyer), 409);
  await rejects(() => status(ticket.id, { status: 'completed', version: 1 }, users.operator), 409);
  for (let i = 0; i < 51; i++) await reply(ticket.id, message(`分页${i}`), users.operator);
  const current = await detail(ticket.id, {}, users.buyer);
  assert.equal(current.records.length, 50);
  assert.equal(current.hasMore, true);
  const old = await detail(ticket.id, { before: current.before }, users.buyer);
  assert.equal(old.records.length, 3);
  await status(ticket.id, { status: 'completed', version: current.version }, users.operator);
  await rejects(() => reply(ticket.id, message(), users.buyer), 409);
});
test('输入校验拒绝空渠道、原渠道、停用渠道、他人图片与过期订单', async () => {
  const { item } = await fixture('invalid');
  for (const targetChannels of [['旧渠道'], ['停用渠道'], ['不存在']])
    await assert.rejects(() => create(input(item, { targetChannels }), users.operator));
  await rejects(() => create(input(item, { itemVersion: 99 }), users.operator), 409);
  const id = randomUUID();
  await Upload.create({ id, filename: `${id}.webp`, kind: 'image', uploadedBy: users.other.id });
  await assert.rejects(() =>
    create(input(item, { images: [`/uploads/images/${id}.webp`] }), users.operator),
  );
  assert.equal(await Ticket.count({ where: { itemId: item.id } }), 0);
});
test('同一队列保留售后与渠道通知，不冲突；模拟发送验证正文、目标、链接，不发真实群', async () => {
  config.wecom.webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=isolated-test';
  config.wecom.channelChangeWebhook =
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=channel-isolated-test';
  config.wecom.appUrl = 'http://example.test';
  try {
    const { item } = await fixture('notification');
    await createPurchaseAfterSale({ itemId: item.id, ...message('原售后内容') }, users.operator);
    const ticket = await create(input(item, { content: '变更申请完整内容' }), users.operator);
    const record = await reply(ticket.id, message('完整回复'), users.buyer);
    const notices = await Notification.findAll({
      where: { ticketId: ticket.id, channelChangeRecordId: record.id },
    });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].recordId, null);
    assert.match(notices[0].content, /渠道变更新回复/);
    assert.match(notices[0].content, /变更前采购渠道：旧渠道/);
    assert.match(notices[0].content, /目标采购渠道：待分配/);
    const payloads = [];
    const targets = [];
    const transport = async (_url, request) => {
      targets.push(_url);
      payloads.push(JSON.parse(request.body));
      return { ok: true, json: async () => ({ errcode: 0 }) };
    };
    while (await deliverAfterSaleNotification(transport)) {}
    assert.equal(payloads.length, 3);
    assert.equal(targets.filter((url) => url === config.wecom.channelChangeWebhook).length, 2);
    assert.equal(targets.filter((url) => url === config.wecom.webhook).length, 1);
    const text = payloads.map((p) => p.markdown_v2.content).join('\n');
    assert.match(text, /channel-change-tickets\?ticket=/);
    assert.match(text, /purchase-after-sales\?ticket=/);
    assert.match(text, /完整回复/);
  } finally {
    config.wecom.webhook = '';
    config.wecom.channelChangeWebhook = '';
    config.wecom.appUrl = '';
  }
});
test('API登录、CSRF、角色权限和记录不可修改删除', async () => {
  assert.equal((await fetch(base + '/channel-change-tickets')).status, 401);
  for (const name of Object.keys(users))
    assert.equal(
      (await fetch(base + '/channel-change-tickets', { headers: sessions[name] })).status,
      200,
    );
  const { item } = await fixture('api');
  const ticket = await create(input(item), users.operator);
  const noCsrf = await fetch(base + '/channel-change-tickets', {
    method: 'POST',
    headers: { Cookie: sessions.operator.Cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(input(item)),
  });
  assert.equal(noCsrf.status, 403);
  const path = base + `/channel-change-tickets/${ticket.id}`;
  assert.equal(
    (
      await fetch(path + '/apply', {
        method: 'POST',
        headers: sessions.operator,
        body: JSON.stringify({ version: 1 }),
      })
    ).status,
    403,
  );
  for (const method of ['PUT', 'PATCH', 'DELETE'])
    assert.equal(
      (await fetch(path + '/records/1', { method, headers: sessions.admin, body: '{}' })).status,
      404,
    );
  const applied = await fetch(path + '/apply', {
    method: 'POST',
    headers: sessions.buyer,
    body: JSON.stringify({
      version: await currentVersion(ticket.id),
      targetChannels: ['新渠道', '备用渠道'],
    }),
  });
  assert.equal(applied.status, 200, await applied.text());
});

test('多选店铺与所属账号遵守权限，选项不泄露其他运营店铺', async () => {
  for (const owner of ['operator', 'other']) {
    const { item } = await fixture(`filter-owner-${owner}`, owner);
    await create(input(item), users.admin);
  }
  const query = { q: 'filter-owner', shopNames: JSON.stringify(['operator', 'other']) };
  assert.equal((await list(query, users.admin)).total, 2);
  assert.equal((await list({ ...query, ownerId: users.other.id }, users.admin)).total, 1);
  assert.equal((await list(query, users.operator)).total, 1);
  assert.equal((await list({ ...query, ownerId: users.other.id }, users.operator)).total, 0);
  assert.equal((await list({ ...query, shopNames: ['other'] }, users.operator)).openCount, 0);
  const response = await fetch(base + '/channel-change-tickets/options', {
    headers: sessions.operator,
  });
  assert.equal(response.status, 200);
  const options = await response.json();
  assert.deepEqual(
    options.stores.map((s) => s.name),
    ['operator'],
  );
  assert.equal(options.stores[0].ownerUsername, 'operator');
});

test('按当前采购渠道和状态筛选，空值可与具体值多选，计数跨页且独立于工单状态', async () => {
  const fixtures = [
    { channel: ['旧渠道'], status: '采购中' },
    { channel: ['新渠道', '备用渠道'], status: '采购失败' },
    { channel: [], status: null },
    { channel: null, status: '' },
    { channel: [], status: '  \t ' },
  ];
  const ids = [];
  for (const [index, value] of fixtures.entries()) {
    const { item, purchase } = await fixture(`filter-purchase-${index}`);
    const ticket = await create(input(item), users.admin);
    ids.push(ticket.id);
    await purchase.update({ purchaseChannel: value.channel, purchaseStatus: value.status });
  }
  const query = {
    q: 'filter-purchase',
    purchaseChannel: ['新渠道', '不存在'],
    purchaseStatus: ['采购失败', '采购中'],
  };
  assert.deepEqual(
    (await list(query, users.admin)).rows.map((t) => t.id),
    [ids[1]],
  );
  // 所有申请目标都含新渠道，但不能因此命中其他工单。
  const mixed = { ...query, purchaseChannelEmpty: true, purchaseStatusEmpty: 'true' };
  assert.equal((await list(mixed, users.admin)).total, 4);
  assert.equal((await list({ q: query.q, purchaseStatusEmpty: true }, users.admin)).total, 3);
  await status(ids[1], { status: 'completed', version: await currentVersion(ids[1]) }, users.admin);
  const completed = await list({ ...mixed, status: 'completed' }, users.admin);
  assert.equal(completed.total, 1);
  assert.equal(completed.openCount, 3);
  const beyondPage = await list({ ...mixed, page: 2 }, users.admin);
  assert.equal(beyondPage.rows.length, 0);
  assert.equal(beyondPage.openCount, 3);
});

test('创建日期按北京时间包含起止日，拒绝无效、颠倒、未来日期', async () => {
  const dates = [
    '2026-10-01T15:59:59Z',
    '2026-10-01T16:00:00Z',
    '2026-10-02T15:59:59Z',
    '2026-10-02T16:00:00Z',
  ];
  for (const [index, date] of dates.entries()) {
    const { item } = await fixture(`filter-date-${index}`);
    const ticket = await create(input(item), users.admin);
    await Ticket.update({ createdAt: new Date(date) }, { where: { id: ticket.id }, silent: true });
  }
  const result = await list(
    { q: 'filter-date', startDate: '2026-10-02', endDate: '2026-10-02' },
    users.admin,
  );
  assert.equal(result.total, 2);
  assert.equal(result.openCount, 2);
  for (const query of [
    { startDate: '2026-02-30' },
    { startDate: 'invalid' },
    { startDate: '2026-10-03', endDate: '2026-10-02' },
    { endDate: '2099-01-01' },
    { shopNames: '[invalid' },
    { ownerId: -1 },
    { purchaseChannel: [true] },
  ])
    await rejects(() => list(query, users.admin), 400);
});

test('创建保存采购申请不改订单，确认时原子写回六项并计算限价与价格系数', async () => {
  const { item, purchase } = await fixture('purchase-fields');
  await item.update({ tax: '2' });
  await purchase.update({
    purchaseUrl: 'https://example.test/old',
    purchaseSku: 'OLD',
    purchaseLinkAmount: '10',
    shippingMode: 'FBM',
    merchantName: '旧商家',
  });
  const request = input(item, {
    purchaseFields: {
      purchaseUrl: 'https://example.test/new',
      purchaseSku: 'NEW',
      purchaseLinkAmount: '20.55',
      purchasePlatform: 'Amazon',
      shippingMode: 'FBA',
      merchantName: '新商家',
    },
  });
  const ticket = await create(request, users.operator);
  await purchase.reload();
  assert.equal(purchase.purchaseSku, 'OLD');
  const snapshot = await detail(ticket.id, {}, users.operator);
  assert.equal(snapshot.beforePurchase.purchaseSku, 'OLD');
  assert.equal(snapshot.targetPurchase.purchaseSku, 'NEW');
  assert.equal(snapshot.targetPurchase.purchaseLimit, '22.61');
  assert.equal((await create(request, users.operator)).id, ticket.id);
  await rejects(
    () =>
      create(
        { ...request, purchaseFields: { ...request.purchaseFields, merchantName: '不同商家' } },
        users.operator,
      ),
    409,
  );
  await apply(ticket.id, { version: await currentVersion(ticket.id) }, users.buyer);
  await purchase.reload();
  for (const [key, value] of Object.entries(request.purchaseFields))
    assert.equal(
      key === 'purchaseLinkAmount' ? Number(purchase[key]) : purchase[key],
      key === 'purchaseLinkAmount' ? Number(value) : value,
    );
  assert.equal(Number(purchase.purchaseLimit), 22.61);
  assert.equal(Number(purchase.priceFactor), 1.8847);
  assert.equal(purchase.followupNote, '不得覆盖');
  assert.equal(Number(purchase.purchaseAmount), 20);
  assert.deepEqual(purchase.purchaseChannel, ['新渠道', '备用渠道']);
  assert(purchase.purchaseAssignedAt);
  const audit = await AuditLog.findOne({
    where: { action: 'channel_change_ticket', entityId: String(ticket.id) },
    order: [['id', 'DESC']],
  });
  assert.equal(audit.details.targetPurchase.purchaseSku, 'NEW');
});

test('采购信息冲突阻止确认且不部分更新，无关备注变化可正常确认，支持明确清空', async () => {
  const { item, purchase } = await fixture('purchase-fields-conflict');
  await purchase.update({ merchantName: '旧商家', purchaseSku: '旧SKU', purchaseLinkAmount: '10' });
  const ticket = await create(
    input(item, {
      purchaseFields: { merchantName: '新商家', purchaseSku: null, purchaseLinkAmount: null },
    }),
    users.operator,
  );
  await purchase.update({ merchantName: '他人修改' });
  await rejects(() => apply(ticket.id, { version: 1 }, users.admin), 409);
  await purchase.reload();
  assert.deepEqual(purchase.purchaseChannel, ['旧渠道']);
  assert.equal(purchase.purchaseSku, '旧SKU');
  assert.equal((await Ticket.findByPk(ticket.id)).appliedAt, null);
  await purchase.update({ merchantName: '旧商家', followupNote: '新的跟单备注' });
  await apply(ticket.id, { version: 1 }, users.admin);
  await purchase.reload();
  assert.equal(purchase.merchantName, '新商家');
  assert.equal(purchase.purchaseSku, null);
  assert.equal(purchase.purchaseLimit, null);
  assert.equal(purchase.priceFactor, null);
  assert.equal(purchase.followupNote, '新的跟单备注');
});

test('拒绝非法采购字段和手填限价，旧停用平台未修改可保留，确认时再次校验字典', async () => {
  const { item, purchase } = await fixture('purchase-fields-validation');
  for (const purchaseFields of [
    { purchaseLimit: '1' },
    { purchaseAmount: '1' },
    { purchaseUrl: 'javascript:alert(1)' },
    { purchaseLinkAmount: '-1' },
    { shippingMode: '未知' },
    { purchasePlatform: '未知平台' },
  ]) {
    await rejects(() => create(input(item, { purchaseFields }), users.admin), 400);
  }
  await purchase.update({ purchasePlatform: '历史平台' });
  const ticket = await create(
    input(item, { purchaseFields: { purchasePlatform: '历史平台', merchantName: '商家' } }),
    users.admin,
  );
  await apply(ticket.id, { version: 1 }, users.admin);
  await purchase.reload();
  assert.equal(purchase.purchasePlatform, '历史平台');
  const platform = await DictionaryOption.create({
    kind: 'purchasePlatform',
    value: '临时平台',
    active: true,
  });
  try {
    const other = await fixture('purchase-fields-disabled');
    const next = await create(
      input(other.item, { purchaseFields: { purchasePlatform: '临时平台' } }),
      users.admin,
    );
    await platform.update({ active: false });
    await rejects(() => apply(next.id, { version: 1 }, users.admin), 400);
    await other.purchase.reload();
    assert.deepEqual(other.purchase.purchaseChannel, ['旧渠道']);
  } finally {
    await platform.destroy();
  }
});

test('已结算模式变更沿用成本规则，折扣缺失整笔回滚，历史佣金不重取', async () => {
  const { item, purchase } = await fixture('purchase-fields-settled');
  await purchase.update({
    settlement: '已结算',
    shippingMode: 'FBM',
    purchaseCostChannel: '旧渠道',
    purchaseDiscount: '0.8',
    purchaseCost: '16',
    commissionRate: '12',
  });
  const ticket = await create(
    input(item, {
      purchaseFields: { shippingMode: 'FBA', purchaseLinkAmount: '30' },
    }),
    users.admin,
  );
  await rejects(() => apply(ticket.id, { version: 1 }, users.admin), 400);
  await purchase.reload();
  assert.equal(purchase.shippingMode, 'FBM');
  assert.deepEqual(purchase.purchaseChannel, ['旧渠道']);
  assert.equal((await Ticket.findByPk(ticket.id)).appliedAt, null);
  await DictionaryOption.update(
    { fbaPurchaseDiscount: '0.7' },
    { where: { kind: 'purchaseChannel', value: '新渠道' } },
  );
  try {
    await apply(ticket.id, { version: 1, targetChannels: ['新渠道'] }, users.admin);
    await purchase.reload();
    assert.equal(purchase.shippingMode, 'FBA');
    assert.equal(purchase.purchaseCostChannel, '新渠道');
    assert.equal(Number(purchase.purchaseDiscount), 0.7);
    assert.equal(Number(purchase.purchaseCost), 14);
    assert.equal(Number(purchase.commissionRate), 12);
  } finally {
    await DictionaryOption.update(
      { fbaPurchaseDiscount: null },
      { where: { kind: 'purchaseChannel', value: '新渠道' } },
    );
  }
});

test('创建禁止指定渠道，只有采购和管理员确认，清空采购状态和成功时间、汇总切换渠道', async () => {
  const { item, purchase } = await fixture('permission-and-reset');
  await purchase.update({
    purchaseStatus: '采购成功（未出跟踪号）',
    purchaseConfirmedAt: new Date(),
    purchaseAssignedAt: new Date(),
  });
  for (const user of [users.operator, users.supervisor, users.buyer, users.admin])
    await rejects(() => create(input(item, { targetChannels: ['新渠道'] }), user), 400);
  const ticket = await create(input(item), users.supervisor);
  await rejects(() => apply(ticket.id, { version: 1 }, users.supervisor), 403);
  await rejects(() => applyService(ticket.id, { version: 1 }, users.admin), 400);
  const before = await purchaseAssignmentSummary(users.admin);
  const priorOld = before.channels.find((row) => row.channel === '旧渠道')?.count || 0;
  const priorNew = before.channels.find((row) => row.channel === '新渠道')?.count || 0;
  await apply(ticket.id, { version: 1, targetChannels: ['新渠道'] }, users.buyer);
  await purchase.reload();
  assert.equal(purchase.purchaseStatus, null);
  assert.equal(purchase.purchaseConfirmedAt, null);
  const after = await purchaseAssignmentSummary(users.admin);
  assert.equal(after.channels.find((row) => row.channel === '旧渠道')?.count || 0, priorOld - 1);
  assert.equal(after.channels.find((row) => row.channel === '新渠道')?.count || 0, priorNew + 1);
  const stored = await Ticket.findByPk(ticket.id);
  assert.equal(stored.executedBefore.purchaseStatus, '采购成功（未出跟踪号）');
  assert.equal(stored.executedAfter.purchaseStatus, null);
});

test('主管和运营不能分配渠道或修改备注，原值随旧表单发送可保留，主管采购状态权限不变', async () => {
  const { item, purchase } = await fixture('notes-permission');
  await purchase.update({ purchaseNote: '原采购备注' });
  for (const user of [users.operator, users.supervisor]) {
    await rejects(
      () =>
        assignItems(
          { items: [{ id: item.id, version: item.version }], purchaseChannel: ['新渠道'] },
          user,
        ),
      403,
    );
    await rejects(
      () =>
        updateFollowupNote(
          { items: [{ id: item.id, version: item.version }], mode: 'append', followupNote: '越权' },
          user,
        ),
      403,
    );
    for (const [key, value] of [
      ['purchaseChannel', ['新渠道']],
      ['purchaseNote', '越权'],
      ['followupNote', null],
    ])
      await rejects(
        () =>
          editItem(
            item.id,
            {
              version: item.version,
              baseFields: { [key]: purchase[key] },
              fields: { [key]: value },
            },
            user,
          ),
        403,
      );
  }
  await editItem(
    item.id,
    {
      version: item.version,
      baseFields: {
        purchaseNote: '原采购备注',
        followupNote: '不得覆盖',
        purchaseChannel: ['旧渠道'],
      },
      fields: { purchaseNote: '原采购备注', followupNote: '不得覆盖', purchaseChannel: ['旧渠道'] },
    },
    users.supervisor,
  );
  await item.reload();
  await editItem(
    item.id,
    {
      version: item.version,
      baseFields: { purchaseStatus: '采购中' },
      fields: { purchaseStatus: '采购失败' },
    },
    users.supervisor,
  );
  await purchase.reload();
  assert.equal(purchase.purchaseNote, '原采购备注');
  assert.equal(purchase.purchaseStatus, '采购失败');
  await item.reload();
  await updateFollowupNote(
    { items: [{ id: item.id, version: item.version }], mode: 'append', followupNote: '采购回复' },
    users.buyer,
  );
  assert.equal((await purchase.reload()).followupNote, '不得覆盖\n采购回复');
});

test('导出复用订单完整字段且同商品去重，连续两次变更保留实际前后值，权限与筛选一致', async () => {
  const { item, purchase } = await fixture('history-export');
  await purchase.update({ purchaseStatus: '采购失败', merchantName: '商家甲' });
  const first = await create(
    input(item, { purchaseFields: { merchantName: '商家乙' } }),
    users.operator,
  );
  await apply(first.id, { version: 1, targetChannels: ['新渠道'] }, users.buyer);
  await status(
    first.id,
    { status: 'completed', version: await currentVersion(first.id) },
    users.operator,
  );
  await item.reload();
  await purchase.update({ purchaseStatus: '采购中' });
  const second = await create(
    input(item, { purchaseFields: { merchantName: '商家丙' } }),
    users.operator,
  );
  await apply(second.id, { version: 1, targetChannels: ['备用渠道'] }, users.admin);
  const headers = sessions.admin;
  const response = await fetch(base + '/channel-change-tickets/export', {
    method: 'POST',
    headers,
    body: JSON.stringify({ filters: { q: 'history-export' } }),
  });
  assert.equal(response.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const main = workbook.getWorksheet('订单明细'),
    history = workbook.getWorksheet('渠道变更历史');
  assert.equal(workbook.worksheets[0].name, '订单明细');
  assert.equal(main.rowCount, 2, '同一商品只导出一条当前订单');
  assert.equal(history.rowCount, 3, '两次已确认变更均保留');
  const titles = history.getRow(1).values;
  const cell = (row, label) => history.getRow(row).getCell(titles.indexOf(label)).value ?? null;
  assert.equal(cell(2, '变更前·采购渠道'), '旧渠道');
  assert.equal(cell(2, '变更后·采购渠道'), '新渠道');
  assert.equal(cell(3, '变更前·采购渠道'), '新渠道');
  assert.equal(cell(3, '变更后·采购渠道'), '备用渠道');
  assert.equal(cell(2, '变更前·采购商家名'), '商家甲');
  assert.equal(cell(2, '变更后·采购商家名'), '商家乙');
  assert.equal(cell(3, '变更后·采购商家名'), '商家丙');
  assert.equal(cell(2, '变更前·采购状态'), '采购失败');
  assert.equal(cell(2, '变更后·采购状态'), '');
  const denied = await fetch(base + '/channel-change-tickets/export', {
    method: 'POST',
    headers: sessions.other,
    body: JSON.stringify({ filters: { q: 'history-export' } }),
  });
  assert.equal(denied.status, 400);
  const unmatched = await fetch(base + '/channel-change-tickets/export', {
    method: 'POST',
    headers,
    body: JSON.stringify({ filters: { q: 'history-export', shopNames: ['other'] } }),
  });
  assert.equal(unmatched.status, 400);
  const stream = new PassThrough();
  stream.setHeader = () => {};
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  const done = finished(stream);
  await exportOrders({ filters: { q: 'history-export' } }, stream, false, { user: users.admin });
  await done;
  const normal = new ExcelJS.Workbook();
  await normal.xlsx.load(Buffer.concat(chunks));
  assert.deepEqual(normal.getWorksheet('订单明细').getRow(1).values, main.getRow(1).values);
  assert.equal(normal.getWorksheet('渠道变更历史').rowCount, 3);
});

test('批量确认跨页工单共用单条规则，清空状态、记录历史，底部包含普通分配且权限一致', async () => {
  const tickets = [];
  for (let i = 0; i < 21; i++) {
    const { item, purchase } = await fixture(`batch-pages-${i}`);
    await purchase.update({
      purchaseStatus: '采购成功（未出跟踪号）',
      purchaseConfirmedAt: new Date(),
    });
    tickets.push(
      await create(
        input(item, { purchaseFields: { merchantName: `批量商家${i}` } }),
        users.operator,
      ),
    );
  }
  const first = await list({ q: 'batch-pages-', page: 1, pageSize: 20 }, users.buyer);
  const second = await list({ q: 'batch-pages-', page: 2, pageSize: 20 }, users.buyer);
  assert.equal(first.total, 21);
  assert.equal(second.rows.length, 1);
  const chosen = [first.rows[0], second.rows[0]];
  const response = await fetch(base + '/channel-change-tickets/batch-apply', {
    method: 'POST',
    headers: sessions.buyer,
    body: JSON.stringify({
      items: chosen.map(({ id, version }) => ({ id, version })),
      targetChannels: ['新渠道', '备用渠道'],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, 2);
  for (const row of chosen) {
    const ticket = await Ticket.findByPk(row.id);
    const purchase = await Purchase.findOne({ where: { itemId: ticket.itemId } });
    assert.equal(purchase.purchaseStatus, null);
    assert.equal(purchase.purchaseConfirmedAt, null);
    assert.ok(purchase.purchaseAssignedAt);
    assert.equal(purchase.merchantName, ticket.targetPurchase.merchantName);
    assert.equal(ticket.executedBefore.purchaseStatus, '采购成功（未出跟踪号）');
    assert.equal(ticket.executedAfter.purchaseStatus, null);
    assert.deepEqual(ticket.executedAfter.purchaseChannel, ['新渠道', '备用渠道']);
    assert.equal(await Record.count({ where: { ticketId: ticket.id, kind: 'applied' } }), 1);
  }
  const plain = await fixture('batch-summary-plain');
  await DictionaryOption.create({ kind: 'purchaseChannel', value: '普通分配渠道' });
  await assignItems(
    {
      items: [{ id: plain.item.id, version: plain.item.version }],
      purchaseChannel: ['普通分配渠道'],
    },
    users.buyer,
  );
  for (const role of ['admin', 'operator', 'other']) {
    const response = await fetch(base + '/orders/purchase-assignment-summary', {
      headers: sessions[role],
    });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.deepEqual(summary.channels, (await purchaseAssignmentSummary(users[role])).channels);
    assert.equal(
      summary.channels.find((entry) => entry.channel === '普通分配渠道')?.count || 0,
      role === 'other' ? 0 : 1,
    );
  }
});

test('批量确认后项冲突整批回滚，订单、成功时间、工单及执行历史均不部分保存', async () => {
  const a = await fixture('batch-rollback-a'),
    b = await fixture('batch-rollback-b');
  await a.purchase.update({
    purchaseStatus: '采购成功（未出跟踪号）',
    purchaseConfirmedAt: new Date(),
  });
  const ta = await create(
    input(a.item, { purchaseFields: { merchantName: '不应写入' } }),
    users.operator,
  );
  const tb = await create(input(b.item), users.operator);
  await b.purchase.update({ purchaseChannel: ['外部变更'] });
  const before = (await a.purchase.reload()).toJSON();
  await rejects(
    () =>
      batchApply(
        {
          items: [
            { id: tb.id, version: 1 },
            { id: ta.id, version: 1 },
          ],
          targetChannels: ['新渠道'],
        },
        users.buyer,
      ),
    409,
  );
  assert.deepEqual((await a.purchase.reload()).toJSON(), before);
  assert.equal((await a.item.reload()).version, 1);
  assert.equal((await Ticket.findByPk(ta.id)).appliedAt, null);
  assert.equal((await Ticket.findByPk(ta.id)).executedAfter, null);
  assert.equal(await Record.count({ where: { ticketId: ta.id, kind: 'applied' } }), 0);
});

test('批量接口拒绝主管运营、重复或超量输入、关闭已执行及WFS工单，版本冲突不能覆盖', async () => {
  const f = await fixture('batch-validation');
  const ticket = await create(input(f.item), users.operator);
  const body = { items: [{ id: ticket.id, version: 1 }], targetChannels: ['新渠道'] };
  for (const name of ['supervisor', 'operator']) {
    const response = await fetch(base + '/channel-change-tickets/batch-apply', {
      method: 'POST',
      headers: sessions[name],
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
  }
  for (const items of [
    [],
    Array(501).fill(body.items[0]),
    [body.items[0], body.items[0]],
    [{ id: 'bad', version: 1 }],
  ])
    await rejects(() => batchApply({ ...body, items }, users.admin), 400);
  await rejects(() => batchApply({ ...body, targetChannels: ['停用渠道'] }, users.admin), 400);
  await rejects(
    () => batchApply({ ...body, items: [{ id: ticket.id, version: 999 }] }, users.admin),
    409,
  );
  await f.item.update({ fulfillmentParty: 'WFSFulfilled' });
  await rejects(() => batchApply(body, users.admin), 403);
  await f.item.update({ fulfillmentParty: 'SellerFulfilled' });
  await status(ticket.id, { status: 'completed', version: 1 }, users.operator);
  await rejects(
    () => batchApply({ ...body, items: [{ id: ticket.id, version: 2 }] }, users.admin),
    409,
  );
  await status(ticket.id, { status: 'open', version: 2 }, users.operator);
  await batchApply({ ...body, items: [{ id: ticket.id, version: 3 }] }, users.admin);
  const saved = (await f.purchase.reload()).toJSON();
  await rejects(
    () => batchApply({ ...body, items: [{ id: ticket.id, version: 4 }] }, users.admin),
    409,
  );
  assert.deepEqual((await f.purchase.reload()).toJSON(), saved);
  assert.equal(await Record.count({ where: { ticketId: ticket.id, kind: 'applied' } }), 1);
});
