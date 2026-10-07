export const isPurchaseSuccess = (status) =>
  /^采购成功[未已]出跟踪号$/.test(String(status || '').replace(/[\s（）()]/g, ''));

export function purchaseWarning(row, now) {
  if (!isPurchaseSuccess(row.purchaseStatus) || String(row.trackingNumber || '').trim())
    return null;
  const confirmed = row.purchaseConfirmedAt ? Date.parse(row.purchaseConfirmedAt) : NaN;
  if (!Number.isFinite(confirmed))
    return String(row.purchaseStatus || '').replace(/[\s（）()]/g, '') === '采购成功未出跟踪号'
      ? { level: 'pending', text: '计时待初始化' }
      : null;
  const elapsed = Math.max(0, now - confirmed);
  const hour = 3600000;
  const level = elapsed >= 48 * hour ? 'red' : elapsed >= 24 * hour ? 'yellow' : 'waiting';
  const hours = (Math.floor(elapsed / 360000) / 10).toFixed(1);
  return { level, text: `${level === 'red' ? '强制处理' : '待填单号'} · 已等待 ${hours} 小时` };
}

export function confirmationTime(value) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
