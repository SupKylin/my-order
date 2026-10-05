import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { workbookInfo, cellValue } from '../src/lib/excel/workbook.js';
import { extractRows } from '../src/lib/excel/rows.js';

test('带富文本的超链接可读取表头、预览样例和映射数据', async () => {
  const source = new ExcelJS.Workbook();
  const sheet = source.addWorksheet('订单');
  sheet.getCell('A1').value = {
    text: { richText: [{ text: '订单' }, { text: '号' }] },
    hyperlink: 'https://example.com/header',
  };
  sheet.getCell('B1').value = '商品名称';
  sheet.getCell('C1').value = '采购商品链接';
  sheet.getCell('A2').value = '000123';
  const link = {
    text: { richText: [{ text: '商品' }, { text: '链接' }] },
    hyperlink: 'https://example.com/product',
  };
  sheet.getCell('B2').value = link;
  sheet.getCell('C2').value = link;
  // 经 XLSX 写入和重新读取，复现实际上传文件中嵌套富文本的结构。
  const buffer = await source.xlsx.writeBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const info = workbookInfo(workbook);
  assert.equal(info.columns[0].header, '订单号');
  assert.equal(info.columns[0].samples[0], '000123');
  assert.equal(info.columns[1].samples[0], '商品链接');
  const result = await extractRows(
    { workbook, zip: await JSZip.loadAsync(buffer) },
    {
      sheetName: '订单',
      headerRow: 1,
      mappings: [
        // 模拟模板列号过期，验证按富文本表头重新定位。
        { column: 2, header: '订单号', field: 'orderNumber' },
        { column: 2, header: '商品名称', field: 'productName' },
        { column: 3, header: '采购商品链接', field: 'purchaseUrl' },
      ],
    },
    async () => assert.fail('测试不应保存图片'),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].patch.orderNumber, '000123');
  assert.equal(result.rows[0].patch.productName, '商品链接');
  assert.equal(result.rows[0].patch.purchaseUrl, link.hyperlink);
  assert.equal(
    cellValue(workbook.getWorksheet('订单').getCell('C2'), { type: 'url' }),
    link.hyperlink,
  );
});
