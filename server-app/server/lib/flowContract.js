'use strict';

const FLOW_ROLES = Object.freeze({
  5: 'instant_alert',
  15: 'canonical_control',
  30: 'confirmation',
  60: 'long_horizon',
});

const FLOW_CONTRACT = Object.freeze({
  version: '2.0',
  unit: 'CNY_per_hour',
  canonical_window_minutes: 15,
  canonical_slice: 'm15',
  canonical_field: 'marginal.m15.spend_rate_hour',
  total_field: 'marginal.m15.total_spend_rate_hour',
  basic_field: 'marginal.m15.basic_spend_rate_hour',
  assist_field: 'marginal.m15.assist_spend_rate_hour',
  assist_share_field: 'marginal.m15.assist_share_pct',
  instant_alert_window_minutes: 5,
  confirmation_window_minutes: 30,
  session_average_name: 'session_average_flow',
  session_average_formula: 'session_spend / elapsed_live_minutes * 60',
  decision_rule: 'm15_total_capacity_basic_controls_plan_assist_controls_boost_m5_alert_m30_confirm',
  split_rule: 'total=basic+assist; require flow_split_quality=complete for plan_or_boost_attribution',
});

function withFlowRole(slice, minutes) {
  return {
    ...slice,
    flow_role: FLOW_ROLES[minutes] || 'unsupported',
  };
}

module.exports = { FLOW_CONTRACT, FLOW_ROLES, withFlowRole };
