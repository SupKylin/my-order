import { db, DictionaryOption } from '../models.js';
import { fields } from '../fields.js';
import { dictionaryKinds, optionKey } from '../dictionaries.js';
import { assert } from '../errors.js';

export function checkKind(kind) {
  assert(Object.hasOwn(dictionaryKinds, kind), '不支持的字典类型', 404);
}

export async function listDictionary(kind) {
  checkKind(kind);
  return DictionaryOption.findAll({
    where: { kind },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
}

/** 每次读取数据库选项，避免不同进程或不同接口使用旧的硬编码枚举。 */
export async function getFieldDefinitions(transaction) {
  const options = await DictionaryOption.findAll({
    where: { active: true },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  return fields.map((field) =>
    Object.hasOwn(dictionaryKinds, field.key)
      ? {
          ...field,
          options: options
            .filter((option) => option.kind === field.key)
            .map((option) => option.value),
        }
      : field,
  );
}

export async function saveDictionaryOption(kind, id, input) {
  checkKind(kind);
  const value = String(input.value ?? '').trim();
  const sortOrder = Number(input.sortOrder ?? 0);
  assert(value && value.length <= 255, '选项名称须为 1 至 255 个字符');
  assert(
    Number.isInteger(sortOrder) && sortOrder >= 0 && sortOrder <= 100000,
    '排序须为 0 至 100000 的整数',
  );
  assert(typeof input.active === 'boolean', '启用状态必须为是或否');
  return db.transaction(async (transaction) => {
    // 固定顺序锁定同类选项，序列化改名及标准化去重检查。
    const options = await DictionaryOption.findAll({
      where: { kind },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existing = id ? options.find((option) => option.id === Number(id)) : null;
    if (id) {
      assert(existing, '字典选项不存在', 404);
      assert(existing.version === input.version, '选项已被其他人修改，请刷新后重试', 409);
    }
    assert(
      !options.some(
        (option) => option.id !== existing?.id && optionKey(option.value) === optionKey(value),
      ),
      '同类选项名称重复，请使用不同名称',
      409,
    );
    const data = { value, sortOrder, active: input.active };
    // 只更新字典，不替换历史订单中的字符串快照。
    return existing
      ? existing.update({ ...data, version: existing.version + 1 }, { transaction })
      : DictionaryOption.create({ kind, ...data }, { transaction });
  });
}
