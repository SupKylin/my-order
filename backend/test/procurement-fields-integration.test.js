import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { db, User, Purchase, OrderItem, Upload, RiskAddress } from '../src/models.js';
import { WalmartReceipt } from '../src/services/walmart/models.js';
import { createItem, getItem, editItem, listOrders } from '../src/services/orders.js';
import { saveRiskAddress, deleteRiskAddress } from '../src/services/risk-addresses.js';
import { saveDictionaryOption, getFieldDefinitions } from '../src/services/dictionaries.js';
import { migrateDictionaries } from '../src/migrations.js';
import { migrateProcurementFields } from '../src/migrations/procurement-fields.js';
import { backfillWalmartCommercialFields } from '../src/migrations/walmart-commercial-fields.js';
import { backfillWalmartProductImages } from '../src/migrations/walmart-product-images.js';
import { addressKey } from '../src/lib/address-key.js';
import { exportOrders, purchaseTemplateColumns } from '../src/services/order-export.js';
import { workbookInfo } from '../src/lib/excel/workbook.js';
import { prepareImport, commitImport } from '../src/services/imports.js';
import { uploadPath, ensureStorage } from '../src/services/storage.js';
import { persistOrder } from '../src/services/walmart/persistence.js';

// 本测试仅操作显式指定的一次性数据库，绝不清理用户业务库。
const isolated = /^my_order_procurement_test_[0-9]+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection,
  created = false,
  actor;
const files = [];
const address = {
  address1: '10 Test Road',
  address2: 'Apt 2',
  city: 'Test City',
  state: 'CA',
  postalCode: '90001',
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
  await migrateDictionaries();
  await ensureStorage();
  actor = await User.create({
    username: 'procurement-test',
    displayName: '测试账号',
    role: 'admin',
    passwordHash: 'not-for-login',
  });
});
after(async () => {
  await db.close();
  for (const file of files) await fs.rm(file, { force: true });
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});
const makeItem = (orderNumber, extra = {}) =>
  createItem(
    {
      fields: {
        orderNumber,
        shopName: '测试店铺',
        walmartSku: '00001',
        quantity: 2,
        ...address,
        ...extra,
      },
    },
    actor,
  );

test('平台字典、新采购字段及截图可编辑，历史字典值保留且新填停用值被拒绝', async () => {
  const option = await saveDictionaryOption('purchasePlatform', null, {
    value: '其他平台',
    active: true,
    sortOrder: 2,
  });
  const image = `/uploads/images/${randomUUID()}.webp`;
  const item = await makeItem('FIELDS', {
    purchasePlatform: option.value,
    shippingMode: 'FBA',
    afterSalesResult: '已结束',
    afterSalesResultScreenshot: image,
  });
  assert.equal(item.afterSalesResultScreenshot, image);
  assert.equal(item.shippingMode, 'FBA');
  await saveDictionaryOption('purchasePlatform', option.id, {
    value: '平台新名称',
    active: true,
    sortOrder: 2,
    version: option.version,
  });
  const updated = await editItem(
    item.id,
    { version: item.version, fields: { orderNumber: 'FIELDS', purchasePlatform: '其他平台' } },
    actor,
  );
  assert.equal(updated.purchasePlatform, '其他平台');
  await assert.rejects(makeItem('INVALID', { purchasePlatform: '其他平台' }), /字段校验/);
  const definition = (await getFieldDefinitions()).find(
    (field) => field.key === 'purchasePlatform',
  );
  assert.deepEqual(definition.options, ['Amazon', 'Ebay', '平台新名称']);
});

