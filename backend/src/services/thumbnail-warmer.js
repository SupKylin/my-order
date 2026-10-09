import { Op } from 'sequelize';
import { OrderItem } from '../models.js';
import { thumbnailCache, thumbnailWorkers } from '../lib/excel/thumbnail-cache.js';

let enabled = false;
/** 订单提交后只触发后台工作，不阻塞事务或 Walmart 确认。测试及迁移不自动下载图片。 */
export function warmProductImages(urls) {
  if (!enabled) return;
  void thumbnailWorkers(
    [...new Set(urls.filter(Boolean))],
    async (url) => {
      if (enabled) await thumbnailCache.get(url);
    },
    2,
  ).catch((error) => console.error('商品图片预热失败', error.message));
}

/** 启动时补齐历史缓存，之后每 20 分钟扫描；与导出共享下载限额。 */
export function startThumbnailWarmer() {
  enabled = true;
  let running;
  async function scan() {
    let lastId = 0;
    while (enabled) {
      const rows = await OrderItem.findAll({
        where: { id: { [Op.gt]: lastId }, productImage: { [Op.ne]: null } },
        attributes: ['id', 'productImage'],
        order: [['id', 'ASC']],
        limit: 200,
      });
      await thumbnailWorkers(
        [...new Set(rows.map((row) => row.productImage))],
        async (url) => {
          if (enabled) await thumbnailCache.get(url);
        },
        2,
      );
      if (rows.length < 200) break;
      lastId = rows.at(-1).id;
    }
  }
  const tick = () => {
    if (running || !enabled) return;
    running = scan()
      .catch((error) => console.error('商品图片缓存扫描失败', error.message))
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, 20 * 60 * 1000);
  timer.unref();
  return async () => {
    enabled = false;
    clearInterval(timer);
    await running;
  };
}
