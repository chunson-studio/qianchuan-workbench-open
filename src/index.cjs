'use strict';
module.exports = {
  ...require('../tools/attach-qc-chrome.playwright.cjs'),
  ...require('../tools/read-qc-control-raw.playwright.cjs'),
  ...require('../tools/read-qc-control-pages.playwright.cjs'),
  ...require('../tools/edit-qc-control-parameter.playwright.cjs'),
};
