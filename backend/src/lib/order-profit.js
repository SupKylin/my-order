import { parseDecimal, roundedRatio, multiply } from './purchase-derived.js';
import { assert } from '../errors.js';

export function normalizeCommissionRate(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const text = String(value).trim();
  assert(
    /^\d{1,3}(?:\.\d{1,2})?$/.test(text) && Number(text) <= 100,
    '佣金须为0至100的百分比数字，最多2位小数',
  );
  return text;
}

const SCALE = 10n ** 20n;
export function moneyUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d{1,16}(?:\.\d{1,20})?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  return (negative ? -1n : 1n) * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(20, '0')));
}
export function moneyText(units, digits = 2) {
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  const step = 10n ** BigInt(20 - digits);
  const rounded = (absolute + step / 2n) / step;
  const text = rounded.toString().padStart(digits + 1, '0');
  return `${rounded ? sign : ''}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}
export const isCancelledItem = (row) =>
  row.walmart?.statuses?.length > 0 &&
  row.walmart.statuses.every((status) => status === 'Cancelled');

/** 只采用已完整关联到本商品的官方卖家退款净扣款。 */
function sellerRefund(row) {
  const hasRefund =
    row.returnInfo?.statuses?.includes('已退款') ||
    row.returnInfo?.lines?.some((line) => line.status === '已退款');
  if (!hasRefund)
    return {
      amount: null,
      missing: false,
      message: '暂无已退款记录，利润按0计算',
    };
  const official = moneyUnits(row.sellerRefund?.amount);
  if (official != null && official >= 0n)
    return {
      amount: moneyText(official),
      missing: false,
      message: `卖家退款净扣款；官方对账报表截至 ${row.sellerRefund.through}，不含争议赔付`,
    };
  return {
    amount: null,
    missing: true,
    message: '官方对账报表尚未取得完整退款净扣款，暂不计算利润',
  };
}

/** 费率在结算时固定，按最新订单金额和已保存采购成本实时算利润，不回用店铺新费率。 */
export function itemProfit(row) {
  const refund = sellerRefund(row);
  const ticket = row.purchaseAfterSale;
  const purchaseRefund = ticket ? moneyUnits(ticket.purchaseRefundAmount) : 0n;
  const disputeValue = row.purchase?.disputeSuccessAmount;
  const dispute = disputeValue == null || disputeValue === '' ? 0n : moneyUnits(disputeValue);
  const result = {
    commissionRate: null,
    commissionAmount: null,
    orderProfit: null,
    profitMessage: '',
    walmartRefundAmount: refund.amount,
    walmartRefundMessage: refund.message,
    purchaseRefundAmount:
      ticket && purchaseRefund != null && purchaseRefund >= 0n ? moneyText(purchaseRefund) : null,
    purchaseRefundMessage: !ticket
      ? '无采购售后工单，利润按0计算'
      : purchaseRefund == null || purchaseRefund < 0n
        ? '工单采购退款金额未填写或无效，暂不计算利润'
        : '使用采购售后工单已保存金额，处理中也计入利润',
    disputeSuccessAmount:
      disputeValue == null || disputeValue === '' || dispute == null || dispute < 0n
        ? null
        : moneyText(dispute),
  };
  const amount = moneyUnits(row.orderAmount);
  const rate = parseDecimal(row.purchase?.commissionRate);
  if (row.purchase?.settlement === '已结算' && rate && Number(row.purchase.commissionRate) <= 100) {
    result.commissionRate = roundedRatio(rate, { integer: 1n, scale: 0 }, 2);
    if (amount != null && amount >= 0n)
      result.commissionAmount = roundedRatio(
        multiply({ integer: amount, scale: 20 }, rate),
        { integer: 100n, scale: 0 },
        2,
      );
  }
  if (isCancelledItem(row)) result.profitMessage = '已取消商品明细不计利润';
  else if (row.purchase?.settlement !== '已结算') result.profitMessage = '尚未结算';
  else if (result.commissionRate == null)
    result.profitMessage = '结算时未保存佣金率，历史订单不自动补填';
  else if (result.commissionAmount == null) result.profitMessage = '订单金额缺失或格式无效';
  else if (!parseDecimal(row.purchase?.purchaseCost))
    result.profitMessage = '尚未结算或缺少采购成本';
  else if (refund.missing) result.profitMessage = refund.message;
  else if (purchaseRefund == null || purchaseRefund < 0n)
    result.profitMessage = result.purchaseRefundMessage;
  else if (dispute == null || dispute < 0n) result.profitMessage = '争议成功金额无效，暂不计算利润';
  else {
    const cost = moneyUnits(row.purchase.purchaseCost);
    if (cost == null) result.profitMessage = '采购成本格式无效';
    else {
      result.orderProfit = moneyText(
        amount -
          moneyUnits(result.commissionAmount) -
          cost -
          (moneyUnits(refund.amount) ?? 0n) +
          purchaseRefund +
          dispute,
      );
      result.profitMessage =
        '订单金额－订单金额×结算时佣金率－采购成本－卖家退款净扣款＋采购退款金额＋争议成功金额';
    }
  }
  return result;
}
