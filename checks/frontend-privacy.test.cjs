'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createCatalog = require('../server-app/server/public/v4/privacy.js');

test('账户用稳定别名，新增、改名和重排不混淆账户', () => {
  const catalog = createCatalog();
  const accounts = [{ id: 'account_10001', name: '品牌直营账户' }, { id: 'account_10002', name: '渠道合作账户' }];
  catalog.capture({ accounts });
  assert.equal(catalog.redact('品牌直营账户 / 渠道合作账户'), '账户 1 / 账户 2');
  catalog.capture({ accounts: [{ ...accounts[1], name: '渠道新名称' }, accounts[0]] });
  assert.equal(catalog.redact('渠道新名称 / account_10001'), '账户 2 / 账户 1');
  assert.equal(catalog.accountLabel('account_10002'), '账户 2');
  catalog.capture({ candidates: [{ aavid: '10001', name: '品牌直营账户' }] });
  assert.equal(catalog.redact('品牌直营账户'), '账户 1');
  assert.equal(catalog.redact('account_1000123'), 'account_1000123');
});

test('隐藏房间、计划、素材、场次标识，保留 ROI、金额和日期', () => {
  const catalog = createCatalog();
  catalog.capture({ room_id: '111', primary_ad_id: '90060000003', material_id: 'mat-123', session_key: 'session-123' });
  assert.equal(catalog.redact('房间 111 · 2026-09-28 10:00:00'), '房间 •••• · 2026-09-28 10:00:00');
  assert.equal(catalog.redact('主计划 · 90060000003', true), '主计划 · ••••');
  assert.equal(catalog.redact('mat-123 / session-123'), '•••• / ••••');
  const metrics = 'ROI 111.00；目标 3.20；消耗 ¥111.00；订单 111；预算 90060000003';
  assert.equal(catalog.redact(metrics), metrics);
  assert.equal(catalog.redact('¥111.00 / 111.25 / 2111 / 111%', true), '¥111.00 / 111.25 / 2111 / 111%');
});

test('隐私采集不改写 API 对象、账户值或请求 scope', () => {
  const catalog = createCatalog();
  const data = { accounts: [{ id: 'qa_account_a', name: '测试账户' }], scope: { account: 'qa_account_a', room_id: '222', start_time: '2026-09-28 10:00:00' }, plan: { id: 'plan-3' }, cost: 222 };
  const before = JSON.stringify(data);
  catalog.capture(data);
  catalog.redact(JSON.stringify(data), true);
  assert.equal(JSON.stringify(data), before);
  assert.equal(data.scope.room_id, '222');
});

test('动态新身份及特殊字符账户名及时遮盖，不把名称作为正则执行', () => {
  const catalog = createCatalog();
  catalog.capture({ accounts: [{ id: 'account_1', name: '品牌(A)+[直营]' }] });
  assert.equal(catalog.redact('品牌(A)+[直营]'), '账户 1');
  catalog.capture({ room: { roomId: '333' }, plans: [{ id: 'plan-new' }] });
  assert.equal(catalog.redact('直播间 333 · plan-new', true), '直播间 •••• · ••••');
});
