import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import {
  db,
  User,
  Order,
  OrderItem,
  Purchase,
  Upload,
  ImportJob,
  ImportTemplate,
  DictionaryOption,
  Store,
} from '../src/models.js';
import {
  getItem,
  editItem,
  assignItems,
  updateOrderStatus,
  listOrders,
} from '../src/services/orders.js';
import { persistOrder } from '../src/services/walmart/persistence.js';
import { exportOrders } from '../src/services/order-export.js';
import { Writable } from 'node:stream';
import express from 'express';
import { createOrdersRouter } from '../src/routes/orders.js';
import { createImportsRouter } from '../src/routes/imports.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { prepareImport, commitImport, getImportPreview } from '../src/services/imports.js';
import { templatePayload } from '../src/services/templates.js';
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
async function preview(rows, sourceKeys = keys) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(template.sheetName);
  sheet.addRow(sourceKeys);
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
  return prepareImport(
    {
      sources: [
        {
          uploadId: id,
          template: {
            ...template,
            mappings: sourceKeys.map((field, index) => ({
              column: index + 1,
              header: field,
              field,
            })),
          },
          sheetName: '采购',
        },
      ],
    },
    actor,
    'purchase',
  );
}

test('采购 Excel 提交时记录成功时间，重复成功保留，重新采购更新时间且预览不改库', async () => {
  const successStates = ['采购成功（未出跟踪号）', '采购成功（已出跟踪号）'];
  const nonSuccessStates = [null, '采购中', '采购失败', '取消订单', '采购成功（砍单）'];
  await DictionaryOption.bulkCreate(
    [...successStates, ...nonSuccessStates.filter(Boolean)].map((value) => ({
      kind: 'purchaseStatus',
      value,
    })),
  );
  const item = await createItem('SUCCESS-TIME');
  const purchase = await Purchase.findOne({ where: { itemId: item.id } });
  const importStatus = async (value) => {
    const job = await preview(
      [['店铺A', 'SUCCESS-TIME', '001', value]],
      ['shopName', 'orderNumber', 'walmartSku', 'purchaseStatus'],
    );
    assert.equal(job.errorCount, 0);
    return job;
  };
  for (const oldStatus of nonSuccessStates) {
    for (const newStatus of successStates) {
      await purchase.update({ purchaseStatus: oldStatus, purchaseConfirmedAt: null });
      const job = await importStatus(newStatus);
      await purchase.reload();
      assert.equal(purchase.purchaseConfirmedAt, null);
      const before = Date.now();
      assert.equal((await commitImport(job.id, actor, 'purchase')).updated, 1);
      await purchase.reload();
      assert.ok(
        +purchase.purchaseConfirmedAt >= before && +purchase.purchaseConfirmedAt <= Date.now(),
      );
      const first = +purchase.purchaseConfirmedAt;
      for (const status of [newStatus, ...successStates]) {
        await commitImport((await importStatus(status)).id, actor, 'purchase');
        await purchase.reload();
        assert.equal(+purchase.purchaseConfirmedAt, first);
      }
      await commitImport((await importStatus('采购失败')).id, actor, 'purchase');
      await purchase.reload();
      assert.equal(purchase.purchaseConfirmedAt, null);
    }
  }
  await purchase.update({
    purchaseStatus: successStates[1],
    purchaseConfirmedAt: new Date('2026-10-10T01:02:03Z'),
  });
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  stream.setHeader = () => {};
  await exportOrders({ filters: { orderNumbers: 'SUCCESS-TIME' } }, stream);
  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(Buffer.concat(chunks));
  const sheet = exported.worksheets[0];
  const column = sheet.getRow(1).values.indexOf('采购成功时间');
  assert.ok(column > 0);
  assert.equal(sheet.getRow(2).getCell(column).value, '2026-10-10 09:02:03');
});

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

