import { validateTemplate } from '../validation.js';
import { db, ImportTemplate } from '../models.js';
import { assert } from '../errors.js';

/** 锁定来源模板，连续/并发复制时生成独立副本，沿用当前模板校验和解绑规则。 */
export async function copyTemplate(id) {
  return db.transaction(async (transaction) => {
    const source = await ImportTemplate.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    assert(source, '模板不存在', 404);
    const names = new Set(
      (await ImportTemplate.findAll({ attributes: ['name'], transaction })).map((row) => row.name),
    );
    let name;
    for (let number = 1; ; number += 1) {
      const suffix = ` - 副本${number === 1 ? '' : ` (${number})`}`;
      name = source.name.slice(0, 100 - suffix.length) + suffix;
      if (!names.has(name)) break;
    }
    return ImportTemplate.create(
      await templatePayload({ name, headerRow: source.headerRow, mappings: source.mappings }),
      { transaction },
    );
  });
}

/** 模板仅保存映射和表头行；旧绑定列保留兼容数据库，但不再参与导入。 */
export async function templatePayload(input) {
  return {
    ...validateTemplate({
      ...input,
      sheetName: '',
      mappings: Array.isArray(input.mappings)
        ? input.mappings.map((mapping) =>
            // 兼容旧模板：停用目标保留源表头，避免阻断其他采购字段导入。
            ['purchaseChannel', 'supervisorConfirmed'].includes(mapping?.field)
              ? { ...mapping, field: '' }
              : mapping,
          )
        : input.mappings,
    }),
    purchaseChannelId: null,
  };
}
