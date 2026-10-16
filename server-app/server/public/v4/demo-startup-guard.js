/* Demo startup guard: only resolves the no-account startup redirect race. */
(function (V4) {
  'use strict';
  let enabled = false;
  try { enabled = localStorage.getItem('v4-demo-mode') === '1'; } catch (_) {}
  if (!enabled || !V4 || typeof V4.loadAccounts !== 'function') return;

  Promise.resolve(V4.loadAccounts()).then(() => {
    let stillEnabled = enabled;
    try { stillEnabled = localStorage.getItem('v4-demo-mode') === '1'; } catch (_) {}
    if (!stillEnabled || (Array.isArray(V4.ACCTS) && V4.ACCTS.length)) return;
    const route = (location.hash || '').replace(/^#\/?/, '');
    // Only correct the automatic first-use redirect. This runs once, so later
    // manual navigation to onboarding is never blocked.
    if (!route || route === 'onboarding') location.hash = '#/overview';
  }).catch(() => {});
})(window.V4 || {});
