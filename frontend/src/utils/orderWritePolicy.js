/** 服务端权限为准；兼容尚未刷新列表时的旧响应。 */
export const canEditOrder = (row) =>
  row?.manualEditable !== false &&
  !['WFS', 'WFSFULFILLED'].includes(
    String(row?.fulfillmentParty ?? '')
      .trim()
      .toUpperCase(),
  );
