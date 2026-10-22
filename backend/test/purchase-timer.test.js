import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import {
  purchaseTimerPatch,
  isPurchaseSuccess,
  PURCHASE_SUCCESS_PATTERN,
  PURCHASE_UNTRACKED_PATTERN,
} from '../src/lib/purchase-timer.js';
import { purchaseWarning, confirmationTime } from '../../frontend/src/utils/purchaseWarning.js';
import { buildFilters } from '../src/services/orders.js';
import { serializeItem } from '../src/models.js';
import { validatePatch } from '../src/validation.js';
import { migratePurchaseConfirmation } from '../src/migrations/purchase-confirmation.js';

const hour = 3600000;
const start = new Date('2026-10-09T23:00:00+08:00');
const status = '采购成功（未出跟踪号）';
const row = {
  purchaseStatus: status,
  purchaseConfirmedAt: start.toISOString(),
  trackingNumber: null,
};

test('SQL 状态正则在 Unicode 和旧版 MySQL 字节匹配下都识别中文状态', () => {
  const cases = [
    ['采购成功未出跟踪号', true, true],
    ['采购成功已出跟踪号', true, false],
    ['采购成功（未出跟踪号）', true, true],
    ['采购成功(已出跟踪号)', true, false],
    ['采购成功 （ 未出跟踪号 ） ', true, true],
    ['采购成功\t(已出跟踪号)\n', true, false],
    ['采购失败', false, false],
    ['采购成功（砍单）', false, false],
    ['采购成功未已出跟踪号', false, false],
    ['采购成功未出跟踪号额外文字', false, false],
  ];
  for (const byteMatching of [false, true]) {
    const encode = (value) =>
      byteMatching ? Buffer.from(value, 'utf8').toString('latin1') : value;
    for (const [pattern, expectedIndex] of [
      [PURCHASE_SUCCESS_PATTERN, 1],
      [PURCHASE_UNTRACKED_PATTERN, 2],
    ]) {
      // 用单字节字符串模拟旧引擎，POSIX 空白集合转换为 JS 对应集合。
      const regexp = new RegExp(encode(pattern).replaceAll('[[:space:]]', '[\\t\\n\\r\\v\\f ]'));
      for (const entry of cases)
        assert.equal(regexp.test(encode(entry[0])), entry[expectedIndex], entry[0]);
    }
  }
});

test('采购状态自动启动计时，重复编辑、导入及已出/未出切换保留原时间', () => {
  const entered = purchaseTimerPatch(
    { purchaseStatus: '采购中' },
    { purchaseStatus: status },
    { now: start },
  );
  assert.equal(entered.purchaseConfirmedAt, start);
  let current = { ...entered, trackingNumber: null };
  for (const patch of [
    { purchaseStatus: status },
    { purchaseNote: '普通编辑' },
    { trackingNumber: 'TRACK123' },
    { purchaseStatus: '采购成功（已出跟踪号）' },
    { trackingNumber: null },
    { purchaseStatus: status },
  ]) {
    current = {
      ...current,
      ...purchaseTimerPatch(current, patch, { now: new Date(+start + 50 * hour) }),
    };
    assert.equal(current.purchaseConfirmedAt, start);
  }
  assert.equal(purchaseWarning(current, +start + 50 * hour).level, 'red');
  assert.equal(
    purchaseWarning({ ...current, trackingNumber: 'TRACK123' }, +start + 50 * hour),
    null,
  );
  assert.equal(isPurchaseSuccess('采购成功（砍单）'), false);
});

test('空值及非成功状态进入任一成功状态时记录时间，退出成功状态清空', () => {
  for (const resetStatus of ['采购中', '砍单', '采购失败', '取消订单', '采购成功（砍单）', null]) {
    const reset = purchaseTimerPatch(row, { purchaseStatus: resetStatus });
    assert.equal(reset.purchaseConfirmedAt, null);
    assert.equal(purchaseWarning(reset, +start + 50 * hour), null);
    const later = new Date(+start + 51 * hour);
    for (const success of [
      status,
      '采购成功（已出跟踪号）',
      '采购成功未出跟踪号',
      '采购成功已出跟踪号',
    ])
      assert.equal(
        purchaseTimerPatch(reset, { purchaseStatus: success }, { now: later }).purchaseConfirmedAt,
        later,
      );
  }
  assert.equal(
    purchaseTimerPatch(null, { purchaseStatus: '采购成功已出跟踪号' }, { now: start })
      .purchaseConfirmedAt,
    start,
  );
  assert.equal(purchaseWarning({ purchaseStatus: '采购成功已出跟踪号' }, +start), null);
});
test('未导入采购状态不补写时间，历史成功状态没有时间时也不伪造成功时间', () => {
  for (const purchaseStatus of [status, '采购成功（已出跟踪号）']) {
    const previous = { purchaseStatus, purchaseConfirmedAt: null };
    assert.deepEqual(purchaseTimerPatch(previous, { purchaseNote: '普通导入' }), {
      purchaseNote: '普通导入',
    });
    assert.equal(purchaseTimerPatch(previous, { purchaseStatus }).purchaseConfirmedAt, null);
  }
});

