'use strict';

const { reviewDay: retired } = require('./decisionReview');
module.exports = {
  computeRuleStats: retired, writeRuleStats: retired, runRuleStats: retired,
  getAccountPromptLessons: () => '',
};
