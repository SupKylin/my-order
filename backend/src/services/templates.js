import { DictionaryOption } from '../models.js';
import { validateTemplate } from '../validation.js';
import { assert } from '../errors.js';

/** 模板用稳定 ID 绑定渠道；渠道改名后下一次导入读取新名称。 */
export async function templatePayload(input, transaction) {
  const template = validateTemplate(input);
  const channelId = input.purchaseChannelId;
  template.purchaseChannelId = channelId == null || channelId === '' ? null : Number(channelId);
  if (template.purchaseChannelId !== null) {
    assert(
      Number.isInteger(template.purchaseChannelId) && template.purchaseChannelId > 0,
      '采购渠道无效',
    );
    const channel = await DictionaryOption.findByPk(template.purchaseChannelId, {
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    assert(
      channel?.kind === 'purchaseChannel' && channel.active,
      '模板绑定的采购渠道已停用或不存在，请重新选择或清空',
    );
    template.purchaseChannel = channel.value;
  }
  return template;
}
