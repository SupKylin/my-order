import { acknowledgementDecision, orderLines, lineStatuses } from './mapping.js';

/** 保存必须完成事务提交；独立的依赖边界便于验证失败和超时恢复路径。 */
export async function acknowledgePersistedOrder({ purchaseOrderId, client, save, mark }) {
  try {
    const latest = await client.order(purchaseOrderId);
    await save(latest);
    const decision = acknowledgementDecision(latest);
    if (decision.action !== 'acknowledge') {
      await mark(decision.action === 'review' ? 'review' : 'skipped', decision.reason);
      return decision.action;
    }
    await mark('sending', null, true);
    const acknowledged = await client.acknowledge(purchaseOrderId);
    // 即使回执丢失也由下一次 GET 恢复，不能自行假定请求成功。
    const statuses = orderLines(acknowledged).flatMap(lineStatuses);
    if (
      !statuses.length ||
      !statuses.every((status) =>
        ['Acknowledged', 'Shipped', 'Delivered', 'Cancelled'].includes(status),
      ) ||
      orderLines(acknowledged).some((line) => !lineStatuses(line).length) ||
      orderLines(latest).some(
        (line) =>
          !orderLines(acknowledged).some((updated) => updated.lineNumber === line.lineNumber),
      )
    )
      throw new Error('Walmart 未返回完整确认状态，下次重新查询');
    await save(acknowledged);
    await mark('acknowledged', null);
    return 'acknowledged';
  } catch (error) {
    await mark(
      'failed',
      error.name?.startsWith('Sequelize') ? '本地保存失败，下次重新查询平台状态' : error.message,
    );
    return 'failed';
  }
}
