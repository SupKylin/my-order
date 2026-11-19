import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import {
  db,
  User,
  Store,
  Order,
  OrderItem,
  Purchase,
  DictionaryOption,
  Upload,
  PurchaseAfterSale,
  ImportJob,
  AuditLog,
} from '../src/models.js';
import { migratePurchaseCost } from '../src/migrations/purchase-cost.js';
import { migrateProfit } from '../src/migrations/profit.js';
import { saveDictionaryOption } from '../src/services/dictionaries.js';
import { editItem, getItem, listOrders, upsertImported } from '../src/services/orders.js';
import { prepareImport, commitImport } from '../src/services/imports.js';
import { exportRow, exportOrders } from '../src/services/order-export.js';
import { PassThrough } from 'node:stream';
import { snapshotSource } from '../src/services/home/snapshot-source.js';
import { enrichSellerRefunds } from '../src/services/seller-refund.js';
import { fieldMap } from '../src/fields.js';
import { saveStore } from '../src/services/stores.js';
import { readHome } from '../src/services/home/index.js';
import { StoreSnapshot } from '../src/services/home/model.js';
import { excelDir } from '../src/services/storage.js';
import { savePurchaseRefundAmount } from '../src/services/purchase-after-sales.js';
import { templatePayload } from '../src/services/templates.js';

const isolated = /^my_order_cost_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
let connection,
  created = false,
  actor,
  operator,
  outsider;
const files = [];
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
  actor = await User.create({
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    passwordHash: 'test',
  });
  operator = await User.create({
    username: 'op',
    displayName: '运营',
    role: 'operations',
    passwordHash: 'test',
  });
  outsider = await User.create({
    username: 'other',
    displayName: '其他运营',
    role: 'operations',
    passwordHash: 'test',
  });
  await Store.create({ systemStoreName: 'OWN', walmartStoreName: 'OWN', ownerId: operator.id });
});
after(async () => {
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
  for (const file of files) await fs.rm(file, { force: true });
});
async function channel(value, tax = '1.08') {
  return saveDictionaryOption('purchaseChannel', null, {
    value,
    active: true,
    sortOrder: 0,
    fbaChannelExchangeRate: '1',
    fbaCurrentExchangeRate: '1',
    fbaTaxMultiplier: tax,
    fbmChannelExchangeRate: '1',
    fbmCurrentExchangeRate: '1',
    fbmTaxMultiplier: tax,
  });
}
async function item(channels, extra = {}) {
  const key = randomUUID();
  const order = await Order.create({ orderNumber: key });
  const row = await OrderItem.create({
    orderId: order.id,
    shopName: 'OWN',
    walmartSku: key,
    purchaseChannelKey: key,
    fulfillmentParty: 'SellerFulfilled',
    orderAmount: '100',
    tax: '0',
    walmart: { orderDate: Date.parse('2026-11-02T00:00:00-08:00'), statuses: ['Acknowledged'] },
  });
  await Purchase.create({
    itemId: row.id,
    allocatable: '是',
    purchaseChannel: channels,
    purchaseAmount: '100',
    shippingMode: 'FBA',
    ...extra,
  });
  return row;
}
// 仅向隔离测试库写入官方报表缓存，走真实的关联和读取链路。
async function officialRefund(row, net) {
  const store = await Store.findOne({ where: { systemStoreName: row.shopName } });
  const order = await Order.findByPk(row.orderId);
  const lines = row.returnInfo.lines.map((line) => ({
    ...line,
    sku: line.sku || row.walmartSku,
    purchaseOrderId: line.purchaseOrderId || `PO-${row.id}`,
    completedAt: line.completedAt || '2026-11-03T12:00:00Z',
  }));
  await row.update({ returnInfo: { ...row.returnInfo, lines } });
  const gross = lines.reduce((total, line) => total + Number(line.amount), 0);
  const previous = await StoreSnapshot.findByPk(store.id);
  const priorRows = previous?.remote?.reconciliation?.reports?.['11172026']?.sellerRefundRows || [];
  const snapshot = {
    storeId: store.id,
    sourceKey: snapshotSource(store),
    snapshotDate: '2026-11-17',
    measuredAt: new Date(),
    metrics: {},
    remote: {
      reconciliation: {
        version: 2,
        status: 'ok',
        availableDates: ['11172026'],
        reports: {
          11172026: {
            start: '2026-10-01',
            end: '2026-11-15',
            financeFormat: 2,
            sellerRefundVersion: 1,
            refunds: [],
            postedRefunds: [],
            sellerRefundRows: [
              ...priorRows.filter((r) => r.order !== order.orderNumber),
              ...[
                ['price', String(-gross), true],
                ['credits', String(gross - Number(net)), false],
              ].map(([type, amount, customer]) => ({
                transaction: `TX-${row.id}`,
                order: order.orderNumber,
                sku: lines[0].sku,
                po: lines[0].purchaseOrderId,
                type,
                amount,
                customer,
              })),
            ],
          },
        },
      },
    },
  };
  await StoreSnapshot.upsert(snapshot);
}
async function edit(row, patch, user = actor) {
  const current = await getItem(row.id, actor);
  const baseFields = Object.fromEntries(Object.keys(patch).map((key) => [key, current[key]]));
  for (const key of [
    'settlement',
    'purchaseAmount',
    'purchaseCostChannel',
    'purchaseChannel',
    'purchaseDiscount',
    'shippingMode',
  ])
    baseFields[key] = current[key];
  return editItem(row.id, { version: current.version, fields: patch, baseFields }, user);
}
async function preview(rows, user = actor) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('采购');
  sheet.addRow(keys.map((key) => fieldMap[key].label));
  for (const row of rows) sheet.addRow(keys.map((key) => row[key] ?? null));
  const id = randomUUID();
  await fs.mkdir(excelDir, { recursive: true });
  const filename = `${id}.xlsx`;
  const file = path.join(excelDir, filename);
  files.push(file);
  await workbook.xlsx.writeFile(file);
  await Upload.create({
    id,
    filename,
    originalName: '结算测试.xlsx',
    kind: 'excel',
    uploadedBy: user.id,
  });
  return prepareImport(
    {
      sources: [
        {
          uploadId: id,
          sheetName: '采购',
          template: {
            name: '结算测试',
            headerRow: 1,
            mappings: keys.map((key) => ({ header: fieldMap[key].label, field: key })),
          },
        },
      ],
    },
    user,
    'purchase',
  );
}
async function identity(row) {
  const data = await getItem(row.id, actor);
  return { shopName: data.shopName, orderNumber: data.orderNumber, walmartSku: data.walmartSku };
}

