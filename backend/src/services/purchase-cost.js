import { DictionaryOption } from '../models.js';
import { assert } from '../errors.js';
import { storedChannels } from '../lib/channels.js';
import { purchaseCost } from '../lib/channel-discount.js';

/** 编辑、导入共用。无结算/金额/计算渠道变化时不触碰历史快照。 */
export async function purchaseCostPatch(previous, patch, transaction, readChannels) {
  const old = previous?.toJSON ? previous.toJSON() : previous || {};
  const next = { ...old, ...patch };
  const channelChanged =
    Object.hasOwn(patch, 'purchaseCostChannel') &&
    (patch.purchaseCostChannel || null) !== (old.purchaseCostChannel || null);
  const settledNow = next.settlement === '已结算' && old.settlement !== '已结算';
  const channels = storedChannels(next.purchaseChannel) || [];
  if (channelChanged && next.purchaseCostChannel)
    assert(
      channels.includes(next.purchaseCostChannel),
      '成本计算渠道必须属于该订单已分配的采购渠道',
    );
  if (next.settlement !== '已结算') {
    return old.settlement === '已结算' ? { purchaseDiscount: null, purchaseCost: null } : {};
  }
  if (settledNow || channelChanged) {
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
    assert(option?.purchaseDiscount != null, `采购渠道“${channel}”未启用或尚未配置采购折扣`);
    return {
      purchaseCostChannel: channel,
      purchaseDiscount: option.purchaseDiscount,
      purchaseCost: purchaseCost(option.purchaseDiscount, next.purchaseAmount),
    };
  }
  // 历史已结算但没有快照的记录保持空值；新快照的金额改变只使用已存折扣。
  if (Object.hasOwn(patch, 'purchaseAmount') && old.purchaseDiscount != null)
    return { purchaseCost: purchaseCost(old.purchaseDiscount, next.purchaseAmount) };
  return {};
}
