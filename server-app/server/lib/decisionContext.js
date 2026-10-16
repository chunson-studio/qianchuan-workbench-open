'use strict';

const { finiteNumber } = require('./dataContract');

const ROI_BASIS = Object.freeze({
  PAYMENT: 'payment',
  PLATFORM_NET_1H: 'platform_net_1h',
  FINAL_SETTLEMENT: 'final_settlement',
  CHENGFANG_COMPREHENSIVE: 'chengfang_comprehensive',
  UNKNOWN: 'unknown',
});

const FUNNEL_FIELDS = Object.freeze({
  show: ['counts', 'shows'],
  watch: ['counts', 'views'],
  click: ['counts', 'product_clicks'],
  order: ['counts', 'pay_orders'],
  showToWatchRate: ['rates', 'show_to_watch'],
  watchToClickRate: ['rates', 'watch_to_click'],
  watchToPayRate: ['rates', 'watch_to_pay'],
  clickToPayRate: ['rates', 'click_to_pay'],
});

function qualityFrom(validCount, totalCount) {
  if (validCount <= 0) return 'unavailable';
  if (validCount >= totalCount) return 'complete';
  return 'partial';
}

function normalizeFunnel(raw, options = {}) {
  const fallbackBaseline = options.baseline || null;
  if (!raw || typeof raw !== 'object') {
    return {
      window: options.window || 'current_session',
      source_at: options.sourceAt || null,
      data_valid: false,
      data_quality: 'unavailable',
      counts: { shows: null, views: null, product_clicks: null, pay_orders: null },
      rates: { show_to_watch: null, watch_to_click: null, watch_to_pay: null, click_to_pay: null },
      missing: Object.keys(FUNNEL_FIELDS),
      baseline: fallbackBaseline,
      comparison_status: fallbackBaseline ? 'available' : 'not_calibrated',
    };
  }

  const result = {
    window: raw.window || options.window || 'current_session',
    source_at: raw.source_at || raw.sourceAt || options.sourceAt || null,
    data_valid: false,
    data_quality: 'unavailable',
    counts: { shows: null, views: null, product_clicks: null, pay_orders: null },
    rates: { show_to_watch: null, watch_to_click: null, watch_to_pay: null, click_to_pay: null },
    missing: [],
    baseline: raw.baseline && typeof raw.baseline === 'object' ? raw.baseline : fallbackBaseline,
    comparison_status: 'not_calibrated',
  };

  const fieldValidity = raw.fieldValidity || raw.field_validity || {};
  const hasExplicitValidity = raw.dataValid != null || raw.data_valid != null || Object.keys(fieldValidity).length > 0;
  let validCount = 0;
  for (const [sourceKey, [group, outputKey]] of Object.entries(FUNNEL_FIELDS)) {
    const value = finiteNumber(raw[sourceKey] != null
      ? raw[sourceKey]
      : raw[group] && raw[group][outputKey]);
    const hasFieldFlag = Object.hasOwn(fieldValidity, sourceKey);
    const explicitlyValid = fieldValidity[sourceKey] === true;
    const valid = hasExplicitValidity
      ? (hasFieldFlag
        ? explicitlyValid
        : ((raw.dataValid === true || raw.data_valid === true || raw.dataQuality === 'partial' || raw.data_quality === 'partial') && value != null))
      : false;
    result[group][outputKey] = valid ? value : null;
    if (valid) validCount += 1;
    else result.missing.push(sourceKey);
  }
  result.data_quality = raw.dataQuality || raw.data_quality || qualityFrom(validCount, Object.keys(FUNNEL_FIELDS).length);
  result.data_valid = result.data_quality === 'complete';
  result.comparison_status = result.baseline ? 'available' : 'not_calibrated';
  return result;
}

function channelItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

