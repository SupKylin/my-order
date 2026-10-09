import { db, RiskAddress, AuditLog } from '../models.js';
import { addressFields, addressKey } from '../lib/address-key.js';
import { assert } from '../errors.js';

export const listRiskAddresses = () => RiskAddress.findAll({ order: [['id', 'DESC']] });

export async function saveRiskAddress(id, input, actor) {
  const values = Object.fromEntries(
    addressFields.map((key) => [
      key,
      String(input[key] ?? '')
        .trim()
        .replace(/\s+/g, ' '),
    ]),
  );
  values.note = String(input.note ?? '').trim();
  assert(
    addressFields.every((key) => values[key].length <= 255),
    '地址字段最多 255 个字符',
  );
  assert(values.note.length <= 12000, '备注最多 12000 个字符');
  values.addressKey = addressKey(values);
  assert(values.addressKey, '请填写地址一、城市、州和邮编；地址二可留空');
  return db.transaction(async (transaction) => {
    const row = id
      ? await RiskAddress.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    if (id) {
      assert(row, '风险地址不存在', 404);
      assert(row.version === input.version, '地址已被修改，请刷新后重试', 409);
    }
    const duplicate = await RiskAddress.findOne({
      where: { addressKey: values.addressKey },
      transaction,
    });
    assert(!duplicate || duplicate.id === row?.id, '该风险地址已经存在', 409);
    const saved = row
      ? await row.update({ ...values, version: row.version + 1 }, { transaction })
      : await RiskAddress.create(values, { transaction });
    await AuditLog.create(
      { userId: actor.id, action: 'save_risk_address', entityId: String(saved.id) },
      { transaction },
    );
    return saved;
  });
}

export async function deleteRiskAddress(id, version, actor) {
  return db.transaction(async (transaction) => {
    const row = await RiskAddress.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    assert(row, '风险地址不存在', 404);
    assert(row.version === version, '地址已被修改，请刷新后重试', 409);
    await row.destroy({ transaction });
    await AuditLog.create(
      { userId: actor.id, action: 'delete_risk_address', entityId: String(id) },
      { transaction },
    );
    return { ok: true };
  });
}
