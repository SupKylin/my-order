import test from 'node:test';
import assert from 'node:assert/strict';
import { businessClocks } from '../src/utils/businessTime.js';

test('中美时钟显示完整日期及秒数，冬夏均保持 13 小时时差', () => {
  for (const month of ['01', '07']) {
    assert.deepEqual(businessClocks(Date.parse(`2026-${month}-15T17:06:07Z`)), {
      china: `2026-${month}-16 01:06:07`,
      platform: `2026-${month}-15 12:06:07`,
    });
  }
});

test('午夜使用 00 点，跨年与夏令时切换日仍按固定 EST 显示', () => {
  assert.deepEqual(businessClocks(Date.parse('2027-01-01T05:00:00Z')), {
    china: '2027-01-01 13:00:00',
    platform: '2027-01-01 00:00:00',
  });
  assert.deepEqual(businessClocks(Date.parse('2026-03-08T07:00:00Z')), {
    china: '2026-03-08 15:00:00',
    platform: '2026-03-08 02:00:00',
  });
});
