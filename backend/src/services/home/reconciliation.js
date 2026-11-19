import { SELLER_REFUND_VERSION } from './seller-refund.js';
import { amountText, amountUnits, pstDay } from './statistics.js';

export const RECON_VERSION = 2;
const START = '2026-10-01';
const DAY = 86400000;
const REFUND_CHARGES = new Set(['product price', 'shipping', 'product tax', 'shipping tax']);
const NON_CUSTOMER_CHARGES = new Set([
  'product tax withheld',
  'shipping tax withheld',
  'commission on product',
  'commission on shipping',
  'fee/reimbursement',
  'item fees',
  // 平台资助及超额退款调整属于卖家结算费用，不是客户实际退款。
  'total walmart funded savings',
  'excessrefundadjustment',
  'excess refund adjustment',
]);

function reportDay(value) {
  const match = /^(\d{2})\/?(\d{2})\/?(\d{4})$/.exec(String(value || ''));
  if (!match) throw new Error('财务对账报表日期无效');
  const date = `${match[3]}-${match[1]}-${match[2]}`;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new Error('财务对账报表日期无效');
  return date;
}

function signedUnits(value) {
  if (typeof value === 'boolean' || !/^-?\d+(\.\d+)?$/.test(String(value ?? '')))
    throw new Error('退款金额无效');
  return (String(value).startsWith('-') ? -1n : 1n) * amountUnits(String(value).replace(/^-/, ''));
}

function signedText(units) {
  // 缓存保留精确值，退款冲正必须先抵减，不能逐行取绝对值。
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  const scale = 10n ** 20n;
  return `${sign}${absolute / scale}.${String(absolute % scale).padStart(20, '0')}`;
}

