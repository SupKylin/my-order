import { validateTemplate } from '../validation.js';

/** 模板仅保存映射和表头行；旧绑定列保留兼容数据库，但不再参与导入。 */
export async function templatePayload(input) {
  return {
    ...validateTemplate({
      ...input,
      sheetName: '',
      mappings: Array.isArray(input.mappings)
        ? input.mappings.map((mapping) =>
            mapping?.field === 'purchaseChannel' ? { ...mapping, field: '' } : mapping,
          )
        : input.mappings,
    }),
    purchaseChannelId: null,
  };
}
