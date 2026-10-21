/** 汇总已授权且符合查询条件的店铺快照；缺失值不能视为零。 */
export function settlementSummary(stores, today) {
  let cents = 0n;
  let available = 0;
  let historical = 0;
  for (const store of stores) {
    const metric = store.remote?.settlement;
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(metric?.value ?? ''));
    if (!match) continue;
    const fraction = (match[3] || '').padEnd(3, '0');
    const amount =
      BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2)) + (fraction[2] >= '5' ? 1n : 0n);
    cents += match[1] ? -amount : amount;
    available++;
    if (metric.status !== 'ok' || store.snapshotDate !== today) historical++;
  }
  const absolute = cents < 0n ? -cents : cents;
  return {
    value: available
      ? `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
      : '—',
    available,
    missing: stores.length - available,
    historical,
  };
}
