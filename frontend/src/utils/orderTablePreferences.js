/** 删除失效列键，新字段补到末尾；固定列始终位于左侧。 */
export function orderedColumns(columns, preferences) {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const keys = new Set(['shopName', 'orderNumber', ...(preferences?.order || []), ...byKey.keys()]);
  return [...keys].map((key) => byKey.get(key)).filter(Boolean);
}
