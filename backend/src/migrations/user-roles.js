import { DataTypes } from 'sequelize';
import { db } from '../models.js';
import { ROLES } from '../fields.js';

/** 仅在原 ENUM 末尾增加主管角色，保留账号和原有角色取值。 */
export async function migrateUserRoles() {
  const query = db.getQueryInterface();
  const columns = await query.describeTable('users');
  if (!columns.role.type.includes("'supervisor'"))
    await query.changeColumn('users', 'role', {
      type: DataTypes.ENUM(...Object.keys(ROLES)),
      allowNull: false,
    });
}