/** 官方 v1 JSON 的 offset 是字节偏移，必须使用 nextOffset，不能按条数推算。 */
async function fetchReport(client, date) {
  let offset = 0,
    start = null,
    end = null;
  const seen = new Set(),
    refunds = new Map(),
    postedRefunds = new Map(),
    payments = new Map(),
    paymentIssues = new Set();
  const sellerRefundRows = [];
  let datesComplete = true;
  for (let page = 0; page < 1000; page++) {
    if (seen.has(offset)) throw new Error('财务对账分页重复，数据未完整获取');
    seen.add(offset);
    const body = await client.request(
      `/v3/report/reconreport/reconFileJson?reportDate=${date}&offset=${offset}&noOfRecords=1000`,
    );
    if (!Array.isArray(body?.reportData)) throw new Error('财务对账明细尚不可用');
    if (Number(body.totalRecords) !== body.reportData.length)
      throw new Error('财务对账明细条数不完整');
    for (const row of body.reportData) {
      const transactionType = String(row['Transaction Type']).trim().toLowerCase();
      // 广告、仓储等 Service Fee 有自己的分段账期，不能用作整份报表覆盖范围。
      if (transactionType === 'paymentsummary') {
        if (!row['Period Start Date'] || !row['Period End Date'])
          throw new Error('财务对账缺少账期范围');
        const nextStart = reportDay(row['Period Start Date']);
        const nextEnd = reportDay(row['Period End Date']);
        if (nextStart > nextEnd || (start && (start !== nextStart || end !== nextEnd)))
          throw new Error('财务对账账期不一致');
        start = nextStart;
        end = nextEnd;
        // 按已结束账期直接展示官方 Total Payable，不额外验证支付描述。
        const amount = row['Total Payable'];
        const currency = String(row.Currency || '')
          .trim()
          .toUpperCase();
        if (!/^-?\d+(\.\d{1,20})?$/.test(String(amount ?? ''))) paymentIssues.add('payment_amount');
        if (!['', 'USD'].includes(currency)) paymentIssues.add('payment_currency');
        if (!paymentIssues.size) {
          const key =
            row['Transaction Key'] ||
            JSON.stringify([nextStart, nextEnd, amount, row['Transaction Posted Timestamp']]);
          payments.set(key, signedUnits(amount));
        }
      }
      if (transactionType !== 'refund') continue;
      const type = String(row['Amount Type'] || '')
        .trim()
        .toLowerCase();
      if (REFUND_CHARGES.has(type) || NON_CUSTOMER_CHARGES.has(type)) {
        const currency = String(row.Currency || '')
          .trim()
          .toUpperCase();
        if (currency && currency !== 'USD') throw new Error('退款报表含非 USD 金额');
        sellerRefundRows.push({
          transaction: String(row['Transaction Key'] || '').trim(),
          order: String(row['Customer Order #'] || '').trim(),
          sku: String(row['Partner Item Id'] || '').trim(),
          po: String(row['Purchase Order #'] || '').trim(),
          orderLine: String(row['Purchase Order line #'] || '').trim(),
          type,
          amount: signedText(signedUnits(row.Amount)),
          customer: REFUND_CHARGES.has(type),
        });
      }
      if (NON_CUSTOMER_CHARGES.has(type)) continue;
      if (!REFUND_CHARGES.has(type)) throw new Error('财务对账包含尚未识别的退款费用类型');
      // 美国站 v1 报表实际以空 Currency 返回 USD；显式其他币种不混算。
      const currency = String(row.Currency || '')
        .trim()
        .toUpperCase();
      if (currency && currency !== 'USD') throw new Error('退款报表含非 USD 金额');
      const order = String(row['Customer Order #'] || '').trim();
      if (!order) throw new Error('退款明细缺少客户订单号');
      refunds.set(order, (refunds.get(order) || 0n) - signedUnits(row.Amount));
      try {
        const posted = transactionDay(row['Transaction Posted Timestamp']);
        postedRefunds.set(posted, (postedRefunds.get(posted) || 0n) - signedUnits(row.Amount));
      } catch {
        datesComplete = false;
      }
    }
    const next = Number(body.nextOffset);
    if (body.nextOffset == null || !Number.isSafeInteger(next) || next < -1)
      throw new Error('财务对账缺少有效的分页结束标识');
    if (next === -1) {
      if (!start || !end) throw new Error('财务对账缺少账期范围');
      return {
        start,
        end,
        financeFormat: 2,
        sellerRefundVersion: SELLER_REFUND_VERSION,
        sellerRefundRows,
        datesComplete,
        postedRefunds: [...postedRefunds].map(([day, units]) => [day, signedText(units)]),
        paidAmount:
          !paymentIssues.size && payments.size
            ? signedText([...payments.values()].reduce((a, b) => a + b, 0n))
            : null,
        paymentIssues: [...paymentIssues],
        refunds: [...refunds].map(([order, units]) => [order, signedText(units)]),
      };
    }
    if (next <= offset) throw new Error('财务对账分页未前进');
    offset = next;
  }
  throw new Error('财务对账分页超出安全上限，数据未完整获取');
}

