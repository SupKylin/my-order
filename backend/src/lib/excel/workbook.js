import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { AppError } from '../../errors.js';
import { fields, aliases } from '../../fields.js';

/** 解压限额在工作簿实例化前检查，避免异常文件占满内存。 */
export async function loadWorkbook(filePath, { maxExpandedBytes = 300 * 1024 * 1024 } = {}) {
  const buffer = await fs.readFile(filePath);
  let zip, workbook;
  try {
    zip = await JSZip.loadAsync(buffer);
    const files = Object.values(zip.files);
    if (
      files.length > 25000 ||
      files.reduce((n, f) => n + (f._data?.uncompressedSize || 0), 0) > maxExpandedBytes
    )
      throw new Error('压缩包解压后超过安全限额');
    if (!zip.file('xl/workbook.xml')) throw new Error('不是 Excel 工作簿');
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
  } catch (e) {
    throw new AppError(400, `无法读取 XLSX：${e.message}`);
  }
  if (!workbook.worksheets.length) throw new AppError(400, '工作簿没有工作表');
  return { workbook, zip };
}
/** 超链接的显示文本也可能是富文本对象，统一提取文字，避免 trim/slice 报错。 */
export function excelText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText))
      return value.richText.map((part) => excelText(part.text)).join('');
    if ('text' in value) return excelText(value.text);
  }
  return String(value);
}

/** 读取单元格缓存值；文本编号保留前导零，永不执行公式。 */
export function cellValue(cell, field) {
  const value = cell.value;
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((t) => t.text).join('');
    if (value.error) throw new Error(`Excel 错误值 ${value.error}`);
    if (value.hyperlink) return field?.type === 'url' ? value.hyperlink : excelText(value.text);
    if (value.formula || value.sharedFormula) {
      if (value.result && typeof value.result === 'object' && value.result.error)
        throw new Error(`公式结果为 ${value.result.error}`);
      if (value.result == null) throw new Error('公式没有缓存值，请先在 Excel 中计算并保存');
      return value.result;
    }
    return cell.text;
  }
  if (typeof value === 'number' && field && ['text', 'url'].includes(field.type)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new Error('数字精度可能已丢失，请将该列改为文本后重新导出');
    if (typeof cell.numFmt === 'string' && /^0+$/.test(cell.numFmt) && Number.isInteger(value))
      return String(value).padStart(cell.numFmt.length, '0');
    return String(value);
  }
  return value;
}
export function workbookInfo(workbook, sheetName, headerRow = 1) {
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new AppError(400, '找不到模板指定的工作表，请重新选择工作表');
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 100)
    throw new AppError(400, '表头行必须在 1 至 100 之间');
  const header = sheet.getRow(headerRow),
    columns = [];
  const count = Math.min(Math.max(header.cellCount, sheet.columnCount), 500);
  for (let i = 1; i <= count; i++) {
    const name = excelText(header.getCell(i).text).trim();
    const exact = fields.find(
      (f) =>
        f.label.toLowerCase() === name.toLowerCase() || f.key.toLowerCase() === name.toLowerCase(),
    );
    const samples = [];
    for (let r = headerRow + 1; r <= Math.min(sheet.rowCount, headerRow + 3); r++)
      samples.push(excelText(sheet.getRow(r).getCell(i).text).slice(0, 120));
    if (name || samples.some(Boolean))
      columns.push({
        column: i,
        header: name,
        samples,
        suggestedField: exact?.key || aliases[name.toLowerCase().replace(/\s/g, '')] || '',
      });
  }
  return {
    sheets: workbook.worksheets.map((s) => ({ name: s.name, rows: s.actualRowCount })),
    sheetName: sheet.name,
    headerRow,
    columns,
  };
}
