export const PURCHASE_SUCCESS_PATTERN =
  '^采购成功[[:space:]（）()]*[未已]出跟踪号[[:space:]（）()]*$';
export const PURCHASE_UNTRACKED_PATTERN =
  '^采购成功[[:space:]（）()]*未出跟踪号[[:space:]（）()]*$';
export const isPurchaseSuccess = (status) =>
  /^采购成功[未已]出跟踪号$/.test(String(status || '').replace(/[\s（）()]/g, ''));
export const isUntrackedPurchase = (status) =>
  String(status || '').replace(/[\s（）()]/g, '') === '采购成功未出跟踪号';

/** 进入未出跟踪号状态时使用服务器时间；重复保存和导入不重置。 */
export function purchaseTimerPatch(previous, patch, { now = new Date() } = {}) {
  const status = Object.hasOwn(patch, 'purchaseStatus')
    ? patch.purchaseStatus
    : previous?.purchaseStatus;
  let confirmedAt =
    isPurchaseSuccess(status) && isPurchaseSuccess(previous?.purchaseStatus)
      ? previous?.purchaseConfirmedAt || null
      : null;
  if (!confirmedAt && isUntrackedPurchase(status)) confirmedAt = now;
  return { ...patch, purchaseConfirmedAt: confirmedAt };
}