/** 完整账期缓存到现有快照 JSON；每日只查询报表目录和新增账期，不重复下载历史明细。 */
export async function fetchReconciliation(client, previous = {}, now = new Date()) {
  const result = {
    version: RECON_VERSION,
    reports: previous.version === RECON_VERSION ? { ...previous.reports } : {},
    status: 'error',
    attemptedAt: now.toISOString(),
  };
  try {
    const body = await client.request(
      '/v3/report/reconreport/availableReconFiles?reportVersion=v1',
    );
    if (!Array.isArray(body?.availableApReportDates))
      throw new Error('未获取到官方财务对账报表目录');
    const dates = [...new Set(body.availableApReportDates)]
      .map((value) => ({ value, date: reportDay(value) }))
      .filter(({ date }) => date >= START)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (dates.length > 100) throw new Error('财务对账账期超出单次采集上限');
    // 目录失去的账期不能继续当作已完整获取。
    result.reports = Object.fromEntries(
      dates
        .filter(({ value }) => result.reports[value])
        .map(({ value }) => [value, result.reports[value]]),
    );
    result.availableDates = dates.map(({ value }) => value);
    let firstError;
    for (const { value } of dates) {
      if (
        result.reports[value]?.financeFormat === 2 &&
        result.reports[value]?.sellerRefundVersion === SELLER_REFUND_VERSION
      )
        continue;
      try {
        result.reports[value] = await fetchReport(client, value);
      } catch (error) {
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
    result.status = 'ok';
    result.fetchedAt = now.toISOString();
  } catch (error) {
    result.error =
      error.apiStatus === 401 || error.apiStatus === 403
        ? '财务对账接口未授权，请检查店铺 API 权限'
        : String(error.message).slice(0, 300);
  }
  return result;
}

/** 按原订单归集已出报表退款；缺少新账期时展示历史结果，明确标为非完整金额。 */
export function reconciliationTotals(cache) {
  const reports = Object.values(cache?.version === RECON_VERSION ? cache.reports || {} : {}).sort(
    (a, b) => a.start.localeCompare(b.start),
  );
  const totals = new Map();
  let through = null;
  for (const report of reports) {
    const contiguous = through
      ? Date.parse(`${report.start}T00:00:00Z`) <= Date.parse(`${through}T00:00:00Z`) + DAY
      : report.start <= START;
    if (contiguous && (!through || report.end > through)) through = report.end;
    for (const [order, amount] of report.refunds)
      totals.set(order, (totals.get(order) || 0n) + signedUnits(amount));
  }
  const valid = cache?.version === RECON_VERSION && cache.status === 'ok';
  const latest =
    reports
      .map((report) => report.end)
      .sort()
      .at(-1) || null;
  return {
    amount(order) {
      const units = totals.get(order) || 0n;
      return amountText(units > 0n ? units : 0n);
    },
    state(date) {
      if (reports.length && (!valid || !through || date > through))
        return {
          refundStatus: 'partial',
          refundMessage: `仅累计已取得报表中的实际退款（含税），最新账期截至 ${latest}；未出具或未取得的账期不计入，0 仅表示已取得报表未记录该日订单退款，并非最终退款为零。${cache?.error || ''}`,
          refundAsOf: latest,
        };
      if (!valid)
        return {
          refundStatus: 'unavailable',
          refundMessage: cache?.error || '官方财务对账数据尚未完整获取',
          refundAsOf: through,
        };
      if (!through || date > through)
        return {
          refundStatus: 'pending',
          refundMessage: '该下单日期尚未被完整的官方财务账期覆盖，待出报表',
          refundAsOf: through,
        };
      return {
        refundStatus: 'ok',
        refundMessage: `实际退款（含税），截至官方账期 ${through}；后续退款在新报表发布后更新`,
        refundAsOf: through,
      };
    },
  };
}

/** 官方无时区的日期不猜具体时刻；带时区时间戳转换为固定 PST 日期。 */
export function transactionDay(value) {
  const text = String(value || '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) return reportDay(text);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text)
      throw new Error('交易日期无效');
    return text;
  }
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)))
    return pstDay(Date.parse(text));
  throw new Error('退款明细缺少有效交易日期');
}
function money(units) {
  return units < 0n ? `-${amountText(-units)}` : amountText(units);
}

