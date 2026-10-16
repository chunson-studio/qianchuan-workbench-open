'use strict';

/** Adapt an already-authorized CDP connection to Playwright's public transport.
 * The source owns its lifetime. Closing this adapter never reconnects, closes
 * Chrome, or replays commands. Create this object in the same Node module realm
 * as Playwright; VM-created objects can fail its in-process transport validator.
 */
function createQianchuanCDPTransport(source) {
  if (!source || typeof source.send !== 'function' || typeof source.isConnected !== 'function' ||
      typeof source.subscribe !== 'function' || !source.isConnected()) {
    throw Object.assign(new Error('cdp_transport_source_invalid'), { code: 'cdp_transport_source_invalid' });
  }
  let closed = false;
  let unsubscribe;
  const pending = new Set();
  const transport = {
    send(message) {
      if (closed) return;
      if (!message || !Number.isSafeInteger(message.id) || typeof message.method !== 'string' ||
          pending.has(message.id)) {
        transport.close('Invalid or duplicate CDP request');
        return;
      }
      pending.add(message.id);
      const reply = value => {
        pending.delete(message.id);
        if (!closed) transport.onmessage?.({ id: message.id,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}), ...value });
      };
      Promise.resolve().then(() => closed ? undefined : source.send(message.method, message.params ?? {}, message.sessionId))
        .then(result => reply({ result }), error => reply({ error: {
          code: Number.isInteger(error?.protocol_code) ? error.protocol_code : -32000,
          message: error?.code || 'CDP command failed',
        } }));
    },
    close(reason) {
      if (closed) return;
      closed = true;
      pending.clear();
      if (typeof unsubscribe === 'function') unsubscribe();
      transport.onclose?.(reason);
    },
  };
  unsubscribe = source.subscribe(message => {
    if (!closed && message && !Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      transport.onmessage?.(message);
    }
  }, reason => transport.close(reason || 'Source CDP connection closed'));
  if (typeof unsubscribe !== 'function') {
    transport.close('Invalid CDP event subscription');
    throw Object.assign(new Error('cdp_transport_subscription_invalid'), { code: 'cdp_transport_subscription_invalid' });
  }
  return transport;
}

module.exports = { createQianchuanCDPTransport };
