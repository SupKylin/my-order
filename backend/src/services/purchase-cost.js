import { DictionaryOption, Store } from '../models.js';
import { assert } from '../errors.js';
import { storedChannels } from '../lib/channels.js';
import { purchaseCost, modeDiscountKey, shippingModes } from '../lib/channel-discount.js';

/** 编辑、导入共用。无结算/金额/计算渠道变化时不触碰历史快照。 */
export async function purchaseCostPatch(previous, patch, transaction, readChannels) {
  const old = previous?.toJSON ? previous.toJSON() : previous || {};
  const next = { ...old, ...patch };
  const channelChanged =
    Object.hasOwn(patch, 'purchaseCostChannel') &&
    (patch.purchaseCostChannel || null) !== (old.purchaseCostChannel || null);
  const settledNow = next.settlement === '已结算' && old.settlement !== '已结算';
  const modeChanged =
    Object.hasOwn(patch, 'shippingMode') && next.shippingMode !== old.shippingMode;
  const channels = storedChannels(next.purchaseChannel) || [];
  if (channelChanged && next.purchaseCostChannel)
    assert(
      channels.includes(next.purchaseCostChannel),
      '成本计算渠道必须属于该订单已分配的采购渠道',
    );
  if (next.settlement !== '已结算') {
    return old.settlement === '已结算' ? { purchaseDiscount: null, purchaseCost: null } : {};
  }
  if (settledNow || channelChanged || modeChanged) {
    assert(
      shippingModes.includes(next.shippingMode),
      '结算前请选择发货模式 FBA 或 FBM，已结算时不能清空',
    );
    const channel = channelChanged
      ? patch.purchaseCostChannel
      : channels.length === 1
        ? channels[0]
        : next.purchaseCostChannel;
    assert(
      channel && channels.includes(channel),
      '结算前请选择一个成本计算渠道（须属于已分配的采购渠道）',
    );
    const choices = readChannels
      ? await readChannels()
      : await DictionaryOption.findAll({
          where: { kind: 'purchaseChannel', active: true, value: channel },
          transaction,
        });
    const option = choices.find((entry) => entry.value === channel && entry.active);
    const discount = option?.[modeDiscountKey(next.shippingMode, 'purchaseDiscount')];
    assert(discount != null, `采购渠道“${channel}”未启用或尚未配置 ${next.shippingMode} 采购折扣`);
    return {
      purchaseCostChannel: channel,
      purchaseDiscount: discount,
      purchaseCost: purchaseCost(discount, next.purchaseAmount),
    };
  }
  // 历史已结算但没有快照的记录保持空值；新快照的金额改变只使用已存折扣。
  if (Object.hasOwn(patch, 'purchaseAmount') && old.purchaseDiscount != null)
    return { purchaseCost: purchaseCost(old.purchaseDiscount, next.purchaseAmount) };
  return {};
}

/** 只在从非结算进入已结算时抓取店铺费率；已结算修改金额/模式/渠道不换费率。 */
export async function settlementCommissionPatch(previous, patch, shopName, transaction) {
  const old = previous?.toJSON ? previous.toJSON() : previous || {};
  const next = { ...old, ...patch };
  if (next.settlement !== '已结算')
    return old.settlement === '已结算' ? { commissionRate: null } : {};
  if (old.settlement === '已结算') return {};
  const store = await Store.findOne({
    where: { systemStoreName: shopName },
    attributes: ['commissionRate'],
    transaction,
    ...(transaction ? { lock: transaction.LOCK.SHARE } : {}),
  });
  return { commissionRate: store?.commissionRate ?? null };
}
