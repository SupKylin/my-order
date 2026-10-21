import { db } from '../src/models.js';
import { migrateHome } from '../src/services/home/model.js';
import { migrateOrderTablePreferences } from '../src/migrations/order-table-preferences.js';
import { migratePermissionsAudit } from '../src/migrations/permissions-audit.js';
import { migrateWalmart } from '../src/migrations/walmart.js';
import { migrateDictionaries, migrateOrderFields, migrateStores } from '../src/migrations.js';

try {
  await migrateOrderTablePreferences();
  await migrateDictionaries();
  await migrateStores();
  await migrateOrderFields();
  await migrateWalmart();
  await migratePermissionsAudit();
  await migrateHome();
  console.log('字典、店铺、模板与订单字段增量升级完成，已有订单和模板保留。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
