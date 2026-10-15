import { storedChannels } from './channels.js';
import { assert } from '../errors.js';

/** 空状态使用 NULL 存储，展示时分别解释为未审核、未分配。 */
export function procurementState(purchase = {}) {
  const allocatable = purchase?.allocatable;
  const hasChannel = (storedChannels(purchase?.purchaseChannel) || []).some((value) =>
    value.trim(),
  );
  return {
    reviewStatus: allocatable === '否' ? '不可分配' : allocatable === '是' ? '已审核' : null,
    supplierAssignmentStatus:
      allocatable === '否' ? '不可分配' : allocatable === '是' && hasChannel ? '已分配' : null,
  };
}

/** 人工修改任一来源字段时重新计算；无采购变更的官方同步不覆盖人工数据。 */
export function procurementStatePatch(previous, patch) {
  const result = { ...patch };
  const changesAllocation = Object.hasOwn(patch, 'allocatable');
  const changesChannels = Object.hasOwn(patch, 'purchaseChannel');
  if (!changesAllocation && !changesChannels) return { ...patch };
  const next = {
    allocatable: previous?.allocatable ?? null,
    purchaseChannel: previous?.purchaseChannel ?? null,
    ...patch,
  };
  if (changesChannels) {
    const channels = storedChannels(next.purchaseChannel) || [];
    const oldChannels = storedChannels(previous?.purchaseChannel) || [];
    // 保留历史渠道及允许清空；新增/替换渠道必须先审核为可分配。
    const changed =
      JSON.stringify([...channels].sort()) !== JSON.stringify([...oldChannels].sort());
    assert(
      !channels.length || !changed || next.allocatable === '是',
      '请先将是否可分配设置为“是”，再选择采购渠道',
    );
    // 记录真实渠道变更（含清空）；仅调整多选顺序或重复保存不重置时间。
    if (changed) result.purchaseAssignedAt = new Date();
  }
  return { ...result, ...procurementState(next) };
}
