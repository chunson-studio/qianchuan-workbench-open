/* 账号接入/管理易用性补丁：删除账号只需一次确认并永久清理。 */
(function (V4) {
  'use strict';

  async function deleteAccount(button, id, name) {
    const label = name || id;
    const visibleLabel = V4.privacy?.text(label) || label;
    const ok = window.confirm(`确定彻底删除账号“${visibleLabel}”吗？\n\n确认后会删除该账号的本机登录 Cookie、账户配置、Profile 和接入草稿。此操作不可恢复。`);
    if (!ok) return;

    const row = button.closest('.acct-manager-row');
    const manager = button.closest('.acct-manager');
    const status = manager && manager.querySelector('.acct-manager-status');
    button.disabled = true;
    if (status) status.textContent = `正在删除“${label}”…`;

    try {
      const result = await V4.apiJson('/api/accounts', 'DELETE', {
        action: 'delete',
        id,
        confirm: true,
        permanent: true,
      }, { includeAccount: false, timeout: 30000 });

      if (!result || !result.ok || !Array.isArray(result.accounts)) throw new Error((result && result.error) || '账号删除响应格式错误');
      V4.archivedAccounts = Array.isArray(result.archived_accounts) ? result.archived_accounts : [];
      V4.setAccounts(result.accounts);
      row && row.remove();

      const cleanupWarnings = result.cleanup && Array.isArray(result.cleanup.warnings) ? result.cleanup.warnings : [];
      if (status) status.textContent = cleanupWarnings.length
        ? `账号已删除；有 ${cleanupWarnings.length} 个本机文件清理警告，可查看服务日志。`
        : `账号“${label}”已彻底删除。`;

      if (!result.accounts.length) {
        const backdrop = document.querySelector('.acct-manager-backdrop');
        backdrop && backdrop.remove();
        location.hash = '#/onboarding';
      }
    } catch (error) {
      button.disabled = false;
      if (status) status.textContent = `删除失败：${(error && error.message) || '未知错误'}`;
      else window.alert(V4.privacy?.text(`删除失败：${(error && error.message) || '未知错误'}`) || `删除失败：${(error && error.message) || '未知错误'}`);
    }
  }

  function enhanceAccountManager() {
    const manager = document.querySelector('.acct-manager');
    if (!manager) return;

    const subtitle = manager.querySelector('header p');
    if (subtitle) subtitle.textContent = '添加或彻底删除账号';
    const note = manager.querySelector('.acct-manager-note');
    if (note) note.textContent = '添加账号使用浏览器登录，由 Codex 核验并接续。删除账号只需一次确认，确认后永久清理本机账号资料。';

    manager.querySelectorAll('[data-account-action="remove"], [data-account-action="purge"]').forEach(button => {
      if (button.dataset.simplePermanentDelete === '1') return;
      button.dataset.simplePermanentDelete = '1';
      button.textContent = '删除';
      const id = button.dataset.accountId;
      const name = button.dataset.accountName;
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        deleteAccount(button, id, name);
      };
    });
  }

  function enhance() {
    enhanceAccountManager();
  }

  V4.onViewUpdate(enhance);
})(window.V4);
