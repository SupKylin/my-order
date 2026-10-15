import { Op, col, fn } from 'sequelize';
import { OrderItem, Purchase, Store } from '../models.js';
import { orderScope } from '../permissions.js';
import { storedChannels } from '../lib/channels.js';

/** 当天当前渠道的明细数，不是历史操作次数；范围只受账号权限限制。 */
export async function purchaseAssignmentSummary(user, now = Date.now()) {
  const day = 86400000;
  const offset = 8 * 3600000;
  const start = Math.floor((now + offset) / day) * day - offset;
  const grouped = await OrderItem.findAll({
    attributes: [
      [col('purchase.purchaseChannel'), 'channel'],
      [fn('COUNT', col('OrderItem.id')), 'count'],
    ],
    where: orderScope(user),
    include: [
      {
        model: Purchase,
        as: 'purchase',
        attributes: [],
        required: true,
        where: {
          purchaseAssignedAt: { [Op.gte]: new Date(start), [Op.lt]: new Date(start + day) },
          purchaseChannel: { [Op.ne]: null },
        },
      },
      { model: Store, as: 'store', attributes: [], required: false },
    ],
    group: [col('purchase.purchaseChannel')],
    raw: true,
  });
  const counts = new Map();
  // 在数据库先按渠道组合聚合，再拆分多选；兼容旧单选值并防止同明细重复计数。
  for (const row of grouped)
    for (const channel of new Set(storedChannels(row.channel) || [])) {
      if (!channel.trim()) continue;
      counts.set(channel, (counts.get(channel) || 0) + Number(row.count));
    }
  return {
    date: new Date(start + offset).toISOString().slice(0, 10),
    expiresAt: new Date(start + day).toISOString(),
    channels: [...counts]
      .map(([channel, count]) => ({ channel, count }))
      .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel, 'zh-CN')),
  };
}
