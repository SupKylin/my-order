import { db, AuditLog, Store } from '../models.js';
import { assert } from '../errors.js';

function validateInput(input, editing) {
  const walmartStoreName = String(input.walmartStoreName ?? '').trim();
  const systemStoreName = String(input.systemStoreName ?? '').trim();
  const clientId = input.clientId == null ? '' : String(input.clientId);
  const clientSecret = input.clientSecret == null ? '' : String(input.clientSecret);
  assert(walmartStoreName.length > 0 && walmartStoreName.length <= 191, '请输入 Walmart 店铺名');
  assert(systemStoreName.length > 0 && systemStoreName.length <= 191, '请输入系统店铺名');
  assert(clientId.length <= 255, 'Client ID 不能超过 255 个字符');
  assert(clientSecret.length <= 10000, 'Client Secret 不能超过 10000 个字符');
  if (!editing) {
    assert(clientId.trim().length > 0, '新增店铺时必须填写 Client ID');
    assert(clientSecret.trim().length > 0, '新增店铺时必须填写 Client Secret');
  }
  return { walmartStoreName, systemStoreName, clientId, clientSecret };
}

function serializeStore(store) {
  const value = store.toJSON();
  return {
    id: value.id,
    walmartStoreName: value.walmartStoreName,
    systemStoreName: value.systemStoreName,
    clientId: value.clientId || '',
    clientSecret: value.clientSecret || '',
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export async function listStores() {
  const stores = await Store.findAll({
    order: [
      ['systemStoreName', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return stores.map(serializeStore);
}

export async function saveStore(id, input, actor) {
  const existing = id ? await Store.findByPk(Number(id)) : null;
  if (id) {
    assert(existing, '店铺不存在', 404);
    assert(existing.version === input.version, '店铺已被其他人修改，请刷新后重试', 409);
  }
  const patch = validateInput(input, Boolean(existing));
  const data = {
    walmartStoreName: patch.walmartStoreName,
    systemStoreName: patch.systemStoreName,
    ...(patch.clientId.trim() ? { clientId: patch.clientId } : {}),
    ...(patch.clientSecret.trim() ? { clientSecret: patch.clientSecret } : {}),
  };
  const result = await db.transaction(async (transaction) => {
    const store = existing
      ? await existing.update({ ...data, version: existing.version + 1 }, { transaction })
      : await Store.create({ ...data, version: 1 }, { transaction });
    await AuditLog.create(
      {
        userId: actor.id,
        action: existing ? 'edit_store' : 'create_store',
        entityId: String(store.id),
        details: { fields: Object.keys(data) },
      },
      { transaction },
    );
    return store;
  });
  return serializeStore(result);
}