test('风险地址匹配忽略大小写和多余空格，维护实时影响新旧订单，地址二不同不误标', async () => {
  const old = await makeItem('RISK-OLD');
  assert.equal(old.addressRisk, false);
  const risk = await saveRiskAddress(
    null,
    { ...address, address1: '  10   TEST Road ', note: '测试风险' },
    actor,
  );
  assert.equal((await getItem(old.id)).addressRisk, true);
  assert.equal((await makeItem('RISK-NEW')).addressRiskNote, '测试风险');
  assert.equal((await makeItem('RISK-DIFFERENT', { address2: 'Apt 3' })).addressRisk, false);
  await assert.rejects(saveRiskAddress(null, address, actor), /已经存在/);
  await assert.rejects(saveRiskAddress(null, { ...address, city: '' }, actor), /请填写/);
  const changed = await saveRiskAddress(
    risk.id,
    { ...address, address2: 'Apt 3', version: risk.version },
    actor,
  );
  assert.equal((await getItem(old.id)).addressRisk, false);
  const matches = await listOrders({ orderNumbers: 'RISK-DIFFERENT' });
  assert.equal(matches.rows[0].addressRisk, true);
  await assert.rejects(deleteRiskAddress(risk.id, risk.version, actor), /已被修改/);
  await deleteRiskAddress(changed.id, changed.version, actor);
  assert.equal((await listOrders({ orderNumbers: 'RISK-DIFFERENT' })).rows[0].addressRisk, false);
  await assert.rejects(
    editItem(
      old.id,
      { version: old.version, fields: { orderNumber: 'RISK-OLD', address2: 'Apt 4' } },
      actor,
    ),
    /商品信息只能由 Walmart/,
  );
  const raw = await OrderItem.findByPk(old.id);
  assert.equal(raw.addressKey, addressKey(address));
});

test('商品字段人工只读，采购字段可修改，Walmart 同步覆盖图片并可清空', async () => {
  const url = 'https://i5.walmartimages.com/official-product.jpeg';
  const raw = {
    purchaseOrderId: 'IMAGE-API-PO',
    customerOrderId: 'IMAGE-API',
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'IMAGE-SKU', productName: '官方商品', imageUrl: url },
          orderLineQuantity: { amount: '2' },
        },
      ],
    },
  };
  const store = { id: 778, systemStoreName: '测试店铺' };
  await persistOrder(store, raw, new Map(), actor);
  let saved = (await listOrders({ orderNumbers: 'IMAGE-API' })).rows[0];
  assert.equal((await OrderItem.findByPk(saved.id)).productImage, url);
  for (const fields of [
    { productName: '人工改名' },
    { quantity: 3 },
    { productImage: `/uploads/images/${randomUUID()}.webp` },
    { productImage: null },
    { walmartSku: 'OTHER' },
  ]) {
    await assert.rejects(
      editItem(
        saved.id,
        { version: saved.version, fields: { orderNumber: 'IMAGE-API', ...fields } },
        actor,
      ),
      /商品信息只能由 Walmart/,
    );
  }
  saved = await editItem(
    saved.id,
    {
      version: saved.version,
      fields: {
        orderNumber: 'IMAGE-API',
        productImage: url,
        productName: saved.productName,
        quantity: saved.quantity,
        purchaseNote: '采购备注可编辑',
      },
    },
    actor,
  );
  assert.equal(saved.productImage, url);
  assert.equal(saved.purchaseNote, '采购备注可编辑');
  const legacyImage = `/uploads/images/${randomUUID()}.webp`;
  await OrderItem.update({ productImage: legacyImage }, { where: { id: saved.id } });
  await persistOrder(store, raw, new Map(), actor);
  assert.equal((await getItem(saved.id)).productImage, legacyImage);
  await OrderItem.update({ productImage: url }, { where: { id: saved.id } });
  delete raw.orderLines.orderLine[0].item.imageUrl;
  await persistOrder(store, raw, new Map(), actor);
  assert.equal((await getItem(saved.id)).productImage, null);
  assert.equal((await getItem(saved.id)).purchaseNote, '采购备注可编辑');
});

test('历史快照只回填空图片，保留人工图片且可幂等重跑', async () => {
  const url = 'https://i5.walmartimages.com/backfill.jpeg';
  const a = await makeItem('IMAGE-BACKFILL-A', {
    productImage: `/uploads/images/${randomUUID()}.webp`,
  });
  const b = await makeItem('IMAGE-BACKFILL-B', {
    productImage: `/uploads/images/${randomUUID()}.webp`,
  });
  const c = await makeItem('IMAGE-BACKFILL-C');
  await OrderItem.update(
    { walmart: { imageUrl: url, commercialMappingVersion: 1 } },
    { where: { id: a.id } },
  );
  await OrderItem.update({ walmart: { commercialMappingVersion: 1 } }, { where: { id: b.id } });
  await OrderItem.update(
    { walmart: { imageUrl: url, commercialMappingVersion: 1 } },
    { where: { id: c.id } },
  );
  assert.equal(await backfillWalmartProductImages(), 1);
  assert.equal((await getItem(a.id)).productImage, a.productImage);
  assert.equal((await getItem(b.id)).productImage, b.productImage);
  assert.equal((await getItem(a.id)).version, a.version);
  assert.equal((await getItem(c.id)).productImage, url);
  assert.equal((await getItem(c.id)).version, c.version + 1);
  assert.equal(await backfillWalmartProductImages(), 0);
});