test('增量迁移可重跑，历史订单及已结算成本保持空值', async () => {
  const row = await item([], { settlement: '已结算' });
  const query = db.getQueryInterface();
  for (const key of ['purchaseCostChannel', 'purchaseDiscount', 'purchaseCost'])
    await query.removeColumn('purchases', key);
  for (const key of [
    'channelExchangeRate',
    'currentExchangeRate',
    'taxMultiplier',
    'purchaseDiscount',
  ])
    await query.removeColumn('dictionary_options', key);
  for (let i = 0; i < 2; i++) {
    await migratePurchaseCost('dictionary_options');
    await migratePurchaseCost('purchases');
  }
  const data = await edit(row, { purchaseAmount: '90', followupNote: '历史保持' });
  assert.equal(data.purchaseCost, null);
  assert.equal(data.purchaseDiscount, null);
  assert.equal(data.settlement, '已结算');
});

test('渠道配置保存、精度校验；单渠道结算自动存快照，改配置不重算，金额修改用旧折扣', async () => {
  const option = await channel('单渠道');
  await assert.rejects(
    saveDictionaryOption('purchaseChannel', option.id, {
      value: option.value,
      sortOrder: 0,
      active: true,
      version: option.version,
      fbaChannelExchangeRate: '1.001',
      fbaCurrentExchangeRate: '1',
      fbaTaxMultiplier: '1',
    }),
    /2位小数/,
  );
  const row = await item([option.value]);
  let data = await edit(row, { settlement: '已结算' });
  assert.equal(data.purchaseCostChannel, option.value);
  assert.equal(data.purchaseDiscount, '1.0800');
  assert.equal(data.purchaseCost, '108.00');
  await saveDictionaryOption('purchaseChannel', option.id, {
    value: option.value,
    active: true,
    sortOrder: 0,
    version: option.version,
    fbaChannelExchangeRate: '1',
    fbaCurrentExchangeRate: '1',
    fbaTaxMultiplier: '2',
  });
  data = await edit(row, { purchaseAmount: '200' });
  assert.equal(data.purchaseCost, '216.00');
  assert.equal(data.purchaseDiscount, '1.0800');
  assert.deepEqual(
    exportRow(
      await OrderItem.findByPk(row.id, { include: [{ model: Purchase, as: 'purchase' }] }),
      [{ key: 'purchaseDiscount' }, { key: 'purchaseCost' }],
    ),
    ['1.0800', '216.00'],
  );
  data = await edit(row, { settlement: '未结算' });
  assert.equal(data.purchaseCost, null);
  assert.equal(data.purchaseDiscount, null);
  data = await edit(row, { settlement: '已结算' });
  assert.equal(data.purchaseDiscount, '2.0000');
  assert.equal(data.purchaseCost, '400.00');
});

