import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { config } from '../src/config.js';
import { db, User, Store, Purchase, OrderItem, Upload } from '../src/models.js';
import { migratePurchaseQuantity } from '../src/migrations/purchase-quantity.js';
import { persistOrder } from '../src/services/walmart/persistence.js';
import { getItem, editItem } from '../src/services/orders.js';
import { prepareImport, commitImport } from '../src/services/imports.js';
import { exportOrders } from '../src/services/order-export.js';
import { ensureStorage, uploadPath } from '../src/services/storage.js';
import { workbookInfo } from '../src/lib/excel/workbook.js';

// 只创建和删除本次指定的临时库，不操作业务数据库。
const isolated = /^my_order_quantity_test_[0-9]+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection,
  created = false,
  actor,
  store;
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
  await ensureStorage();
  actor = await User.create({
    username: 'quantity-test',
    displayName: '数量测试',
    role: 'admin',
    passwordHash: 'not-for-login',
  });
  store = await Store.create({ walmartStoreName: '数量测试店铺', systemStoreName: '数量测试店铺' });
});
after(async () => {
  await db.close();
  for (const file of files) await fs.rm(file, { force: true });
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});
function rawOrder(number, quantity = 3, fulfillment = 'SellerFulfilled') {
  return {
    purchaseOrderId: `PO-${number}`,
    customerOrderId: number,
    orderDate: Date.parse('2026-10-02T10:00:00Z'),
    shipNode: { type: fulfillment },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'Q-SKU', productName: '数量测试商品' },
          orderLineQuantity: { amount: String(quantity) },
          orderLineStatuses: { orderLineStatus: [{ status: 'Acknowledged' }] },
        },
      ],
    },
  };
}
async function sync(number, quantity = 3, fulfillment) {
  await persistOrder(store, rawOrder(number, quantity, fulfillment), new Map(), actor);
  const item = await OrderItem.findOne({
    where: { shopName: store.systemStoreName },
    include: [{ association: 'order', where: { orderNumber: number } }],
  });
  return getItem(item.id, actor);
}
async function edit(item, value, user = actor) {
  return editItem(
    item.id,
    {
      version: item.version,
      baseFields: { purchaseQuantity: item.purchaseQuantity },
      fields: { purchaseQuantity: value },
    },
    user,
  );
}
async function workbookFor(number) {
  const response = new PassThrough();
  response.setHeader = () => {};
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  const done = finished(response);
  await exportOrders({ filters: { orderNumbers: number } }, response, true, { user: actor });
  await done;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  return workbook;
}
async function preview(workbook, mapProduct = false) {
  const info = workbookInfo(workbook);
  const id = randomUUID();
  const upload = await Upload.create({
    id,
    filename: `${id}.xlsx`,
    originalName: '数量.xlsx',
    kind: 'excel',
    uploadedBy: actor.id,
  });
  const file = uploadPath(upload);
  files.push(file);
  await workbook.xlsx.writeFile(file);
  return prepareImport(
    {
      sources: [
        {
          uploadId: id,
          sheetName: info.sheetName,
          template: {
            name: '采购数量模板',
            headerRow: 1,
            mappings: info.columns.map((column) => ({
              header: column.header,
              field:
                column.suggestedField === 'operationsNote' ||
                (!mapProduct && column.suggestedField === 'quantity')
                  ? ''
                  : column.suggestedField,
            })),
          },
        },
      ],
    },
    actor,
    'purchase',
  );
}

test('新增可空列不回填历史订单；重复迁移和后续同步保留历史空值及人工值', async () => {
  const item = await sync('HISTORY');
  const query = db.getQueryInterface();
  await query.removeColumn('purchases', 'purchaseQuantity');
  await migratePurchaseQuantity();
  assert.equal((await getItem(item.id, actor)).purchaseQuantity, null);
  assert.equal((await sync('HISTORY', 4)).purchaseQuantity, null);
  await edit(await getItem(item.id, actor), 8);
  await migratePurchaseQuantity();
  assert.equal((await getItem(item.id, actor)).purchaseQuantity, 8);
});

