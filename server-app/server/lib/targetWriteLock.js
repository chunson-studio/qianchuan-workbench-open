'use strict';
const locks = new Map();
function withTargetWriteLock(accountId, targetId, fn) {
  const key = `${accountId}:${targetId}`;
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  return previous.then(fn).finally(() => {
    release();
    if (locks.get(key) === current) locks.delete(key);
  });
}
module.exports = { withTargetWriteLock };