test('多渠道须选择；配置缺失、金额无效、错误渠道均回滚，WFS和越权仍禁止', async () => {
  await channel('多A', '1.05');
  await channel('多B', '1.10');
  const row = await item(['多A', '多B']);
  await assert.rejects(edit(row, { settlement: '已结算' }), /成本计算渠道/);
  await assert.rejects(edit(row, { settlement: '已结算', purchaseCostChannel: '其他' }), /已分配/);
  await assert.rejects(
    edit(row, { settlement: '已结算', purchaseCostChannel: '多B', purchaseAmount: '待定' }),
    /采购金额/,
  );
  assert.equal((await getItem(row.id, actor)).settlement, null);
  const data = await edit(row, { settlement: '已结算', purchaseCostChannel: '多B' }, operator);
  assert.equal(data.purchaseCost, '110.00');
  await assert.rejects(edit(row, { purchaseAmount: '20' }, outsider), /无权/);
  await row.update({ fulfillmentParty: 'WFS' });
  await assert.rejects(edit(row, { purchaseAmount: '20' }), /WFS/);
  const missing = await item(['无配置']);
  await assert.rejects(edit(missing, { settlement: '已结算' }), /采购折扣/);
});

test('采购导入与编辑同规则；重复导入保持折扣，系统成本列忽略，未匹配订单跳过', async () => {
  await channel('导入', '1.03');
  const row = await item(['导入']);
  const keys = await identity(row);
  let job = await preview([
    { ...keys, settlement: '已结算', purchaseAmount: '120', purchaseCost: '999' },
    {
      shopName: 'OWN',
      orderNumber: '不存在',
      walmartSku: '不存在',
      settlement: '已结算',
      purchaseAmount: '待定',
    },
  ]);
  assert.equal(job.blockingErrorCount, 0);
  assert.ok(job.warnings.some((entry) => entry.field === 'purchaseCost'));
  let result = await commitImport(job.id, actor, 'purchase');
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.equal((await getItem(row.id, actor)).purchaseCost, '123.60');
  const option = await DictionaryOption.findOne({
    where: { kind: 'purchaseChannel', value: '导入' },
  });
  await option.update({ fbaPurchaseDiscount: '2' });
  job = await preview([{ ...keys, settlement: '已结算', purchaseAmount: '120' }]);
  await commitImport(job.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).purchaseDiscount, '1.0300');
  job = await preview([{ ...keys, purchaseAmount: '200' }]);
  await commitImport(job.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).purchaseCost, '206.00');
});

test('导入预览校验多渠道选择，同单多行按顺序计算；提交重新检查配置，失败整批回滚', async () => {
  const a = await channel('文件A', '1.1');
  await channel('文件B', '1.2');
  const row = await item(['文件A', '文件B']);
  const keys = await identity(row);
  let job = await preview([{ ...keys, settlement: '已结算' }]);
  assert.equal(job.blockingErrorCount, 1);
  assert.match(job.errors[0].message, /成本计算渠道/);
  job = await preview([
    { ...keys, purchaseCostChannel: '文件B' },
    { ...keys, settlement: '已结算', purchaseAmount: '50' },
  ]);
  assert.equal(job.blockingErrorCount, 0);
  await commitImport(job.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).purchaseCost, '60.00');
  const first = await item(['文件B']);
  const second = await item(['文件A']);
  job = await preview([
    { ...(await identity(first)), settlement: '已结算' },
    { ...(await identity(second)), settlement: '已结算' },
  ]);
  await a.update({ active: false });
  await assert.rejects(commitImport(job.id, actor, 'purchase'), /第.*行.*采购折扣/);
  assert.equal((await getItem(first.id, actor)).settlement, null);
});

test('平台重复同步不触碰成本；编辑计算依赖被他人更改时提示冲突', async () => {
  await channel('同步', '1.07');
  const row = await item(['同步']);
  await edit(row, { settlement: '已结算' });
  const original = await getItem(row.id, actor);
  await db.transaction(async (transaction) =>
    upsertImported(
      { ...(await identity(row)), orderAmount: '500' },
      transaction,
      actor,
      await row.reload(),
      { walmartSync: true },
    ),
  );
  assert.equal((await getItem(row.id, actor)).purchaseCost, '107.00');
  const before = await getItem(row.id, actor);
  await edit(row, { settlement: '未结算' });
  await assert.rejects(
    editItem(
      row.id,
      {
        version: before.version,
        fields: { purchaseAmount: '50' },
        baseFields: {
          purchaseAmount: before.purchaseAmount,
          settlement: before.settlement,
          purchaseCostChannel: before.purchaseCostChannel,
          purchaseDiscount: before.purchaseDiscount,
          purchaseChannel: before.purchaseChannel,
          shippingMode: before.shippingMode,
        },
      },
      actor,
    ),
    /字段已发生变化/,
  );
  assert.equal(original.purchaseDiscount, '1.0700');
});

