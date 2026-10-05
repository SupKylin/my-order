import { AppError } from '../errors.js';

/**
 * 单进程内串行处理高内存导入任务，避免同时解压多份工作簿。
 * 数据一致性仍由数据库事务和版本检查保证；此锁不是分布式锁。
 */
export function createExclusiveTask() {
  let running = false;
  return async function runExclusive(task) {
    if (running) throw new AppError(409, '另一份文件正在处理，请稍后重试');
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  };
}