export function storeFinance(cache, now = Date.now()) {
  const today = pstDay(now),
    monthStart = today.slice(0, 7) + '-01';
  const reports = cache?.version === RECON_VERSION ? Object.entries(cache.reports || {}) : [];
  const ended = reports
    .filter(([, r]) => r.end < today)
    .sort(
      (a, b) => b[1].end.localeCompare(a[1].end) || reportDay(b[0]).localeCompare(reportDay(a[0])),
    );
  const latest = ended[0];
  const requestFailed = cache?.status === 'error';
  const requestError = cache?.error || '财务报表请求失败，请稍后重试';
  const base = { fetchedAt: cache?.fetchedAt };
  const unavailable = (statusText, error) => ({
    ...base,
    status: requestFailed ? 'error' : 'pending',
    statusText: requestFailed ? '接口请求失败' : !cache ? '等待同步' : statusText,
    error: requestFailed ? requestError : !cache ? '尚未同步官方财务报表' : error,
  });
  let previousPayment = unavailable('待出已结束账期报表', '尚未取得最近已结束账期的实际支付记录');
  if (latest) {
    const [date, r] = latest;
    previousPayment = {
      ...previousPayment,
      periodStart: r.start,
      periodEnd: r.end,
      reportUpdatedAt: reportDay(date),
    };
    const newerMissing = (cache.availableDates || []).some(
      (d) => reportDay(d) > reportDay(date) && !cache.reports[d],
    );
    if (!requestFailed) {
      const reasons = {
        payment_amount: 'Total Payable 缺失或格式无效',
        payment_currency: '支付金额币种不是 USD',
      };
      previousPayment.status = 'pending';
      previousPayment.statusText = '报表金额暂不可用';
      previousPayment.error = newerMissing
        ? '较新的报表尚未完整取得，无法确认上期支付金额'
        : (r.paymentIssues || [])
            .map((reason) => reasons[reason])
            .filter(Boolean)
            .join('；') || '已取得账期报表，但缺少有效的 Total Payable，等待重新同步';
    }
    if (r.financeFormat === 2 && r.paidAmount != null && !newerMissing)
      previousPayment = {
        ...previousPayment,
        value: money(signedUnits(r.paidAmount)),
        status: cache.status === 'ok' ? 'ok' : 'partial',
        statusText: cache.status === 'ok' ? undefined : '历史金额 · 更新失败',
        error: cache.status === 'ok' ? undefined : `展示最近可用已结束账期；${requestError}`,
      };
  }
  const relevant = reports.filter(([, r]) => r.end >= monthStart && r.start <= today);
  let monthlyRefund = {
    ...unavailable('待出当月报表', '尚未取得覆盖当月的报表，不能将当月退款额视为 0'),
    periodStart: monthStart,
    periodEnd: today,
  };
  if (relevant.length && relevant.every(([, r]) => r.financeFormat === 2 && r.datesComplete)) {
    let total = 0n,
      through = null;
    for (const [, r] of relevant.sort((a, b) => a[1].start.localeCompare(b[1].start))) {
      if (
        r.start <=
        (through
          ? new Date(Date.parse(through + 'T00:00:00Z') + DAY).toISOString().slice(0, 10)
          : monthStart)
      )
        through = through && through > r.end ? through : r.end;
      for (const [date, amount] of r.postedRefunds)
        if (date >= monthStart && date <= today) total += signedUnits(amount);
    }
    const complete = cache.status === 'ok' && through && through >= today;
    monthlyRefund = {
      ...monthlyRefund,
      value: money(total),
      status: complete ? 'ok' : 'partial',
      statusText: complete ? undefined : requestFailed ? '部分金额 · 更新失败' : '数据未完整覆盖',
      reportUpdatedAt: relevant
        .map(([date]) => reportDay(date))
        .sort()
        .at(-1),
      coverageThrough: through && through < today ? through : through ? today : null,
      error: complete
        ? undefined
        : `当月退款未完整覆盖；金额仅含已取得报表，未出账期未计入${requestFailed ? `；${requestError}` : ''}`,
    };
  } else if (relevant.length && !requestFailed) {
    monthlyRefund.status = 'unverified';
    monthlyRefund.statusText = '退款数据待核实';
    monthlyRefund.error = '退款交易日期缺失或缓存待更新，无法按月确认退款额';
  }
  return { previousPayment, monthlyRefund };
}
