'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createQianchuanCDPTransport } = require('../tools/qc-cdp-transport.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(send = async () => ({})) {
  const state = { calls: [], disconnected: 0, unsubscribed: 0 };
  state.source = { isConnected: () => true,
    send: (...args) => { state.calls.push(args); return send(...args); },
    close: () => { state.disconnected++; },
    subscribe: (event, close) => { state.event = event; state.close = close; return () => { state.unsubscribed++; }; } };
  state.transport = createQianchuanCDPTransport(state.source);
  state.messages = [];
  state.transport.onmessage = value => state.messages.push(value);
  return state;
}
test('module-created transport remains in the Playwright module realm for VM callers', () => {
  const f = fixture();
  const context = vm.createContext({ factory: createQianchuanCDPTransport, source: f.source });
  const transport = vm.runInContext('factory(source)', context);
  assert.ok(transport instanceof Object);
  transport.close(); f.transport.close();
});
test('routes out-of-order results to original ids and sessions without retries', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  f.transport.send({ id: 7, method: 'Runtime.evaluate', params: { returnByValue: true }, sessionId: 'a' });
  f.transport.send({ id: 8, method: 'Browser.getVersion' });
  await tick(); pending[1]({ product: 'Chrome' }); pending[0]({ value: 1 }); await tick();
  assert.deepEqual(f.messages, [{ id: 8, result: { product: 'Chrome' } }, { id: 7, sessionId: 'a', result: { value: 1 } }]);
  assert.equal(f.calls.length, 2); f.transport.close();
});
test('forwards events but ignores source response ids', () => {
  const f = fixture();
  f.event({ method: 'Target.attachedToTarget', params: { sessionId: 'a' } });
  f.event({ id: 99, result: {} });
  assert.equal(f.messages.length, 1); f.transport.close();
});
test('adapter close preserves authorized source and ignores late results', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  f.transport.send({ id: 1, method: 'Runtime.evaluate', sessionId: 'a' }); await tick();
  f.transport.close(); f.transport.close(); resolve({}); await tick();
  f.transport.send({ id: 2, method: 'Browser.getVersion' });
  assert.equal(f.unsubscribed, 1); assert.equal(f.disconnected, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.messages.length, 0);
});
test('source loss closes adapter once without reconnecting', () => {
  const f = fixture(); const reasons = []; f.transport.onclose = reason => reasons.push(reason);
  f.close('lost'); f.close('lost'); assert.deepEqual(reasons, ['lost']);
  assert.equal(f.disconnected, 0); assert.equal(f.unsubscribed, 1);
});
test('protocol failures preserve response identity without exposing error text', async () => {
  const f = fixture(async () => { throw Object.assign(new Error('private input'), { code: 'target_closed', protocol_code: -32001 }); });
  f.transport.send({ id: 1, method: 'Runtime.evaluate', sessionId: 'a' }); await tick();
  assert.deepEqual(f.messages, [{ id: 1, sessionId: 'a', error: { code: -32001, message: 'target_closed' } }]);
  f.transport.close();
});
test('rejects disconnected source and duplicate in-flight ids', async () => {
  assert.throws(() => createQianchuanCDPTransport({ isConnected: () => false }), /source_invalid/);
  const f = fixture(() => new Promise(() => {})); let closed = 0; f.transport.onclose = () => closed++;
  f.transport.send({ id: 1, method: 'Runtime.evaluate' }); await tick();
  f.transport.send({ id: 1, method: 'Runtime.evaluate' });
  assert.equal(closed, 1); assert.equal(f.calls.length, 1); assert.equal(f.disconnected, 0);
});
test('closing before dispatch prevents the command from reaching Chrome', async () => {
  const f = fixture(); f.transport.send({ id: 1, method: 'Runtime.evaluate' });
  f.transport.close(); await tick(); assert.equal(f.calls.length, 0);
});
test('invalid event subscription reports the adapter error', () => {
  assert.throws(() => createQianchuanCDPTransport({ send() {}, isConnected: () => true, subscribe: () => ({}) }),
    /cdp_transport_subscription_invalid/);
});