test('旧配置一次性复制到FBA/FBM，重新迁移不覆盖调整或清空，历史费率留空', async () => {
  const legacy = await DictionaryOption.create({
    kind: 'purchaseChannel',
    value: '迁移旧配置',
    channelExchangeRate: '7',
    currentExchangeRate: '7.2',
    taxMultiplier: '1.08',
    purchaseDiscount: '1.05',
  });
  await migrateProfit('dictionary_options');
  await legacy.reload();
  assert.equal(Number(legacy.fbaPurchaseDiscount), 1.05);
  assert.equal(Number(legacy.fbmPurchaseDiscount), 1.05);
  await legacy.update({ fbaPurchaseDiscount: null, fbmPurchaseDiscount: '0.9' });
  await migrateProfit('dictionary_options');
  await migrateProfit('stores');
  await migrateProfit('purchases');
  await legacy.reload();
  assert.equal(legacy.fbaPurchaseDiscount, null);
  assert.equal(Number(legacy.fbmPurchaseDiscount), 0.9);
  assert.equal((await Store.findOne({ where: { systemStoreName: 'OWN' } })).commissionRate, null);
});

test('发货模式按各自折扣结算；已结算切换模式重新取折扣，模式为空不允许结算', async () => {
  const option = await channel('模式折扣', '0.8');
  await option.update({ fbmPurchaseDiscount: '0.9' });
  const row = await item([option.value]);
  let data = await edit(row, { settlement: '已结算' });
  assert.equal(data.purchaseCost, '80.00');
  data = await edit(row, { shippingMode: 'FBM' });
  assert.equal(data.purchaseDiscount, '0.9000');
  assert.equal(data.purchaseCost, '90.00');
  await assert.rejects(edit(row, { shippingMode: null }), /发货模式/);
  const missing = await item([option.value], { shippingMode: null });
  await assert.rejects(edit(missing, { settlement: '已结算' }), /发货模式/);
  const fileItem = await item([option.value]);
  const job = await preview([
    {
      ...(await identity(fileItem)),
      settlement: '已结算',
      shippingMode: 'FBM',
      purchaseAmount: '20',
    },
  ]);
  assert.equal(job.blockingErrorCount, 0);
  await commitImport(job.id, actor, 'purchase');
  assert.equal((await getItem(fileItem.id, actor)).purchaseCost, '18.00');
});

test('佣金手动校验，结算费率固定；金额/模式调整沿用费率，重新结算才取新费率', async () => {
  const store = await Store.findOne({ where: { systemStoreName: 'OWN' } });
  const input = () => ({
    walmartStoreName: store.walmartStoreName,
    systemStoreName: store.systemStoreName,
    version: store.version,
  });
  for (const rate of ['-1', '100.01', '15.001', '15%', true])
    await assert.rejects(saveStore(store.id, { ...input(), commissionRate: rate }, actor), /佣金/);
  await saveStore(store.id, { ...input(), commissionRate: '15' }, actor);
  await store.reload();
  const option = await channel('利润费率', '0.8');
  const row = await item([option.value]);
  let data = await edit(row, { settlement: '已结算' });
  assert.equal(data.commissionRate, '15.00');
  assert.equal(data.commissionAmount, '15.00');
  assert.equal(data.orderProfit, '5.00');
  await saveStore(store.id, { ...input(), commissionRate: '20' }, actor);
  data = await edit(row, { purchaseAmount: '90', shippingMode: 'FBM' });
  assert.equal(data.commissionRate, '15.00');
  assert.equal(data.purchaseCost, '72.00');
  assert.equal(data.orderProfit, '13.00');
  await assert.rejects(edit(row, { commissionRate: '0' }), /不能手工修改/);
  data = await edit(row, { settlement: '未结算' });
  assert.equal(data.commissionRate, null);
  data = await edit(row, { settlement: '已结算' });
  assert.equal(data.commissionRate, '20.00');
  assert.equal(data.orderProfit, '8.00');
  const exported = exportRow(
    await OrderItem.findByPk(row.id, { include: [{ model: Purchase, as: 'purchase' }] }),
    [{ key: 'commissionRate' }, { key: 'commissionAmount' }, { key: 'orderProfit' }],
  );
  assert.deepEqual(exported, ['20.00', '20.00', '8.00']);
  const history = await item([option.value], {
    settlement: '已结算',
    purchaseDiscount: '0.8',
    purchaseCost: '80',
  });
  assert.equal((await edit(history, { purchaseAmount: '90' })).orderProfit, null);
});

