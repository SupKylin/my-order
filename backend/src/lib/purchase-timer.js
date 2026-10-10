// MySQL 5.7 的正则按字节匹配；中文选项必须用分组，不能放进字符集合。
const statusPadding = '([[:space:]]|（|）|[(]|[)])*';
export const PURCHASE_SUCCESS_PATTERN = `^采购成功${statusPadding}(未|已)出跟踪号${statusPadding}$`;
export const PURCHASE_UNTRACKED_PATTERN = `^采购成功${statusPadding}未出跟踪号${statusPadding}$`;
export const isPurchaseSuccess = (status) =>
  /^采购成功[未已]出跟踪号$/.test(String(status || '').replace(/[\s（）()]/g, ''));
export const isUntrackedPurchase = (status) =>
  String(status || '').replace(/[\s（）()]/g, '') === '采购成功未出跟踪号';

/** 进入任一成功状态时记录服务器时间；成功状态间切换及重复导入不重置。 */
export function purchaseTimerPatch(previous, patch, { now = new Date() } = {}) {
  // 未提供采购状态时不改计时，避免普通编辑或官方同步补出虚假的成功时间。
  if (!Object.hasOwn(patch, 'purchaseStatus')) return { ...patch };
  const status = Object.hasOwn(patch, 'purchaseStatus')
    ? patch.purchaseStatus
    : previous?.purchaseStatus;
  let confirmedAt =
    isPurchaseSuccess(status) && isPurchaseSuccess(previous?.purchaseStatus)
      ? previous?.purchaseConfirmedAt || null
      : null;
  if (isPurchaseSuccess(status) && !isPurchaseSuccess(previous?.purchaseStatus)) confirmedAt = now;
  return { ...patch, purchaseConfirmedAt: confirmedAt };
}
