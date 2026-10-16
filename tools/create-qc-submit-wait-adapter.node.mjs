// Adapt the verified replay entry when the browser's hidden-selector wait returns early.
export function createQianchuanSubmitWaitAdapter(tab, { timeout_ms = 10000, interval_ms = 300 } = {}) {
  let submitted = false;
  return {
    onCheckpoint(checkpoint) {
      if (checkpoint.id === 'boost.submit.intent') submitted = true;
    },
    tab: {
      playwright: tab.playwright,
      url: () => tab.url(),
      reload: () => tab.reload(),
      async getAXState() {
        let snapshot = await tab.playwright.domSnapshot();
        if (submitted) {
          const deadline = Date.now() + timeout_ms;
          while (snapshot.includes('请输入任务名称，1-50个字符') && /- button "提交"/.test(snapshot) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, interval_ms));
            snapshot = await tab.playwright.domSnapshot();
          }
          submitted = false;
        }
        return snapshot;
      }
    }
  };
}