test('导入结算同样固定费率，忽略利润/佣金列；店铺周月统计遵守账号、日期筛选', async () => {
  const store = await Store.findOne({ where: { systemStoreName: 'OWN' } });
  await store.update({ commissionRate: '12' });
  const option = await channel('导入利润', '0.5');
  const row = await item([option.value]);
  let job = await preview([
    {
      ...(await identity(row)),
      settlement: '已结算',
      purchaseAmount: '100',
      commissionRate: '0',
      orderProfit: '999',
    },
  ]);
  assert.equal(job.blockingErrorCount, 0);
  assert.ok(job.warnings.some((w) => w.field === 'commissionRate'));
  await commitImport(job.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).orderProfit, '38.00');
  await store.update({ commissionRate: '25' });
  job = await preview([{ ...(await identity(row)), settlement: '已结算', purchaseAmount: '100' }]);
  await commitImport(job.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).commissionRate, '12.00');
  const query = {
    scope: 'summary',
    storeIds: [store.id],
    startDate: '2026-11-01',
    endDate: '2026-11-07',
  };
  const report = await readHome(operator, Date.parse('2026-11-07T12:00:00-08:00'), query);
  assert.ok(report.profit.week.rows.length === 2);
  assert.ok(report.profit.month.rows[0].calculatedItems > 0);
  assert.ok(report.profit.month.rows[0].uncomputedItems > 0);
  assert.ok(report.profit.week.rows.every((r) => r.storeId === store.id));
  const denied = await readHome(outsider, Date.parse('2026-11-07T12:00:00-08:00'), query);
  assert.equal(denied.profit.month.rows.length, 0);
});

test('争议成功金额：四角色可手填，校验两位精度、版本冲突、店铺权限及WFS只读', async () => {
  const row = await item([], { settlement: '已结算', commissionRate: '15', purchaseCost: '70' });
  const supervisor = await User.create({
    username: 'refund-supervisor',
    displayName: '主管',
    role: 'supervisor',
    passwordHash: 'test',
  });
  const purchasing = await User.create({
    username: 'refund-purchasing',
    displayName: '采购',
    role: 'purchasing',
    passwordHash: 'test',
  });
  for (const user of [actor, operator, supervisor, purchasing]) {
    await edit(row, { disputeSuccessAmount: '2.03' }, user);
    assert.equal((await getItem(row.id, user)).disputeSuccessAmount, '2.03');
    await edit(row, { disputeSuccessAmount: null }, user);
  }
  await edit(row, { disputeSuccessAmount: '0' });
  assert.equal((await getItem(row.id, actor)).disputeSuccessAmount, '0.00');
  const before = await getItem(row.id, actor);
  for (const value of ['-1', '1.001', 'abc', ['3']])
    await assert.rejects(edit(row, { disputeSuccessAmount: value }), /字段校验/);
  await edit(row, { disputeSuccessAmount: '5.12' });
  await assert.rejects(
    editItem(
      row.id,
      {
        version: before.version,
        fields: { disputeSuccessAmount: '6' },
        baseFields: { disputeSuccessAmount: before.disputeSuccessAmount },
      },
      actor,
    ),
    /发生变化/,
  );
  await assert.rejects(edit(row, { disputeSuccessAmount: '7' }, outsider));
  await row.update({ fulfillmentParty: 'WFS' });
  await assert.rejects(edit(row, { disputeSuccessAmount: '8' }), /WFS/);
  assert.equal((await getItem(row.id, actor)).disputeSuccessAmount, '5.12');
  const audit = await AuditLog.findOne({
    where: { action: 'edit_item', entityId: String(row.id) },
    order: [['id', 'DESC']],
  });
  assert.ok(audit.details.fields.includes('disputeSuccessAmount'));
});

test('退款争议：真实关联金额、工单保存和列表导出利润一致，原采购成本费率不变', async () => {
  const row = await item([], {
    settlement: '已结算',
    commissionRate: '15',
    purchaseCost: '70',
    disputeSuccessAmount: '2.03',
  });
  await row.update({
    returnInfo: {
      statuses: ['已退款'],
      lines: [
        {
          returnOrderId: 'R1',
          lineNumber: '1',
          status: '已退款',
          refundStatus: 'REFUND_COMPLETED',
          amount: '10.01',
          currency: 'USD',
        },
      ],
    },
  });
  await officialRefund(row, '10.01');
  const ticket = await PurchaseAfterSale.create({
    itemId: row.id,
    createdBy: actor.id,
    creatorName: actor.displayName,
    lastActivityAt: new Date(),
    status: 'open',
  });
  assert.equal((await getItem(row.id, actor)).orderProfit, null);
  await savePurchaseRefundAmount(
    ticket.id,
    { version: ticket.version, purchaseRefundAmount: '5.12' },
    operator,
  );
  const data = await getItem(row.id, actor);
  assert.equal(data.walmartRefundAmount, '10.01');
  assert.equal(data.purchaseRefundAmount, '5.12');
  assert.equal(data.orderProfit, '12.14');
  assert.deepEqual(
    exportRow(
      (
        await enrichSellerRefunds([
          await OrderItem.findByPk(row.id, {
            include: (await import('../src/models.js')).itemInclude,
          }),
        ])
      )[0],
      [
        { key: 'walmartRefundAmount' },
        { key: 'purchaseRefundAmount' },
        { key: 'disputeSuccessAmount' },
        { key: 'orderProfit' },
      ],
    ),
    ['10.01', '5.12', '2.03', '12.14'],
  );
  for (const key of ['walmartRefundAmount', 'purchaseRefundAmount'])
    await assert.rejects(edit(row, { [key]: '99' }), /不能手工修改|不支持的字段/);
  const purchase = await Purchase.findOne({ where: { itemId: row.id } });
  assert.equal(Number(purchase.purchaseCost), 70);
  assert.equal(Number(purchase.commissionRate), 15);
  await savePurchaseRefundAmount(
    ticket.id,
    {
      version: data.purchaseAfterSale.version ?? (await ticket.reload()).version,
      purchaseRefundAmount: null,
    },
    actor,
  );
  assert.equal((await getItem(row.id, actor)).orderProfit, null);
});