async function exportWorkbook(filters, purchaseTemplate = false) {
  const response = new PassThrough();
  response.setHeader = () => {};
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  const done = finished(response);
  await exportOrders({ filters, ids: [999999] }, response, purchaseTemplate);
  await done;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  return workbook;
}

test('未分配筛选仅匹配 NULL 和空串，两类导出遵循复合筛选并忽略分页与勾选', async () => {
  const a = await makeItem('EXPORT-A', { allocatable: null });
  const b = await makeItem('EXPORT-B');
  await Purchase.update({ allocatable: '' }, { where: { itemId: b.id } });
  await makeItem('EXPORT-C', { allocatable: '是' });
  await makeItem('EXPORT-D', { allocatable: '否' });
  await makeItem('EXPORT-E', { shopName: '其他店铺' });
  const filters = {
    q: 'EXPORT-',
    shopNames: ['测试店铺'],
    allocatable: 'empty',
    page: 1,
    pageSize: 1,
  };
  const listed = await listOrders(filters);
  assert.equal(listed.total, 2);
  assert.equal(listed.rows.length, 1);
  for (const kind of [true, false]) {
    const workbook = await exportWorkbook(filters, kind);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 3);
    const headers = sheet.getRow(1).values;
    assert.deepEqual(
      [2, 3].map((row) => sheet.getRow(row).getCell(headers.indexOf('订单号')).value).sort(),
      ['EXPORT-A', 'EXPORT-B'],
    );
    if (kind)
      assert.deepEqual(
        headers.slice(1),
        purchaseTemplateColumns.map((column) => column.header),
      );
  }
  assert.ok(a.id);
});

test('采购模板选项与真实数据库维护一致，停用平台不再可选且历史值仍导出', async () => {
  const option = await saveDictionaryOption('purchasePlatform', null, {
    value: '测试,采购平台',
    active: true,
    sortOrder: 3,
  });
  await makeItem('EXPORT-DROPDOWNS', { purchasePlatform: option.value });
  await saveDictionaryOption('purchasePlatform', option.id, {
    value: option.value,
    active: false,
    sortOrder: option.sortOrder,
    version: option.version,
  });
  const workbook = await exportWorkbook({ orderNumbers: 'EXPORT-DROPDOWNS' }, true);
  const sheet = workbook.worksheets[0];
  const options = workbook.getWorksheet('_purchase_options');
  const definitions = await getFieldDefinitions();
  assert.equal(sheet.getCell('H2').value, option.value);
  for (const [key, column, source] of [
    ['purchasePlatform', 'H', 'A'],
    ['shippingMode', 'I', 'B'],
    ['allocatable', 'L', 'C'],
  ]) {
    const choices = definitions.find((field) => field.key === key).options;
    assert.deepEqual(
      choices.map((_, index) => options.getCell(`${source}${index + 2}`).value),
      choices,
    );
    const validation = sheet.getCell(`${column}2`).dataValidation;
    assert.deepEqual(validation.formulae, [`purchase_options_${key}`]);
    assert.equal(validation.errorStyle, 'stop');
    assert.equal(validation.showErrorMessage, true);
  }
  assert.ok(
    !definitions.find((field) => field.key === 'purchasePlatform').options.includes(option.value),
  );
});

