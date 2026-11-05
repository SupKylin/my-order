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
} from '../src/models.js';
import { migratePurchaseCost } from '../src/migrations/purchase-cost.js';
import { saveDictionaryOption } from '../src/services/dictionaries.js';
import { editItem, getItem, upsertImported } from '../src/services/orders.js';
import { prepareImport, commitImport } from '../src/services/imports.js';
import { exportRow } from '../src/services/order-export.js';
import { fieldMap } from '../src/fields.js';
import { excelDir } from '../src/services/storage.js';

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
    channelExchangeRate: '1',
    currentExchangeRate: '1',
    taxMultiplier: tax,
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
  });
  await Purchase.create({
    itemId: row.id,
    allocatable: '是',
    purchaseChannel: channels,
    purchaseAmount: '100',
    ...extra,
  });
  return row;
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
      channelExchangeRate: '1.001',
      currentExchangeRate: '1',
      taxMultiplier: '1',
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
    channelExchangeRate: '1',
    currentExchangeRate: '1',
    taxMultiplier: '2',
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
  await option.update({ purchaseDiscount: '2' });
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
        },
      },
      actor,
    ),
    /字段已发生变化/,
  );
  assert.equal(original.purchaseDiscount, '1.0700');
});