test('新订单初始化采购数量；修改、清空后重复同步只更新商品数量', async () => {
  let item = await sync('NEW');
  assert.equal(item.quantity, 3);
  assert.equal(item.purchaseQuantity, 3);
  item = await edit(item, 7);
  assert.equal(item.quantity, 3);
  item = await sync('NEW', 5);
  assert.equal(item.quantity, 5);
  assert.equal(item.purchaseQuantity, 7);
  await edit(item, null);
  assert.equal((await sync('NEW', 6)).purchaseQuantity, null);
});

test('采购数量继承正整数校验，商品数量只读、WFS和店铺权限继续生效', async () => {
  let item = await sync('GUARDS');
  for (const invalid of [0, -1, 1.5, 1000001, 'abc'])
    await assert.rejects(edit(item, invalid), /字段校验/);
  item = await edit(item, '12');
  assert.equal(item.purchaseQuantity, 12);
  await assert.rejects(
    editItem(
      item.id,
      { version: item.version, baseFields: { quantity: 3 }, fields: { quantity: 4 } },
      actor,
    ),
    /商品信息只能由 Walmart/,
  );
  const wfs = await sync('WFS', 2, 'WFSFulfilled');
  assert.equal(wfs.purchaseQuantity, 2);
  await assert.rejects(edit(wfs, 4), /WFS/);
  const outsider = await User.create({
    username: 'quantity-outsider',
    displayName: '其他运营',
    role: 'operations',
    passwordHash: 'not-for-login',
  });
  await assert.rejects(edit(item, 4, outsider), (error) => error.status === 403);
});

test('采购填写导出保留双数量列，实际Excel往返只更新采购数量，空白保留原值', async () => {
  const item = await sync('EXCEL');
  const workbook = await workbookFor('EXCEL');
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values;
  const productColumn = headers.indexOf('商品数量');
  const purchaseColumn = headers.indexOf('采购数量');
  assert.equal(sheet.columnCount, 15);
  assert.equal(sheet.getCell(2, productColumn).value, 3);
  assert.equal(sheet.getCell(2, purchaseColumn).value, 3);
  sheet.getCell(2, productColumn).value = 99;
  sheet.getCell(2, purchaseColumn).value = 9;
  await assert.rejects(preview(workbook, true), /商品数量.*不属于采购导入字段/);
  let job = await preview(workbook);
  assert.equal(job.errorCount, 0);
  assert.equal((await getItem(item.id, actor)).purchaseQuantity, 3);
  await commitImport(job.id, actor, 'purchase');
  let saved = await getItem(item.id, actor);
  assert.equal(saved.quantity, 3);
  assert.equal(saved.purchaseQuantity, 9);
  sheet.getCell(2, purchaseColumn).value = null;
  job = await preview(workbook);
  await commitImport(job.id, actor, 'purchase');
  saved = await getItem(item.id, actor);
  assert.equal(saved.purchaseQuantity, 9);
  assert.equal(saved.quantity, 3);
});

test('采购数量导入沿用并发保护，Walmart商品数量变化不造成采购冲突', async () => {
  let item = await sync('CONCURRENT');
  const workbook = await workbookFor('CONCURRENT');
  const sheet = workbook.worksheets[0];
  sheet.getCell(2, sheet.getRow(1).values.indexOf('采购数量')).value = 7;
  let job = await preview(workbook);
  await edit(item, 8);
  await assert.rejects(commitImport(job.id, actor, 'purchase'), /预览后发生变化/);
  assert.equal((await getItem(item.id, actor)).purchaseQuantity, 8);
  job = await preview(workbook);
  await sync('CONCURRENT', 10);
  await commitImport(job.id, actor, 'purchase');
  item = await getItem(item.id, actor);
  assert.equal(item.quantity, 10);
  assert.equal(item.purchaseQuantity, 7);
});
