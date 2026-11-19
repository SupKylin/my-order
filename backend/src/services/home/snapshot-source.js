import { createHash } from 'node:crypto';
export function snapshotSource(store) {
  return (
    createHash('sha256')
      // 区分只存平台指标的新快照，回退旧版时可自动重建其所需的订单快照。
      .update(
        JSON.stringify([
          'seller-performance-finance-pst-v6',
          store.systemStoreName,
          store.clientId,
          store.clientSecret,
        ]),
      )
      .digest('hex')
  );
}
