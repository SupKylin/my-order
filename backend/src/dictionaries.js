import { CHANNELS, ORDER_STATUSES, PURCHASE_STATUSES } from './fields.js';

export const dictionaryKinds = {
  purchaseChannel: { label: '采购渠道', defaults: CHANNELS },
  orderStatus: { label: '运营订单状态', defaults: ORDER_STATUSES },
  purchaseStatus: { label: '采购状态', defaults: PURCHASE_STATUSES },
};

// 与导入的标准化规则一致，防止只差空格/中英文括号的名称出现歧义。
export const optionKey = (value) =>
  String(value)
    .replace(/[\s（）()]/g, '')
    .toLowerCase();