test('采购预览跳过 WFS；提交时再次识别新变为 WFS 的行，普通订单继续且历史报告保留', async () => {
  const wfs = await createItem('WFS-SKIP');
  const changed = await createItem('WFS-CHANGED');
  const normal = await createItem('NORMAL-UPDATE');
  await wfs.update({ fulfillmentParty: 'WFSFulfilled' });
  const count = await OrderItem.count();
  const p = await preview([
    ['店铺A', 'WFS-SKIP', '001', '', '禁止更新'],
    ['店铺A', 'WFS-CHANGED', '001', '', '禁止更新'],
    ['店铺A', 'NORMAL-UPDATE', '001', '', '正常更新'],
    ['店铺A', 'NOT-FOUND', '001', '', '禁止新增'],
  ]);
  assert.equal(p.skipped, 2);
  assert.match(p.skippedRows.find((row) => row.orderNumber === 'WFS-SKIP').reason, /WFS/);
  await changed.update({ fulfillmentParty: ' wfs ', version: changed.version + 1 });
  const result = await commitImport(p.id, actor, 'purchase');
  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 3);
  assert.equal((await getImportPreview(p.id)).skipped, 3);
  assert.equal((await commitImport(p.id, actor, 'purchase')).skipped, 3);
  for (const item of [wfs, changed])
    assert.equal((await Purchase.findOne({ where: { itemId: item.id } })).purchaseNote, '原备注');
  assert.equal((await Purchase.findOne({ where: { itemId: normal.id } })).purchaseNote, '正常更新');
  assert.equal(await OrderItem.count(), count);
});

test('WFS 编辑和批量写入均拒绝，混合批次回滚；普通订单不允许改身份或履约方', async () => {
  await DictionaryOption.bulkCreate([
    { kind: 'purchaseChannel', value: '测试渠道' },
    { kind: 'orderStatus', value: '测试状态' },
  ]);
  const normal = await createItem('WRITABLE');
  const wfs = await createItem('READONLY');
  await wfs.update({ fulfillmentParty: 'WFSFulfilled' });
  const entries = [normal, wfs].map(({ id, version }) => ({ id, version }));
  assert.equal((await getItem(wfs.id)).manualEditable, false);
  assert.equal((await getItem(normal.id)).manualEditable, true);
  await assert.rejects(
    editItem(
      wfs.id,
      {
        version: wfs.version,
        fields: { orderNumber: 'READONLY', fulfillmentParty: 'SellerFulfilled' },
      },
      actor,
    ),
    /WFS/,
  );
  await assert.rejects(
    assignItems({ items: entries, purchaseChannel: ['测试渠道'] }, actor),
    /WFS/,
  );
  await assert.rejects(
    updateOrderStatus({ items: entries, orderStatus: '测试状态' }, actor),
    /WFS/,
  );
  await normal.reload();
  assert.equal(normal.version, entries[0].version);
  assert.equal(normal.orderStatus, null);
  assert.equal((await Purchase.findOne({ where: { itemId: normal.id } })).purchaseChannel, null);
  for (const fields of [
    { orderNumber: 'NEW-ORDER' },
    { orderNumber: 'WRITABLE', shopName: '改店铺' },
    { orderNumber: 'WRITABLE', fulfillmentParty: 'WFS' },
  ])
    await assert.rejects(
      editItem(normal.id, { version: normal.version, fields }, actor),
      /Walmart/,
    );
  assert.equal(await Order.count({ where: { orderNumber: 'NEW-ORDER' } }), 0);
  await editItem(
    normal.id,
    { version: normal.version, fields: { orderNumber: 'WRITABLE', purchaseNote: '允许更新' } },
    actor,
  );
  assert.equal((await Purchase.findOne({ where: { itemId: normal.id } })).purchaseNote, '允许更新');
});

test('履约方筛选兼容两种 WFS 值，列表分页、预警统计和导出使用相同条件', async () => {
  const rows = await OrderItem.findAll({ where: { fulfillmentParty: ['WFSFulfilled', ' wfs '] } });
  for (const row of rows) {
    await row.update({ platformShipDate: '2026-10-10' });
    await Purchase.update({ priceFactor: '0.7' }, { where: { itemId: row.id } });
  }
  const filters = { fulfillmentParty: 'WFS', priceFactorLevel: 'low', pageSize: 1 };
  const result = await listOrders(filters);
  assert.equal(result.total, 3);
  assert.equal(result.rows.length, 1);
  assert.equal(
    result.shippingDates.reduce((sum, row) => sum + row.count, 0),
    3,
  );
  assert.ok(result.rows.every((row) => !row.manualEditable));
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  stream.setHeader = () => {};
  await exportOrders({ filters }, stream, true);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  assert.equal(workbook.worksheets[0].rowCount - 1, 3);
});