function normalizeChannels(raw, options = {}) {
  const items = channelItems(raw).map(item => {
    const code = item && (item.code != null ? item.code : item.channel);
    const watch = finiteNumber(item && (item.watch_count != null ? item.watch_count : item.watch));
    const payCount = finiteNumber(item && (item.pay_count != null
      ? item.pay_count
      : item.pay_orders != null
        ? item.pay_orders
        : item.orders));
    const payAmount = finiteNumber(item && (item.pay_amount != null ? item.pay_amount : item.pay));
    const suppliedValidity = item && (item.fieldValidity || item.field_validity) || {};
    const explicit = item && (item.dataValid != null || item.data_valid != null);
    const explicitDataValid = item && (item.dataValid === true || item.data_valid === true);
    const fieldFlag = (camel, snake, value) => {
      if (Object.hasOwn(suppliedValidity, camel)) return suppliedValidity[camel] === true;
      if (Object.hasOwn(suppliedValidity, snake)) return suppliedValidity[snake] === true;
      return explicit ? (explicitDataValid && value != null) : value != null;
    };
    const watchValid = fieldFlag('watch', 'watch_count', watch);
    const payCountValid = fieldFlag('payCount', 'pay_count', payCount);
    const payAmountValid = fieldFlag('pay', 'pay_amount', payAmount);
    const codeValid = code != null && code !== '';
    const dataValid = codeValid && (watchValid || payCountValid || payAmountValid);
    return {
      code: codeValid ? String(code) : null,
      watch_count: dataValid && watchValid ? watch : null,
      pay_count: dataValid && payCountValid ? payCount : null,
      pay_amount: dataValid && payAmountValid ? payAmount : null,
      watch_share_pct: null,
      pay_share_pct: null,
      pay_amount_share_pct: null,
      data_valid: dataValid,
      field_validity: {
        watch_count: dataValid && watchValid,
        pay_count: dataValid && payCountValid,
        pay_amount: dataValid && payAmountValid,
      },
    };
  });
  const watchItems = items.filter(item => item.field_validity.watch_count);
  const payCountItems = items.filter(item => item.field_validity.pay_count);
  const payAmountItems = items.filter(item => item.field_validity.pay_amount);
  const watchTotal = watchItems.reduce((sum, item) => sum + item.watch_count, 0);
  const payCountTotal = payCountItems.reduce((sum, item) => sum + item.pay_count, 0);
  const payAmountTotal = payAmountItems.reduce((sum, item) => sum + item.pay_amount, 0);
  for (const item of items) {
    if (!item.data_valid) continue;
    if (item.field_validity.watch_count) {
      item.watch_share_pct = watchTotal > 0 ? +(item.watch_count / watchTotal * 100).toFixed(2) : 0;
    }
    if (item.field_validity.pay_count) {
      item.pay_share_pct = payCountTotal > 0 ? +(item.pay_count / payCountTotal * 100).toFixed(2) : 0;
    }
    if (item.field_validity.pay_amount) {
      item.pay_amount_share_pct = payAmountTotal > 0 ? +(item.pay_amount / payAmountTotal * 100).toFixed(2) : 0;
    }
  }
  const validCount = items.filter(item => item.data_valid).length;
  const metricCount = watchItems.length + payCountItems.length + payAmountItems.length;
  const expectedMetricCount = items.length * 3;
  const baseline = raw && !Array.isArray(raw) && raw.baseline && typeof raw.baseline === 'object'
    ? raw.baseline
    : (options.baseline || null);
  return {
    window: raw && !Array.isArray(raw) && raw.window || options.window || 'current_session',
    source_at: raw && !Array.isArray(raw) && (raw.source_at || raw.sourceAt) || options.sourceAt || null,
    data_valid: validCount > 0,
    data_quality: qualityFrom(metricCount, expectedMetricCount || 1),
    items,
    totals: {
      watch_count: watchItems.length > 0 ? watchTotal : null,
      pay_count: payCountItems.length > 0 ? payCountTotal : null,
      pay_amount: payAmountItems.length > 0 ? payAmountTotal : null,
    },
    baseline,
    comparison_status: baseline ? 'available' : 'not_calibrated',
  };
}

function buildLiveFinancialBasis() {
  return {
    spend: 'ad_spend',
    payment_gmv: ROI_BASIS.PAYMENT,
    payment_roi: ROI_BASIS.PAYMENT,
    net_gmv: ROI_BASIS.PLATFORM_NET_1H,
    net_roi: ROI_BASIS.PLATFORM_NET_1H,
    settlement_window: '1h',
    final_settlement_available: false,
  };
}

module.exports = {
  ROI_BASIS,
  normalizeFunnel,
  normalizeChannels,
  buildLiveFinancialBasis,
};