test('24/48 小时边界精确，夜间、周末与页面重载不扣除等待时间', () => {
  for (const [elapsed, level] of [
    [0, 'waiting'],
    [24 * hour - 1, 'waiting'],
    [24 * hour, 'yellow'],
    [48 * hour - 1, 'yellow'],
    [48 * hour, 'red'],
    [72 * hour, 'red'],
  ]) {
    const warning = purchaseWarning(JSON.parse(JSON.stringify(row)), +start + elapsed);
    assert.equal(warning.level, level);
    assert.match(warning.text, level === 'red' ? /^强制处理/ : /^待填单号/);
  }
  assert.match(purchaseWarning(row, +start + 1.5 * hour).text, /已等待 1\.5 小时/);
  assert.match(confirmationTime(start), /23:00:00/);
  assert.equal(purchaseWarning({ ...row, trackingNumber: ' \n ' }, +start).level, 'waiting');
  assert.equal(purchaseWarning({ ...row, trackingNumber: '0' }, +start), null);
});

test('服务器筛选按同一 24/48 小时边界，和价格、渠道、状态筛选取交集', () => {
  const now = +start + 60 * hour;
  for (const [level, expected] of [
    ['waiting', { [Op.gt]: new Date(now - 24 * hour) }],
    ['yellow', { [Op.gt]: new Date(now - 48 * hour), [Op.lte]: new Date(now - 24 * hour) }],
    ['red', { [Op.lte]: new Date(now - 48 * hour) }],
  ]) {
    const filters = buildFilters(
      {
        trackingWarning: level,
        priceType: 'orderAmount',
        minPrice: '10',
        purchaseChannel: '渠道A',
        purchaseStatus: status,
      },
      now,
    );
    assert.deepEqual(
      filters.where[Op.and].find((condition) =>
        Object.hasOwn(condition, '$purchase.purchaseConfirmedAt$'),
      ),
      { '$purchase.purchaseConfirmedAt$': expected },
    );
    assert.deepEqual(filters.where.orderAmount, { [Op.gte]: '10.00' });
    assert.equal(filters.include[1].where[Op.or].length, 1);
    assert.equal(filters.include[1].where.purchaseStatus, status);
  }
  // 数据权限会附加独立 AND 条件，不能再假定提醒范围是最后一项。
  assert.equal(buildFilters({ trackingWarning: 'all' }, now).where[Op.and].length, 4);
  assert.deepEqual(buildFilters({ trackingWarning: '' }, now).where[Op.and], [{}]);
  assert.throws(() => buildFilters({ trackingWarning: 'invalid' }), /未出跟踪号筛选无效/);
});

test('计时字段仅由服务端维护、序列化读取；客户端和 Excel 无法伪造', () => {
  assert.throws(() => validatePatch({ purchaseConfirmedAt: start }), /不支持的字段/);
  const snapshot = serializeItem({ id: 1, purchase: row });
  assert.equal(snapshot.purchaseConfirmedAt, start.toISOString());
  assert.equal(purchaseWarning(snapshot, +start + 48 * hour).level, 'red');
});

test('增量迁移仅添加可空列并初始化空计时，不用订单或上传时间回填', async () => {
  const added = [],
    updates = [];
  const query = {
    describeTable: async () => (added.length ? { purchaseConfirmedAt: {} } : {}),
    addColumn: async (...args) => added.push(args),
    sequelize: { query: async (...args) => updates.push(args) },
  };
  await migratePurchaseConfirmation(query);
  await migratePurchaseConfirmation(query);
  assert.equal(added.length, 1);
  assert.equal(added[0][0], 'purchases');
  assert.equal(added[0][1], 'purchaseConfirmedAt');
  assert.equal(added[0][2].allowNull, true);
  for (const [sql, options] of updates) {
    assert.match(sql, /purchaseConfirmedAt IS NULL/);
    assert.match(sql, /CURRENT_TIMESTAMP\(3\)/);
    assert.match(options.replacements.pattern, /未出跟踪号/);
    assert.doesNotMatch(sql, /createdAt|updatedAt|orderDate|upload/i);
  }
});