test('退款争议：采购Excel与旧预览均忽略三金额，普通字段照常更新', async () => {
  const row = await item([], { disputeSuccessAmount: '6.12' });
  const job = await preview([
    {
      ...(await identity(row)),
      purchaseNote: '正常导入',
      disputeSuccessAmount: 'bad',
      walmartRefundAmount: '100',
      purchaseRefundAmount: '200',
    },
  ]);
  assert.equal(job.blockingErrorCount, 0);
  for (const key of ['disputeSuccessAmount', 'walmartRefundAmount', 'purchaseRefundAmount'])
    assert.ok(job.warnings.some((w) => w.field === key));
  await commitImport(job.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).disputeSuccessAmount, '6.12');
  assert.equal((await getItem(row.id, actor)).purchaseNote, '正常导入');
  const old = await preview([{ ...(await identity(row)), purchaseNote: '旧预览' }]);
  const saved = await ImportJob.findByPk(old.id);
  await saved.update({
    rows: saved.rows.map((r) => ({
      ...r,
      patch: {
        ...r.patch,
        disputeSuccessAmount: '999',
        walmartRefundAmount: '999',
        purchaseRefundAmount: '999',
      },
    })),
  });
  await commitImport(old.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).disputeSuccessAmount, '6.12');
  assert.equal((await getItem(row.id, actor)).purchaseNote, '旧预览');
  const only = await preview([{ ...(await identity(row)), disputeSuccessAmount: '88' }]);
  assert.equal(only.blockingErrorCount, 0);
  assert.equal(only.rows[0].action, 'missing');
  const template = await templatePayload({
    name: '仅手工金额',
    headerRow: 1,
    mappings: [
      { header: '订单号', field: 'orderNumber' },
      { header: '争议成功金额', field: 'disputeSuccessAmount' },
    ],
  });
  assert.equal(template.mappings[1].field, '');
});

test('退款争议：周月汇总关联退款按原下单日期，权限和自有三方分组不变', async () => {
  const store = await Store.create({
    systemStoreName: 'REFUND-STATS',
    walmartStoreName: 'R',
    ownerId: operator.id,
    isThirdParty: true,
  });
  const row = await item([], {
    settlement: '已结算',
    commissionRate: '15',
    purchaseCost: '70',
    disputeSuccessAmount: '3',
  });
  await row.update({
    shopName: store.systemStoreName,
    returnInfo: {
      lines: [
        { returnOrderId: 'R2', lineNumber: '1', status: '已退款', amount: '10', currency: 'USD' },
      ],
    },
  });
  await PurchaseAfterSale.create({
    itemId: row.id,
    createdBy: actor.id,
    creatorName: actor.displayName,
    lastActivityAt: new Date(),
    status: 'open',
    purchaseRefundAmount: '2',
  });
  await officialRefund(row, '10');
  const query = {
    scope: 'summary',
    storeIds: [store.id],
    startDate: '2026-11-01',
    endDate: '2026-11-07',
  };
  const report = await readHome(operator, Date.parse('2026-11-07T12:00:00-08:00'), query);
  for (const period of ['week', 'month']) {
    const total = report.profit[period].totals.find((r) => r.isThirdParty);
    assert.equal(total.orderProfit, '10.00');
    assert.equal(total.walmartRefundAmount, '10.00');
    assert.equal(total.purchaseRefundAmount, '2.00');
    assert.equal(total.disputeSuccessAmount, '3.00');
    assert.equal(total.calculatedItems, 1);
  }
  const denied = await readHome(outsider, Date.parse('2026-11-07T12:00:00-08:00'), query);
  assert.equal(denied.profit.month.rows.length, 0);
  await PurchaseAfterSale.update({ purchaseRefundAmount: null }, { where: { itemId: row.id } });
  const refreshed = await readHome(operator, Date.parse('2026-11-07T12:00:00-08:00'), query);
  assert.equal(refreshed.profit.month.totals[1].uncomputedItems, 1);
  assert.equal(refreshed.profit.month.totals[1].orderProfit, null);
});

