import { walmartImage } from '../product-image.js';
import { thumbnailCache, thumbnailWorkers } from './thumbnail-cache.js';

/** 复用缩略图数据及磁盘缓存；失败时保留可点击的原图链接。 */
export function createProductThumbnails(workbook, cache = thumbnailCache) {
  const images = new Map();
  return {
    async prepare(items, onProgress = () => {}) {
      const urls = [
        ...new Set(items.map((item) => walmartImage(item.productImage)).filter(Boolean)),
      ].filter((url) => !images.has(url));
      let completed = 0;
      onProgress(completed, urls.length);
      await thumbnailWorkers(urls, async (url) => {
        const buffer = await cache.get(url);
        images.set(url, buffer);
        onProgress(++completed, urls.length);
      });
    },
    add(sheet, row, column, value) {
      const url = walmartImage(value);
      if (!url) return;
      const buffer = images.get(url);
      const cell = row.getCell(column);
      if (!buffer) {
        cell.value = { text: '图片加载失败，点击查看原图', hyperlink: url };
        return;
      }
      cell.value = null;
      cell.note = url;
      row.height = 78;
      // ExcelJS 4 的重复图片 ID 与超链接关系会冲突；每个单元格独立 ID，复用同一 Buffer。
      const imageId = workbook.addImage({ buffer, extension: 'png' });
      sheet.addImage(imageId, {
        tl: { col: column - 1 + 0.03, row: row.number - 1 + 0.03 },
        ext: { width: 96, height: 96 },
        editAs: 'oneCell',
        hyperlinks: { hyperlink: url, tooltip: '查看原图' },
      });
    },
  };
}
