import { db } from '../src/models.js';
import { migratePurchaseConfirmation } from '../src/migrations/purchase-confirmation.js';

try {
  await migratePurchaseConfirmation();
  console.log('采购状态计时已就绪；历史未计时订单从本次升级时开始。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
