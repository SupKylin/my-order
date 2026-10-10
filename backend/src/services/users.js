import { db, User, AuditLog } from '../models.js';
import { ROLES } from '../fields.js';
import { hashPassword, publicUser } from '../auth.js';
import { assert } from '../errors.js';

/** 只允许修改公开账号字段，密码摘要及会话版本始终由服务端生成。 */
function validateUserInput(input, creating) {
  const patch = {};
  for (const key of ['username', 'displayName', 'role', 'active']) {
    if (Object.hasOwn(input, key)) patch[key] = input[key];
  }
  if (creating || Object.hasOwn(patch, 'username')) {
    assert(
      typeof patch.username === 'string' && /^[a-zA-Z0-9_.@-]{3,64}$/.test(patch.username),
      '账号须为 3 至 64 位字母、数字或 _ . @ -',
    );
  }
  if (creating || Object.hasOwn(patch, 'displayName')) {
    assert(
      typeof patch.displayName === 'string' &&
        patch.displayName.trim().length > 0 &&
        patch.displayName.length <= 100,
      '请输入姓名，最多 100 字',
    );
  }
  if (creating || Object.hasOwn(patch, 'role'))
    assert(Object.hasOwn(ROLES, patch.role), '角色无效');
  if (Object.hasOwn(patch, 'active')) assert(typeof patch.active === 'boolean', '启用状态无效');
  if (creating || input.password) {
    assert(
      typeof input.password === 'string' &&
        input.password.length >= 8 &&
        input.password.length <= 128,
      '密码须为 8 至 128 位',
    );
  }
  return patch;
}

export async function listUsers() {
  return (await User.findAll({ order: [['id', 'ASC']] })).map(publicUser);
}

export async function createUser(input, actor) {
  const patch = validateUserInput(input, true);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (transaction) => {
    const user = await User.create({ ...patch, passwordHash }, { transaction });
    await AuditLog.create(
      { userId: actor.id, action: 'create_user', entityId: String(user.id) },
      { transaction },
    );
    return publicUser(user);
  });
}

/** 修改角色或启用状态必须在同一个事务中检查最后一个总账号。 */
export async function updateUser(id, input, actor) {
  const patch = validateUserInput(input, false);
  const result = await db.transaction(async (transaction) => {
    // 固定加锁顺序，防止并发请求各自把对方误认为剩余的管理员。
    const users = await User.findAll({
      transaction,
      lock: transaction.LOCK.UPDATE,
      order: [['id', 'ASC']],
    });
    const user = users.find((candidate) => candidate.id === Number(id));
    assert(user, '账号不存在', 404);
    const removingAdmin = patch.active === false || (patch.role && patch.role !== 'admin');
    if (user.active && user.role === 'admin' && removingAdmin) {
      assert(
        users.some(
          (candidate) => candidate.id !== user.id && candidate.active && candidate.role === 'admin',
        ),
        '必须保留至少一个启用的总账号',
      );
    }
    if (input.password) patch.passwordHash = await hashPassword(input.password);
    if (input.password || patch.active === false) patch.sessionVersion = user.sessionVersion + 1;
    await user.update(patch, { transaction });
    await AuditLog.create(
      {
        userId: actor.id,
        action: 'edit_user',
        entityId: String(user.id),
        details: { fields: Object.keys(patch).filter((key) => key !== 'passwordHash') },
      },
      { transaction },
    );
    return user;
  });
  return publicUser(result);
}