test('截图模板填入采购信息后经真实 Excel 预览和提交更新三字段匹配订单，数量不覆盖', async () => {
  const item = await makeItem('0001234567890123456');
  const workbook = await exportWorkbook({ orderNumbers: '0001234567890123456' }, true);
  const sheet = workbook.worksheets[0],
    row = sheet.getRow(2);
  assert.equal(row.getCell(2).value, '0001234567890123456');
  assert.equal(row.getCell(3).value, '00001');
  row.getCell(4).value = 99;
  row.getCell(5).value = 'https://example.com/product';
  row.getCell(6).value = 'BUY-001';
  row.getCell(7).value = '0.12345678901234567890';
  row.getCell(8).value = 'Amazon';
  row.getCell(9).value = 'FBM';
  row.getCell(10).value = '采购商家';
  row.getCell(11).value = '10.50';
  row.getCell(12).value = '是';
  const info = workbookInfo(workbook);
  assert.equal(info.columns[8].suggestedField, 'shippingMode');
  const template = {
    name: '填写采购信息',
    sheetName: sheet.name,
    headerRow: 1,
    mappings: info.columns.map((column) => ({
      column: column.column,
      header: column.header,
      field: ['quantity', 'operationsNote'].includes(column.suggestedField)
        ? ''
        : column.suggestedField,
    })),
  };
  const id = randomUUID();
  const upload = await Upload.create({
    id,
    filename: `${id}.xlsx`,
    originalName: '采购模板.xlsx',
    kind: 'excel',
    uploadedBy: actor.id,
  });
  const path = uploadPath(upload);
  files.push(path);
  await workbook.xlsx.writeFile(path);
  const preview = await prepareImport({ sources: [{ uploadId: id, template }] }, actor, 'purchase');
  assert.equal(preview.errorCount, 0);
  assert.equal(preview.updated, 1);
  await commitImport(preview.id, actor, 'purchase');
  const saved = await getItem(item.id);
  assert.equal(saved.quantity, 2);
  assert.equal(saved.purchasePlatform, 'Amazon');
  assert.equal(saved.shippingMode, 'FBM');
  assert.equal(saved.purchaseSku, 'BUY-001');
  assert.equal(saved.purchaseLinkAmount, '0.1234567890123456789');
});

test('Walmart 订单进入系统自动标记风险，接口移除房号后重新匹配', async () => {
  const risk = await saveRiskAddress(null, { ...address }, actor);
  const raw = {
    purchaseOrderId: 'RISK-API-PO',
    customerOrderId: 'RISK-API',
    shipNode: { type: 'SellerFulfilled' },
    shippingInfo: { postalAddress: { ...address } },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'RISK-API-SKU' },
          orderLineQuantity: { amount: '1' },
          orderLineStatuses: { orderLineStatus: [{ status: 'Acknowledged' }] },
        },
      ],
    },
  };
  await persistOrder({ id: 777, systemStoreName: '测试店铺' }, raw, new Map(), actor);
  assert.equal((await listOrders({ orderNumbers: 'RISK-API' })).rows[0].addressRisk, true);
  delete raw.shippingInfo.postalAddress.address2;
  await persistOrder({ id: 777, systemStoreName: '测试店铺' }, raw, new Map(), actor);
  const saved = (await listOrders({ orderNumbers: 'RISK-API' })).rows[0];
  assert.equal(saved.addressRisk, false);
  assert.equal(saved.address2, null);
  await deleteRiskAddress(risk.id, risk.version, actor);
});

test('增量迁移保留采购数据，历史地址及官方金额履约方回填支持幂等重跑', async () => {
  const item = await makeItem('MIGRATION', { purchaseNote: '保留备注', orderAmount: '1.20' });
  await OrderItem.update(
    { walmart: { storeId: 111, purchaseOrderId: 'MIGRATION-PO' } },
    { where: { id: item.id } },
  );
  await WalmartReceipt.create({
    storeId: 111,
    purchaseOrderId: 'MIGRATION-PO',
    customerOrderId: 'MIGRATION',
    raw: {
      purchaseOrderId: 'MIGRATION-PO',
      customerOrderId: 'MIGRATION',
      shipNode: { type: 'SellerFulfilled' },
      orderLines: {
        orderLine: [
          {
            lineNumber: '1',
            item: { sku: '00001' },
            charges: {
              charge: [
                { chargeType: 'PRODUCT', chargeAmount: { amount: '1.20' } },
                { chargeType: 'SHIPPING', chargeAmount: { amount: '2.35' } },
              ],
            },
          },
        ],
      },
    },
  });
  await db.getQueryInterface().removeColumn('order_items', 'addressKey');
  await db.getQueryInterface().removeColumn('order_items', 'fulfillmentParty');
  await db.getQueryInterface().removeColumn('purchases', 'afterSalesResultScreenshot');
  await RiskAddress.drop();
  await migrateProcurementFields();
  await migrateProcurementFields();
  await backfillWalmartCommercialFields();
  await backfillWalmartCommercialFields();
  const saved = await getItem(item.id);
  assert.equal(saved.orderAmount, '3.55');
  assert.equal(saved.fulfillmentParty, 'SellerFulfilled');
  assert.equal(saved.purchaseNote, '保留备注');
  assert.equal(saved.version, item.version + 1);
  assert.equal((await OrderItem.findByPk(item.id)).addressKey, addressKey(address));
});
