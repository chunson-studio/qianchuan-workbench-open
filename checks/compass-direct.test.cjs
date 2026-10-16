'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

test('罗盘响应在汉字中间分块时仍保留原渠道名，不产生重复乱码渠道', async () => {
  const payload = { st: 0, data: { trends: [
    { display_name: '直播推荐', vertical: 9 },
    { display_name: '短视频引流', vertical: 0 },
  ] } };
  const bytes = Buffer.from(JSON.stringify(payload));
  const module = { exports: {} };
  const request = (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const response = Readable.from(Array.from(bytes, byte => Buffer.from([byte])));
      response.statusCode = 200;
      callback(response);
    };
    return req;
  };
  const dependencies = {
    https: { request }, fs: { existsSync: () => true, readFileSync: () => 'fixture-only' }, path,
    './config': { SCRIPTS_DIR: '/test-only' }, './abogusSign': { signUrl: () => null },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../server-app/server/lib/compassDirect.js'), 'utf8'), {
    module, exports: module.exports, __dirname, Buffer, URL,
    require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
  });
  const result = await module.exports.fetchCompassDirect('fixture_account', '/compass_api/content_live/shop/live_screen/flow_trend', { roomId: '11111' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), payload);
  assert.equal(JSON.stringify(result).includes('\ufffd'), false);
});
