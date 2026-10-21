/** Walmart 使用字符串 TRUE/FALSE；不能用 Boolean('FALSE') 判断取消申请。 */
export function hasCancellationIntent(value) {
  return value === true || (typeof value === 'string' && value.trim().toUpperCase() === 'TRUE');
}
