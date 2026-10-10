import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { fields } from '../src/fields.js';
import { validateTemplate } from '../src/validation.js';
import { extractRows } from '../src/lib/excel/rows.js';
import { alignMappings, mappingIssues, suggestedMappings } from '../../frontend/src/mapping.js';

const mappings = [
  { header: '店铺名', field: 'shopName' },
  { header: '订单号', field: 'orderNumber' },
  { header: 'WalmartSku', field: 'walmartSku' },
  { header: '采购备注', field: 'purchaseNote' },
];
const template = { name: '仅按表头', headerRow: 1, sheetName: '采购', mappings };
async function loaded(headers, values, pictureColumn) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('采购');
  sheet.addRow(headers);
  sheet.addRow(values);
  if (pictureColumn !== undefined) {
    const imageId = workbook.addImage({
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1kAAAAASUVORK5CYII=',
        'base64',
      ),
      extension: 'png',
    });
    sheet.addImage(imageId, { tl: { col: pictureColumn, row: 1 }, ext: { width: 40, height: 40 } });
  }
  const bytes = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  return { workbook: restored, zip: await JSZip.loadAsync(bytes) };
}
const noPicture = async () => assert.fail('不应处理图片');

test('保存无需列号，旧列号丢弃，未选择系统字段的表头保留', () => {
  const input = {
    ...template,
    mappings: [...mappings.map((m) => ({ ...m, column: 9999 })), { header: '说明', field: '' }],
  };
  const saved = validateTemplate(input);
  assert.deepEqual(saved.mappings, [...mappings, { header: '说明', field: '' }]);
  assert.deepEqual(mappingIssues(saved.mappings, fields), []);
  for (const invalid of [
    [...mappings, { header: ' 订单号 ', field: 'purchaseSku' }],
    [...mappings, { header: '', field: 'purchaseSku' }],
    [...mappings, { header: '另一备注', field: 'purchaseNote' }],
  ]) {
    assert.throws(() => validateTemplate({ ...template, mappings: invalid }));
    assert.ok(mappingIssues(invalid, fields).length);
  }
});

test('相同模板接受不同列顺序和首尾空格，旧列号也不影响实际取值', async () => {
  const expected = {
    shopName: 'A',
    orderNumber: '0001',
    walmartSku: 'SKU-A',
    purchaseNote: '备注',
  };
  for (const order of [
    [0, 1, 2, 3],
    [3, 2, 0, 1],
  ]) {
    const data = await loaded(
      order.map((i) => ` ${mappings[i].header} `),
      order.map((i) => expected[mappings[i].field]),
    );
    const result = await extractRows(
      data,
      { ...template, mappings: mappings.map((m) => ({ ...m, column: 1 })) },
      noPicture,
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.rows[0].patch, expected);
  }
});

test('重复表头即使位于旧列号也拒绝，未映射重复表头不阻塞', async () => {
  const data = await loaded(
    ['订单号', '采购备注', '采购备注', '不用', '不用'],
    ['0001', '甲', '乙', 'x', 'y'],
  );
  await assert.rejects(
    extractRows(
      data,
      {
        ...template,
        mappings: [
          { column: 1, header: '订单号', field: 'orderNumber' },
          { column: 2, header: '采购备注', field: 'purchaseNote' },
        ],
      },
      noPicture,
    ),
    /采购备注.*出现多次/,
  );
  const result = await extractRows(
    data,
    {
      ...template,
      mappings: [
        { header: '订单号', field: 'orderNumber' },
        { header: '采购备注', field: '' },
      ],
    },
    noPicture,
  );
  assert.deepEqual(result.rows[0].patch, { orderNumber: '0001' });
});

test('缺失表头不会按列号回退，不自动识别别名；普通缺列跳过，订单号缺失拒绝', async () => {
  const data = await loaded(['订单号', '采购说明'], ['0001', '不能误导入']);
  const result = await extractRows(
    data,
    {
      ...template,
      mappings: [
        { header: '订单号', field: 'orderNumber' },
        { column: 2, header: '采购备注', field: 'purchaseNote' },
      ],
    },
    noPicture,
  );
  assert.deepEqual(result.rows[0].patch, { orderNumber: '0001' });
  assert.match(result.warnings[0].message, /采购备注.*保留原值/);
  await assert.rejects(
    extractRows(
      await loaded(['订单编号'], ['0001']),
      { ...template, mappings: [{ column: 1, header: '订单号', field: 'orderNumber' }] },
      noPicture,
    ),
    /缺少必填表头/,
  );
});

test('图片使用按表头解析出的实际位置读取', async () => {
  const data = await loaded(['采购截图', '订单号'], [null, '0001'], 0);
  let saved = 0;
  const imagePath = '/uploads/images/11111111-1111-4111-8111-111111111111.webp';
  const result = await extractRows(
    data,
    {
      ...template,
      mappings: [
        { column: 1, header: '订单号', field: 'orderNumber' },
        { column: 2, header: '采购截图', field: 'purchaseScreenshot' },
      ],
    },
    async (bytes) => {
      assert.ok(bytes.length);
      saved++;
      return { path: imagePath };
    },
  );
  assert.equal(saved, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].patch.purchaseScreenshot, imagePath);
});

test('前端复用只按唯一名称匹配，旧列号命中重复表头也不自动选择', () => {
  const columns = [
    { column: 9, header: '订单号', suggestedField: 'orderNumber' },
    { column: 2, header: '采购备注', suggestedField: 'purchaseNote' },
  ];
  const aligned = alignMappings(mappings, columns);
  assert.deepEqual(aligned.mappings, [mappings[1], mappings[3]]);
  assert.deepEqual(suggestedMappings(columns), [mappings[1], mappings[3]]);
  const duplicate = alignMappings(
    [{ column: 9, header: '订单号', field: 'orderNumber' }],
    [...columns, { column: 10, header: '订单号' }],
  );
  assert.equal(duplicate.missing.length, 1);
  assert.ok(duplicate.mappings.filter((m) => m.header === '订单号').every((m) => m.field === ''));
});
