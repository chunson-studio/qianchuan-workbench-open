'use strict';
function metricNumber(value) {
  if (value && typeof value === 'object') value = value.Value ?? value.ValueStr;
  if (value == null || typeof value === 'boolean') return null;
  const raw = String(value).trim().replace(/,/g, '').replace(/%$/, '');
  if (!raw || raw === '-' || raw === '--') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function marketingGoal(value, fallback = 2) {
  const n = Number(value ?? fallback);
  if (![1, 2].includes(n)) throw new Error('invalid_marketing_goal');
  return n;
}
module.exports = { metricNumber, marketingGoal };
