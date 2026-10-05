import { list, valuesOf, walk, xml, relationships } from './xml.js';

/** 将三类嵌入图片统一为以 1 起始的 行:列 -> Buffer 映射。 */
export async function embeddedImages({ workbook, zip }, sheet) {
  const images = new Map(),
    warnings = [];
  const add = (row, col, buffer) => {
    const key = `${row}:${col}`;
    if (images.has(key))
      warnings.push({ row, message: `第 ${col} 列有多张图片，当前图片字段只保存第一张` });
    else images.set(key, buffer);
  };
  for (const entry of sheet.getImages()) {
    const picture = workbook.getImage(entry.imageId);
    if (picture?.buffer)
      add(
        Math.floor(entry.range.tl.nativeRow) + 1,
        Math.floor(entry.range.tl.nativeCol) + 1,
        Buffer.from(picture.buffer),
      );
  }
  // WPS / 部分 Excel 的 DISPIMG 单元格图片。
  const cellImages = await xml(zip, 'xl/cellimages.xml');
  if (cellImages) {
    const rels = await relationships(zip, 'xl/cellimages.xml'),
      named = new Map();
    for (const pic of walk(cellImages, 'pic')) {
      const prop = walk(pic, 'cNvPr')[0],
        blip = walk(pic, 'blip')[0];
      const img = zip.file(rels[blip?.['@embed']] || '');
      if (img && prop?.['@name']) named.set(prop['@name'], await img.async('nodebuffer'));
    }
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        const formula = cell.value?.formula || cell.text;
        const match = String(formula || '').match(/DISPIMG\(\s*"([^"]+)"/i);
        if (match) {
          const buf = named.get(match[1]);
          if (buf) add(row.number, cell.col, buf);
          else warnings.push({ row: row.number, message: '单元格图片引用缺少对应图片文件' });
        }
      }),
    );
  }
  // Microsoft 365「置于单元格内」图片：值元数据 -> 富值 -> 图片关系。
  const workbookXml = await xml(zip, 'xl/workbook.xml'),
    bookRels = await relationships(zip, 'xl/workbook.xml');
  const sheetEntry = list(workbookXml?.workbook?.sheets?.sheet).find(
    (s) => s['@name'] === sheet.name,
  );
  const sheetXml = sheetEntry ? await xml(zip, bookRels[sheetEntry['@id']]) : null;
  const vmCells = walk(sheetXml, 'c').filter((c) => c['@vm']);
  if (vmCells.length) {
    const meta = await xml(zip, 'xl/metadata.xml');
    const rich = await xml(zip, 'xl/richData/rdrichvalue.xml');
    const richRelsDoc = await xml(zip, 'xl/richData/richValueRel.xml');
    const richRels = await relationships(zip, 'xl/richData/richValueRel.xml');
    const future = list(meta?.metadata?.futureMetadata).find((x) => x['@name'] === 'XLRICHVALUE');
    const valueMeta = list(meta?.metadata?.valueMetadata?.bk),
      futureBk = list(future?.bk),
      richValues = list(rich?.rvData?.rv),
      richRelList = list(richRelsDoc?.richValueRels?.rel);
    for (const c of vmCells) {
      const addr = c['@r'],
        ref = sheet.getCell(addr),
        metadataRecord = valueMeta[Number(c['@vm']) - 1];
      const rc = list(metadataRecord?.rc)[0];
      const rvb = walk(futureBk[Number(rc?.['@v'])], 'rvb')[0];
      const richValue = richValues[Number(rvb?.['@i'])];
      const imageIndex = Number(valuesOf(list(richValue?.v)[0]));
      const rel = richRelList[imageIndex];
      const file = zip.file(richRels[rel?.['@id']] || '');
      if (file) add(ref.row, ref.col, await file.async('nodebuffer'));
      else if (!images.has(`${ref.row}:${ref.col}`))
        warnings.push({
          row: ref.row,
          message: '检测到单元格富图片，但无法解析，请改为浮动嵌入图片后重试',
        });
    }
  }
  return { images, warnings };
}
