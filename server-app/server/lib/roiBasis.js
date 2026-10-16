'use strict';

// ROI 数字只有和口径一起才有意义。这里集中维护可公开的口径枚举、
// 从千川真实计划/追投元数据做保守推断，以及 ROI 写入前的一致性校验。
const ROI_BASES = Object.freeze([
  'payment',
  'platform_net_1h',
  'final_settlement',
  'chengfang_comprehensive',
  'unknown',
]);
const ROI_BASIS_SET = new Set(ROI_BASES);

function firstDefined(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] != null) return object[key];
  }
  return undefined;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolOrNull(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function editable(operation, names) {
  if (!operation || typeof operation !== 'object') return null;
  for (const name of names) {
    const item = operation[name];
    if (item && typeof item === 'object' && typeof item.editable === 'boolean') return item.editable;
    if (typeof item === 'boolean') return item;
  }
  return null;
}

function normalizeRoiBasis(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return ROI_BASIS_SET.has(normalized) ? normalized : null;
}

function extractOptimizationMetadata(entity) {
  const value = entity && typeof entity === 'object' ? entity : {};
  const operation = firstDefined(value, ['operation', 'Operation']) || {};
  const smartBidType = finiteOrNull(firstDefined(value, ['smartBidType', 'SmartBidType', 'smart_bid_type']));
  const marGoal = finiteOrNull(firstDefined(value, ['marGoal', 'MarGoal', 'mar_goal']));
  const externalAction = finiteOrNull(firstDefined(value, ['externalAction', 'ExternalAction', 'external_action']));
  const deepExternalAction = finiteOrNull(firstDefined(value, ['deepExternalAction', 'DeepExternalAction', 'deep_external_action']));
  const deepExternalActionName = firstDefined(value, [
    'deepExternalActionName',
    'DeepExternalActionName',
    'deep_external_action_name',
  ]);
  const isOverallRoi = boolOrNull(firstDefined(value, ['isOverallRoi', 'IsOverallRoi', 'is_overall_roi']));
  const bid = finiteOrNull(firstDefined(value, ['bid', 'Bid']));
  const roiGoal = finiteOrNull(firstDefined(value, ['ecpRoi2Goal', 'EcpRoi2Goal', 'roi_goal', 'roiGoal']));

  let biddingMode = null;
  if (bid != null && bid > 0) biddingMode = 'manual_bid';
  else if (smartBidType === 7) biddingMode = 'volume';
  else if (roiGoal != null) biddingMode = 'roi_goal';

  return {
    smart_bid_type: smartBidType,
    bidding_mode: biddingMode,
    mar_goal: marGoal,
    external_action: externalAction,
    deep_external_action: deepExternalAction,
    deep_external_action_name: deepExternalActionName == null ? null : String(deepExternalActionName),
    is_overall_roi: isOverallRoi,
    roi_goal_editable: editable(operation, ['roi2GoalOperation', 'roiGoalOperation', 'ecpRoiGoalEdit']),
    budget_editable: editable(operation, ['budgetEditOperation', 'budgetOperation']),
    status_editable: editable(operation, ['optStatusOperation', 'statusOperation']),
  };
}

function inferRoiGoalBasis(entity) {
  const value = entity && typeof entity === 'object' ? entity : {};
  const explicit = normalizeRoiBasis(firstDefined(value, [
    'roi_goal_basis',
    'roiGoalBasis',
    'roi_basis',
    'roiBasis',
  ]));
  if (explicit && explicit !== 'unknown') {
    return { basis: explicit, source: 'explicit_metadata', optimization: extractOptimizationMetadata(value) };
  }

  const optimization = extractOptimizationMetadata(value);
  if (optimization.is_overall_roi === true) {
    return { basis: 'chengfang_comprehensive', source: 'is_overall_roi', optimization };
  }

  // 已在本项目抓包资料中确认：326=支付 ROI 建议目标，576=平台净成交 ROI 目标。
  // 576 对应当前平台 1 小时结算回流，绝不能升级为最终结算口径。
  if (optimization.deep_external_action === 326) {
    return { basis: 'payment', source: 'deep_external_action', optimization };
  }
  if (optimization.deep_external_action === 576) {
    return { basis: 'platform_net_1h', source: 'deep_external_action', optimization };
  }

  // 只识别明确的上游名称；含糊的“结算/ROI”不做猜测。
  const label = String(optimization.deep_external_action_name || '').trim().toLowerCase();
  if (/综合\s*roi|overall\s*roi/.test(label)) {
    return { basis: 'chengfang_comprehensive', source: 'deep_external_action_name', optimization };
  }
  if (/最终结算|final[ _-]*settlement/.test(label)) {
    return { basis: 'final_settlement', source: 'deep_external_action_name', optimization };
  }
  if (/支付\s*roi|pure[ _-]*pay|payment/.test(label)) {
    return { basis: 'payment', source: 'deep_external_action_name', optimization };
  }
  if (/1\s*h|1\s*小时|净成交\s*roi/.test(label)) {
    return { basis: 'platform_net_1h', source: 'deep_external_action_name', optimization };
  }

  return { basis: 'unknown', source: 'metadata_insufficient', optimization };
}

function invalidBasisResult(providedBasis) {
  return {
    ok: false,
    status: 400,
    code: 'invalid_roi_basis',
    rule: 'invalid_roi_basis',
    blocked: true,
    error: `roi_basis 必须是 ${ROI_BASES.join(' / ')}`,
    provided_roi_basis: providedBasis == null ? null : String(providedBasis),
    allowed_roi_bases: ROI_BASES,
  };
}

function validateRoiGoalWrite({ providedBasis, entity }) {
  const supplied = providedBasis != null && providedBasis !== '';
  const normalizedProvided = normalizeRoiBasis(providedBasis);
  if (supplied && !normalizedProvided) return invalidBasisResult(providedBasis);

  const inferred = inferRoiGoalBasis(entity);
  if (inferred.basis === 'unknown') {
    return {
      ok: false,
      status: 400,
      code: 'roi_basis_required',
      rule: 'roi_basis_required',
      blocked: true,
      error: '无法从目标计划/追投的真实优化元数据识别 ROI 目标口径，已阻断 ROI 写入；请先回读可核验的优化目标元数据',
      roi_goal_basis: 'unknown',
      provided_roi_basis: normalizedProvided,
      optimization: inferred.optimization,
      allowed_roi_bases: ROI_BASES.filter(item => item !== 'unknown'),
    };
  }

  if (normalizedProvided === 'unknown') {
    return {
      ok: false,
      status: 400,
      code: 'roi_basis_required',
      rule: 'roi_basis_required',
      blocked: true,
      error: 'roi_basis=unknown 不能用于 ROI 写入',
      roi_goal_basis: inferred.basis,
      provided_roi_basis: normalizedProvided,
      roi_basis_source: inferred.source,
      optimization: inferred.optimization,
      allowed_roi_bases: ROI_BASES.filter(item => item !== 'unknown'),
    };
  }

  if (normalizedProvided && normalizedProvided !== inferred.basis) {
    return {
      ok: false,
      status: 409,
      code: 'roi_basis_mismatch',
      rule: 'roi_basis_mismatch',
      blocked: true,
      error: `用户声明的 ROI 口径 ${normalizedProvided} 与目标真实口径 ${inferred.basis} 不一致，已阻断 ROI 写入`,
      roi_goal_basis: inferred.basis,
      provided_roi_basis: normalizedProvided,
      roi_basis_source: inferred.source,
      optimization: inferred.optimization,
    };
  }

  return {
    ok: true,
    roi_goal_basis: inferred.basis,
    roi_basis_source: inferred.source,
    optimization: inferred.optimization,
  };
}

function attachRoiGoalContract(entity) {
  const inferred = inferRoiGoalBasis(entity);
  return {
    roi_goal_basis: inferred.basis,
    roi_basis_source: inferred.source,
    optimization: inferred.optimization,
  };
}

module.exports = {
  ROI_BASES,
  attachRoiGoalContract,
  extractOptimizationMetadata,
  inferRoiGoalBasis,
  normalizeRoiBasis,
  validateRoiGoalWrite,
};
