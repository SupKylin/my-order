import { createHash } from 'node:crypto';
import { AppError } from '../../errors.js';
import { fieldMap, fields } from '../../fields.js';
import { isBlank, normalizeValue, validatePatch } from '../../validation.js';
import { cellValue, excelText } from './workbook.js';
import { embeddedImages } from './images.js';

/** 只产出非空字段补丁；未映射字段、缺列和空单元格都不生成覆盖值。 */
export async function extractRows(loaded, template, savePicture, fieldDefinitions = fields) {
  const sheet = loaded.workbook.getWorksheet(template.sheetName);
  if (!sheet) throw new AppError(400, `找不到工作表“${template.sheetName}”`);
  const effectiveMappings = [],
    mappingWarnings = [];
  for (const mapping of template.mappings) {
    // 模板保存全部源表头，只有选择了目标字段的列才参与读取和校验。
    if (isBlank(mapping.field)) continue;
    const m = { ...mapping },
      header = sheet.getRow(template.headerRow),
      current = excelText(header.getCell(m.column).text).trim();
    if (current !== m.header.trim()) {
      const matches = [];
      for (let c = 1; c <= Math.min(header.cellCount, 500); c++)
        if (excelText(header.getCell(c).text).trim() === m.header.trim()) matches.push(c);
      if (matches.length > 1)
        throw new AppError(400, `表头“${m.header}”出现多次，无法确定列，请重新配置映射`);
      if (matches.length === 1) {
        m.column = matches[0];
        mappingWarnings.push({
          row: template.headerRow,
          message: `“${m.header}”列位置变化，已按表头匹配到第 ${m.column} 列`,
        });
      } else if (fieldMap[m.field].required)
        throw new AppError(400, `缺少必填表头“${m.header}”，请检查文件或更新模板`);
      else {
        mappingWarnings.push({
          row: template.headerRow,
          message: `本次缺少“${m.header}”列，对应字段将保留原值`,
        });
        continue;
      }
    }
    effectiveMappings.push(m);
  }
  if (sheet.actualRowCount > 10001) throw new AppError(400, '单次最多导入 10000 行，请拆分文件');
  const { images, warnings } = await embeddedImages(loaded, sheet);
  const purchaseStatusField = fieldDefinitions.find((field) => field.key === 'purchaseStatus');
  warnings.unshift(...mappingWarnings);
  const rows = [],
    errors = [],
    savedPictures = new Map();
  for (let rowNumber = template.headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber),
      raw = {};
    let present = false;
    for (const mapping of effectiveMappings) {
      const field = fieldMap[mapping.field],
        image = images.get(`${rowNumber}:${mapping.column}`);
      try {
        if (field.type === 'image' && image) {
          // 同一图片可能对应合并行；相同的二进制只落盘一次。
          const digest = createHash('sha256').update(image).digest('hex');
          if (!savedPictures.has(digest))
            savedPictures.set(digest, (await savePicture(image)).path);
          raw[field.key] = savedPictures.get(digest);
          present = true;
        } else {
          const value = cellValue(row.getCell(mapping.column), field);
          if (!isBlank(value)) {
            raw[field.key] = value;
            present = true;
          }
        }
      } catch (e) {
        present = true;
        errors.push({ row: rowNumber, field: field.key, label: field.label, message: e.message });
      }
    }
    if (!present) continue;
    // 仅导入时容忍未知采购状态：不生成该字段补丁，其他字段仍正常校验。
    if (!isBlank(raw.purchaseStatus)) {
      try {
        raw.purchaseStatus = normalizeValue(purchaseStatusField, raw.purchaseStatus);
      } catch {
        warnings.push({
          row: rowNumber,
          field: 'purchaseStatus',
          message: `采购状态“${String(raw.purchaseStatus).slice(0, 255)}”不在当前下拉选项中，已跳过该字段并保留原值`,
        });
        delete raw.purchaseStatus;
      }
    }
    try {
      // Excel 已映射且非空的渠道优先；空白、缺列或未映射时使用模板绑定值。
      if (template.purchaseChannel && isBlank(raw.purchaseChannel))
        raw.purchaseChannel = template.purchaseChannel;
      const patch = validatePatch(raw, { skipBlank: true, requireKeys: true, fieldDefinitions });
      rows.push({ rowNumber, patch });
    } catch (e) {
      for (const detail of e.details || [{ message: e.message }])
        errors.push({ row: rowNumber, ...detail });
    }
  }
  if (!rows.length && !errors.length)
    throw new AppError(400, '没有可导入的数据，请检查表头行和映射');
  return { rows, errors, warnings };
}