test('当前店铺佣金仅供详情参考，权限内查询和导出不改变未结算及历史快照', async () => {
  const store = await Store.findOne({ where: { systemStoreName: 'OWN' } });
  const priorRate = store.commissionRate;
  try {
    await store.update({ commissionRate: '12' });
    const row = await item(['展示参考'], { purchaseAmount: null, shippingMode: 'FBM' });
    const purchase = await Purchase.findOne({ where: { itemId: row.id } });
    const before = purchase.toJSON();
    const data = await getItem(row.id, operator);
    assert.equal(data.storeCommissionRate, '12.00');
    assert.equal(data.commissionRate, null);
    assert.equal(data.purchaseDiscount, null);
    assert.equal(data.purchaseCost, null);
    assert.equal(data.orderProfit, null);
    assert.equal(data.profitMessage, '尚未结算');
    const listed = await listOrders({ q: data.orderNumber }, operator);
    assert.equal(listed.rows[0].storeCommissionRate, '12.00');
    assert.equal((await listOrders({ q: data.orderNumber }, outsider)).total, 0);
    await assert.rejects(getItem(row.id, outsider), /无权/);
    await purchase.reload();
    assert.deepEqual(purchase.toJSON(), before);
    assert.deepEqual(
      exportRow({ ...(await row.reload()).toJSON(), store: store.toJSON(), purchase: before }, [
        { key: 'commissionRate' },
        { key: 'purchaseDiscount' },
        { key: 'orderProfit' },
      ]),
      ['', '', ''],
    );
    const history = await item(['展示参考'], {
      settlement: '已结算',
      commissionRate: '10',
      purchaseDiscount: '0.7',
      purchaseCost: '70',
    });
    await store.update({ commissionRate: '25' });
    const settled = await getItem(history.id, operator);
    assert.equal(settled.storeCommissionRate, '25.00');
    assert.equal(settled.commissionRate, '10.00');
    assert.equal(settled.purchaseDiscount, '0.7000');
    assert.equal(settled.orderProfit, '20.00');
    const missing = await item(['展示参考'], { settlement: '已结算' });
    assert.equal((await getItem(missing.id, operator)).commissionRate, null);
  } finally {
    await store.update({ commissionRate: priorRate });
  }
});

test('退款争议：增量列历史留空，重复迁移不改手填及结算数据', async () => {
  const row = await item([], { settlement: '已结算', commissionRate: '15', purchaseCost: '70' });
  const purchase = await Purchase.findOne({ where: { itemId: row.id } });
  const originalCount = await Purchase.count();
  // 仅在专用临时测试库模拟升级前结构。
  await db.getQueryInterface().removeColumn('purchases', 'disputeSuccessAmount');
  await migrateProfit('purchases');
  await purchase.reload();
  assert.equal(await Purchase.count(), originalCount);
  assert.equal(purchase.disputeSuccessAmount, null);
  const columns = await db.getQueryInterface().describeTable('purchases');
  assert.equal(columns.sellerRefundManualAmount, undefined);
  assert.equal(columns.sellerRefundBasis, undefined);
  await purchase.update({ disputeSuccessAmount: '12.34' });
  await migrateProfit('purchases');
  await migrateProfit('purchases');
  await purchase.reload();
  assert.equal(purchase.disputeSuccessAmount, '12.34');
  assert.equal(Number(purchase.purchaseCost), 70);
  assert.equal(Number(purchase.commissionRate), 15);
  assert.equal(
    (await db.getQueryInterface().describeTable('purchases')).disputeSuccessAmount.type,
    'DECIMAL(18,2)',
  );
});

