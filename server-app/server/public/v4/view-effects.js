/* One batched observer for visual enhancements; its own changes do not trigger another frame. */
(function (V4) {
  'use strict';
  const effects = new Set();
  let pending = [], frame = 0;
  const options = { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-theme'] };
  const observer = new MutationObserver(records => {
    const relevant = records.filter(record => !record.target.closest?.('#clock, #upd, #floating-queue-indicator'));
    if (relevant.length) { pending.push(...relevant); schedule(); }
  });
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const records = pending.concat(observer.takeRecords());
      pending = [];
      observer.disconnect();
      try {
        for (const effect of effects) {
          try { effect(records); } catch (error) { console.error('[view-effects]', error); }
        }
      } finally { observer.observe(document.documentElement, options); }
    });
  }
  V4.onViewUpdate = effect => { effects.add(effect); schedule(); return () => effects.delete(effect); };
  V4.refreshViewEffects = schedule;
  observer.observe(document.documentElement, options);
})(window.V4);
