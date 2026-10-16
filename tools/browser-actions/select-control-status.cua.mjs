
export async function selectControlStatus(tab, { status, filter_index = 2 }) {
  if (!['调控中', '手动暂停'].includes(status)) throw new Error('unsupported_control_status');
  if (!Number.isInteger(filter_index) || filter_index < 0) throw new Error('invalid_filter_index');
  await tab.playwright.getByRole('textbox', { name: '请选择', exact: true }).nth(filter_index).click();
  if (status === '调控中') {
    await tab.playwright.locator('.ovui-cascader-panel__item-label').filter({ hasText: /^调控中$/ }).click();
  } else {
    await tab.playwright.getByText('已暂停', { exact: true }).click();
    await tab.playwright.getByText('手动暂停', { exact: true }).click();
  }
  return { status: 'selection_clicked', requested_filter: status };
}
