// 表单预览使用整数小数运算；最终校验及快照由服务端完成。
export function fixedDecimal(value, digits) {
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole}.${fraction.padEnd(digits, '0').slice(0, digits)}`;
}
function decimal(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,16}(?:\.\d{1,20})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return { value: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) };
}
function ratio(numerator, denominator, digits) {
  if (denominator <= 0n) return null;
  const scaled = numerator * 10n ** BigInt(digits);
  const rounded = scaled / denominator + ((scaled % denominator) * 2n >= denominator ? 1n : 0n);
  const text = rounded.toString().padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}
export function discountPreview({ channelExchangeRate, currentExchangeRate, taxMultiplier }) {
  const a = decimal(channelExchangeRate),
    b = decimal(currentExchangeRate),
    c = decimal(taxMultiplier);
  return a && b && c ? ratio(a.value * c.value * b.scale, a.scale * c.scale * b.value, 4) : null;
}
export function costPreview(discount, amount) {
  const a = decimal(discount),
    b = decimal(amount);
  return a && b ? ratio(a.value * b.value, a.scale * b.scale, 2) : null;
}

// 只读参考配置；不写入订单，也不替代历史结算快照。
export function currentFinanceConfig(row, options = []) {
  const rate = decimal(row.storeCommissionRate);
  const commissionRate =
    rate && Number(row.storeCommissionRate) <= 100
      ? fixedDecimal(row.storeCommissionRate, 2)
      : null;
  const result = {
    commissionRate,
    commissionMessage: commissionRate == null ? '店铺尚未配置佣金率' : '当前配置，结算时确定',
    purchaseDiscount: null,
    discountMessage: '',
  };
  const channels = Array.isArray(row.purchaseChannel) ? row.purchaseChannel : [];
  const channel = channels.length === 1 ? channels[0] : row.purchaseCostChannel;
  if (!channels.length) result.discountMessage = '尚未分配采购渠道';
  else if (!channel || !channels.includes(channel))
    result.discountMessage = '请先选择已分配渠道中的一个成本计算渠道';
  else if (!['FBA', 'FBM'].includes(row.shippingMode))
    result.discountMessage = '请先选择发货模式 FBA 或 FBM';
  else {
    const option = options.find((entry) => entry.value === channel && entry.active !== false);
    const discount = option?.[`${row.shippingMode.toLowerCase()}PurchaseDiscount`];
    if (!decimal(discount))
      result.discountMessage = `采购渠道“${channel}”未启用或尚未配置 ${row.shippingMode} 采购折扣`;
    else {
      result.purchaseDiscount = fixedDecimal(discount, 4);
      result.discountMessage = `当前配置，结算时确定（${channel} · ${row.shippingMode}）`;
    }
  }
  return result;
}