test('所有角色的 HTTP 新增、旧导入及删除入口拒绝，不能通过隐藏入口修改数据', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor;
    next();
  });
  app.use(createOrdersRouter());
  app.use('/imports', createImportsRouter());
  app.use(errorHandler);
  const server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const before = await OrderItem.count();
  try {
    for (const [method, path] of [
      ['POST', '/orders'],
      ['DELETE', '/orders/1'],
      ['POST', '/orders/batch-delete'],
      ['POST', '/imports/orders/preview'],
      ['POST', '/imports/preview'],
      ['POST', '/imports/orders/old/commit'],
      ['POST', '/imports/old/commit'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403, path);
    }
    assert.equal(await OrderItem.count(), before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('官方同步仍可创建和更新 WFS 订单', async () => {
  const store = await Store.create({ walmartStoreName: 'WFS-Test', systemStoreName: 'WFS-Test' });
  const remote = {
    purchaseOrderId: 'WFS-PO',
    customerOrderId: 'WFS-CUSTOMER',
    shipNode: { type: 'WFSFulfilled' },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'WFS-SKU', productName: '官方商品' },
          orderLineQuantity: { amount: '1' },
          orderLineStatuses: { orderLineStatus: [{ status: 'Acknowledged' }] },
        },
      ],
    },
  };
  assert.equal((await persistOrder(store, remote, new Map(), actor)).added, 1);
  remote.orderLines.orderLine[0].item.productName = '官方更新';
  assert.equal((await persistOrder(store, remote, new Map(), actor)).updated, 1);
  const item = await OrderItem.findOne({ where: { shopName: 'WFS-Test' } });
  assert.equal(item.productName, '官方更新');
  assert.equal((await getItem(item.id)).manualEditable, false);
});

test('旧模板解绑渠道与工作表，用户所选工作表生效，旧预览也不能覆盖渠道', async () => {
  const item = await createItem('SHEET-SELECT');
  await Purchase.update({ purchaseChannel: ['原有渠道'] }, { where: { itemId: item.id } });
  const workbook = new ExcelJS.Workbook();
  for (const [name, note] of [
    ['旧工作表', '不得导入'],
    ['本次工作表', '选定工作表的采购备注'],
  ]) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow([...keys, '渠道']);
    sheet.addRow(['店铺A', 'SHEET-SELECT', '001', '', note, '不存在的渠道']);
  }
  const id = randomUUID();
  const upload = await Upload.create({
    id,
    filename: `${id}.xlsx`,
    originalName: '多工作表.xlsx',
    kind: 'excel',
    uploadedBy: actor.id,
  });
  const filepath = uploadPath(upload);
  files.push(filepath);
  await workbook.xlsx.writeFile(filepath);
  const oldTemplate = await ImportTemplate.create({
    ...template,
    sheetName: '旧工作表',
    purchaseChannelId: 999999,
    mappings: [...template.mappings, { column: 6, header: '渠道', field: 'purchaseChannel' }],
  });
  const entry = { uploadId: id, templateId: oldTemplate.id };
  await assert.rejects(
    prepareImport({ sources: [entry] }, actor, 'purchase'),
    /请选择本次导入的工作表/,
  );
  await assert.rejects(
    prepareImport({ sources: [{ ...entry, sheetName: '不存在' }] }, actor, 'purchase'),
    /找不到工作表/,
  );
  const p = await prepareImport(
    { sources: [{ ...entry, sheetName: '本次工作表' }] },
    actor,
    'purchase',
  );
  assert.equal(p.errorCount, 0);
  assert.equal(p.rows[0].patch.purchaseNote, '选定工作表的采购备注');
  assert.equal(p.rows[0].patch.purchaseChannel, undefined);
  assert.equal(p.sources[0].sheetName, '本次工作表');
  // 模拟升级前的预览快照含渠道：提交边界必须再次阻止写入。
  const job = await ImportJob.findByPk(p.id);
  const rows = structuredClone(job.rows);
  rows[0].patch.purchaseChannel = ['旧预览渠道'];
  await job.update({ rows });
  await commitImport(p.id, actor, 'purchase');
  const purchase = await Purchase.findOne({ where: { itemId: item.id } });
  assert.deepEqual(purchase.purchaseChannel, ['原有渠道']);
  assert.equal(purchase.purchaseNote, '选定工作表的采购备注');
  const saved = await templatePayload(oldTemplate.toJSON());
  assert.equal(saved.sheetName, '');
  assert.equal(saved.purchaseChannelId, null);
  assert.equal(saved.mappings.at(-1).field, '');
  assert.equal(saved.mappings.at(-1).header, '渠道');
});
