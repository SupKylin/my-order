import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { db, User, Order, OrderItem, Purchase, Upload, ImportJob } from '../src/models.js';
import { prepareImport, commitImport, getImportPreview } from '../src/services/imports.js';
import { ensureStorage, uploadPath } from '../src/services/storage.js';
import { orderIdentityKey, channelKey, IMPORT_MATCH_RULE } from '../src/lib/order-identity.js';

// 仅在独立临时数据库执行集成测试，不操作业务库。
const isolated = /^my_order_purchase_test_[0-9]+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection,
  created = false,
  actor;
const files = [];
const keys = ['shopName', 'orderNumber', 'walmartSku', 'purchaseSku', 'purchaseNote'];
const template = {
  name: '采购测试',
  sheetName: '采购',
  headerRow: 1,
  mappings: keys.map((field, index) => ({ column: index + 1, header: field, field })),
};
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
  await ensureStorage();
  actor = await User.create({
    username: 'import-test',
    displayName: '测试',
    passwordHash: 'not-a-password',
    role: 'admin',
  });
});
after(async () => {
  await db.close();
  for (const file of files) await fs.rm(file, { force: true });
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});
async function createItem(orderNumber, walmartSku = '001', shopName = '店铺A') {
  const [order] = await Order.findOrCreate({ where: { orderNumber } });
  const patch = { shopName, walmartSku };
  const item = await OrderItem.create({
    ...patch,
    orderId: order.id,
    productName: '平台商品',
    platformOrderStatus: '已确认',
    orderIdentityKey: orderIdentityKey(patch),
    purchaseChannelKey: channelKey(null),
  });
  await Purchase.create({
    itemId: item.id,
    assignedTo: actor.id,
    purchaseSku: '原采购SKU',
    purchaseNote: '原备注',
  });
  return item;
}
async function preview(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(template.sheetName);
  sheet.addRow(keys);
  rows.forEach((row) => sheet.addRow(row));
  const id = randomUUID();
  const file = await Upload.create({
    id,
    filename: `${id}.xlsx`,
    originalName: '采购匹配测试.xlsx',
    kind: 'excel',
    uploadedBy: actor.id,
  });
  const filepath = uploadPath(file);
  files.push(filepath);
  await workbook.xlsx.writeFile(filepath);
  return prepareImport({ sources: [{ uploadId: id, template }] }, actor, 'purchase');
}

test('混合有效、未匹配、歧义及空店铺行只更新唯一目标；完整反馈及重复提交不新增', async () => {
  const item = await createItem('A');
  await createItem('DUP');
  await createItem('DUP');
  const countBefore = await OrderItem.count(),
    ordersBefore = await Order.count();
  const p = await preview([
    ['店铺A', 'A', '001', '', '第一行'],
    ['店铺A', 'A', '001', '新采购SKU', '最后一行'],
    ['店铺A', '不存在', '001', '', '跳过'],
    ['其他店铺', 'A', '001', '', '跳过'],
    ['店铺A', 'A', 'OTHER', '', '跳过'],
    ['店铺A', 'DUP', '001', '', '跳过'],
    ['', 'A', '001', '', '跳过'],
  ]);
  assert.equal(p.errorCount, 0);
  assert.equal(p.added, 0);
  assert.equal(p.updated, 2);
  assert.equal(p.skipped, 5);
  assert.match(p.skippedRows.find((row) => row.orderNumber === 'DUP').reason, /多|重复/);
  const result = await commitImport(p.id, actor, 'purchase');
  assert.equal(result.added, 0);
  assert.equal(result.updated, 2);
  assert.equal(result.skippedRows.length, 5);
  assert.equal(await OrderItem.count(), countBefore);
  assert.equal(await Order.count(), ordersBefore);
  await item.reload();
  assert.equal(item.productName, '平台商品');
  assert.equal(item.platformOrderStatus, '已确认');
  const purchase = await Purchase.findOne({ where: { itemId: item.id } });
  assert.equal(purchase.purchaseNote, '最后一行');
  assert.equal(purchase.purchaseSku, '新采购SKU');
  assert.equal(purchase.assignedTo, actor.id);
  const repeated = await commitImport(p.id, actor, 'purchase');
  assert.equal(repeated.alreadyCompleted, true);
  assert.deepEqual(repeated.skippedRows, result.skippedRows);
  assert.deepEqual((await getImportPreview(p.id)).skippedRows, result.skippedRows);
});

test('超过 100 行的未匹配清单完整返回，全未匹配仍可完成且不创建订单', async () => {
  const before = await Order.count();
  const p = await preview(
    Array.from({ length: 125 }, (_, index) => ['店铺A', `MISSING-${index}`, '001', '', '跳过']),
  );
  assert.equal(p.rows.length, 100);
  assert.equal(p.skippedRows.length, 125);
  const result = await commitImport(p.id, actor, 'purchase');
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 125);
  assert.equal(await Order.count(), before);
});

test('提交时目标删除或出现歧义则拒绝，不回退到新增；旧规则预览必须重做', async () => {
  const target = await createItem('CHANGED');
  const p = await preview([['店铺A', 'CHANGED', '001', '', '不得写入']]);
  await Purchase.destroy({ where: { itemId: target.id } });
  await target.destroy();
  await assert.rejects(commitImport(p.id, actor, 'purchase'), /变化|删除/);
  await createItem('AMBIGUOUS');
  const ambiguous = await preview([['店铺A', 'AMBIGUOUS', '001', '', '不得写入']]);
  await createItem('AMBIGUOUS');
  await assert.rejects(commitImport(ambiguous.id, actor, 'purchase'), /变化/);
  const job = await ImportJob.findByPk(ambiguous.id);
  await job.update({ templateSnapshot: { ...job.templateSnapshot, matchRule: IMPORT_MATCH_RULE } });
  await assert.rejects(commitImport(ambiguous.id, actor, 'purchase'), /匹配规则已更新/);
});
