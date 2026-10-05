import { db } from '../src/models.js';
import { migrateDictionaries, migrateOrderFields } from '../src/migrations.js';

try {
  await migrateDictionaries();
  await migrateOrderFields();
  console.log('字典、模板与订单字段增量升级完成，已有订单和模板保留。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