test('净扣款：四角色均不可手改或清空官方字段，旧手工字段拒绝，Excel不覆盖', async () => {
  const row = await item([], { settlement: '已结算', commissionRate: '15', purchaseCost: '70' });
  await row.update({
    returnInfo: {
      lines: [
        {
          returnOrderId: 'NET-R',
          lineNumber: '1',
          status: '已退款',
          amount: '20',
          currency: 'USD',
        },
      ],
    },
  });
  assert.equal((await getItem(row.id, actor)).walmartRefundAmount, null);
  await officialRefund(row, '18.01');
  for (const user of [
    actor,
    operator,
    await User.findOne({ where: { role: 'supervisor' } }),
    await User.findOne({ where: { role: 'purchasing' } }),
  ]) {
    for (const value of ['18.01', null])
      await assert.rejects(edit(row, { walmartRefundAmount: value }, user), /不能手工修改/);
    await assert.rejects(edit(row, { sellerRefundManualAmount: '99' }, user), /不支持的字段/);
    const data = await getItem(row.id, user);
    assert.equal(data.walmartRefundAmount, '18.01');
    assert.equal(data.orderProfit, '-3.01');
    for (const key of [
      'sellerRefundManualAmount',
      'sellerRefundBasis',
      'refundBasisToken',
      'sellerRefundManualStale',
    ])
      assert.equal(Object.hasOwn(data, key), false);
  }
  await assert.rejects(getItem(row.id, outsider), /无权/);
  const current = await getItem(row.id, actor);
  const workbook = await preview([
    {
      shopName: 'OWN',
      orderNumber: current.orderNumber,
      walmartSku: current.walmartSku,
      walmartRefundAmount: '99',
      followupNote: '只读官方净额不覆盖',
    },
  ]);
  await commitImport(workbook.id, actor, 'purchase');
  assert.equal((await getItem(row.id, actor)).walmartRefundAmount, '18.01');
  assert.equal((await getItem(row.id, actor)).followupNote, '只读官方净额不覆盖');
  await row.update({
    returnInfo: {
      lines: [...row.returnInfo.lines, { ...row.returnInfo.lines[0], returnOrderId: 'NEW-REFUND' }],
    },
  });
  const pending = await getItem(row.id, actor);
  assert.equal(pending.walmartRefundAmount, null);
  assert.equal(pending.orderProfit, null);
});

test('净扣款：报表在详情/列表/完整Excel/周月汇总生效，错店铺凭据缓存不采用', async () => {
  const store = await Store.create({
    systemStoreName: 'NET-SHOP',
    walmartStoreName: 'N',
    ownerId: operator.id,
  });
  const row = await item([], {
    settlement: '已结算',
    commissionRate: '12',
    purchaseCost: '70',
    disputeSuccessAmount: '88.58',
  });
  await row.update({
    shopName: store.systemStoreName,
    orderAmount: '197.96',
    returnInfo: {
      lines: [
        {
          returnOrderId: 'NR1',
          lineNumber: '1',
          status: '已退款',
          amount: '104.42',
          currency: 'USD',
          purchaseOrderId: 'NPO',
          sku: row.walmartSku,
          completedAt: '2026-11-11T17:29:15Z',
        },
      ],
    },
  });
  assert.equal((await getItem(row.id, actor)).walmartRefundAmount, null);
  const current = await getItem(row.id, actor);
  const snapshot = await StoreSnapshot.create({
    storeId: store.id,
    sourceKey: snapshotSource(store),
    snapshotDate: '2026-11-17',
    measuredAt: new Date(),
    metrics: {},
    remote: {
      reconciliation: {
        version: 2,
        status: 'ok',
        availableDates: ['11172026'],
        reports: {
          11172026: {
            start: '2026-11-01',
            end: '2026-11-15',
            financeFormat: 2,
            sellerRefundVersion: 1,
            refunds: [],
            postedRefunds: [],
            sellerRefundRows: [
              ['price', '-104.42', true],
              ['credits', '15.84', false],
            ].map(([type, amount, customer]) => ({
              transaction: 'NET-TX',
              order: current.orderNumber,
              sku: row.walmartSku,
              po: 'NPO',
              type,
              amount,
              customer,
            })),
          },
        },
      },
    },
  });
  assert.equal((await getItem(row.id, operator)).orderProfit, '104.20');
  const listed = await listOrders({ q: current.orderNumber }, operator);
  assert.equal(listed.rows[0].walmartRefundAmount, '88.58');
  assert.equal(Object.hasOwn(listed.rows[0], 'customerRefundAmount'), false);
  assert.equal(Object.hasOwn(listed.rows[0], 'walmartRefundSource'), false);
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.setHeader = () => {};
  stream.locals = {};
  await exportOrders({ filters: { q: current.orderNumber } }, stream, false, { user: operator });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.concat(chunks));
  const sheet = book.worksheets[0],
    headers = sheet.getRow(1).values;
  assert.equal(headers.filter((header) => header === 'Walmart退款金额').length, 1);
  assert.equal(sheet.getRow(2).getCell(headers.indexOf('Walmart退款金额')).value, '88.58');
  assert.equal(headers.includes('Walmart退款净额来源'), false);
  const report = await readHome(operator, Date.parse('2026-11-17T12:00:00-08:00'), {
    scope: 'summary',
    storeIds: [store.id],
    startDate: '2026-11-01',
    endDate: '2026-11-17',
  });
  for (const period of ['week', 'month']) {
    assert.equal(report.profit[period].totals[0].orderProfit, '104.20');
    assert.equal(report.profit[period].totals[0].walmartRefundAmount, '88.58');
  }
  await snapshot.update({ sourceKey: 'old-credentials' });
  assert.equal((await getItem(row.id, actor)).walmartRefundAmount, null);
  assert.equal((await getItem(row.id, actor)).orderProfit, null);
});
