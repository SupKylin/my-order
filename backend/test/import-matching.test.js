import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelKey } from '../src/lib/order-identity.js';
import { matchImportRows } from '../src/lib/import-matching.js';

const row = (orderNumber, purchaseChannel) => ({ patch: { orderNumber, purchaseChannel } });
const item = (id, orderNumber, channels) => ({
  id,
  orderNumber,
  purchaseChannelKey: channelKey(channels),
});
const ids = (rows, existing) => matchImportRows(rows, existing).map((target) => target?.id ?? null);

test('无渠道旧明细按订单号逐条匹配，超出才新增，不匹配其他订单', () => {
  assert.deepEqual(
    ids(
      [row('A', ['X']), row('A', ['Y']), row('A', ['X'])],
      [item(1, 'A'), item(2, 'A'), item(3, 'B')],
    ),
    [1, 2, null],
  );
});

test('先保留同渠道目标，再按文件顺序分配剩余空渠道明细', () => {
  assert.deepEqual(
    ids(
      [row('A', ['Y']), row('A', ['X']), row('A'), row('A', ['Y'])],
      [item(1, 'A'), item(2, 'A', ['X']), item(3, 'A'), item(4, 'A', ['Z'])],
    ),
    [3, 2, 1, null],
  );
});

test('已有渠道不能被其他渠道或空渠道覆盖，多选集合忽略顺序', () => {
  assert.deepEqual(
    ids(
      [row('A'), row('A', ['Z']), row('A', ['Y', 'X']), row('A', ['X'])],
      [item(1, 'A', ['X', 'Y']), item(2, 'A', ['X'])],
    ),
    [null, null, 1, 2],
  );
});
