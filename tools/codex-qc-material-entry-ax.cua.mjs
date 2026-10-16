// CUA 页面入口适配；不修改创建参数，不点击广告提交按钮。
const entrySelector = 'span.oc-promotion-operation-action-item,span.main-vmok-plugin-oc-promotion-operation-action-item';

export async function clickMaterialEntryByAx(tab, { material_id }) {
  const materialId = String(material_id || '');
  if (!/^\d+$/.test(materialId)) throw Error('invalid_material_id');
  const ax = await tab.getAXState({ emit: false, disableDiffing: true });
  const lines = ax.split('\n');
  const idLines = lines.map((line, i) => ({ line, i }))
    .filter(({ line }) => new RegExp('ID\\s*[:：]\\s*' + materialId + '(?:\\D|$)').test(line));
  if (idLines.length !== 1) throw Error('ax_material_id_not_unique');
  let rowStart = idLines[0].i;
  while (rowStart >= 0 && !/^\s*\d+ row(?:\s|$)/.test(lines[rowStart])) rowStart--;
  if (rowStart < 0) throw Error('ax_material_row_missing');
  const rowIndent = lines[rowStart].match(/^\s*/)[0].length;
  let rowEnd = rowStart + 1;
  while (rowEnd < lines.length && (!lines[rowEnd].trim() || lines[rowEnd].match(/^\s*/)[0].length > rowIndent)) rowEnd++;
  const entries = lines.slice(rowStart, rowEnd).map(line => line.match(/^\s*(\d+) text 追投\s*$/)).filter(Boolean);
  if (entries.length !== 1) throw Error('ax_material_entry_not_unique');
  const index = Number(entries[0][1]);
  await tab.click(index);
  return { material_id: materialId, index, status: 'entry_clicked', ad_writes: 0 };
}

export function createAxMaterialEntryTabAdapter(tab, spec) {
  const wrapLocator = locator => new Proxy(locator, {
    get(target, key) {
      if (key === 'filter') return options => wrapLocator(target.filter(options));
      if (key === 'locator') return selector => {
        const nested = target.locator(selector);
        if (selector !== entrySelector) return nested;
        const wrapEntry = entry => new Proxy(entry, {
          get(current, name) {
            if (name === 'filter') return options => wrapEntry(current.filter(options));
            if (name === 'click') return () => clickMaterialEntryByAx(tab, spec);
            const value = Reflect.get(current, name);
            return typeof value === 'function' ? value.bind(current) : value;
          }
        });
        return wrapEntry(nested);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const playwright = new Proxy(tab.playwright, {
    get(target, key) {
      if (key === 'getByRole') return (role, options) => role === 'row'
        ? wrapLocator(target.getByRole(role, options)) : target.getByRole(role, options);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return new Proxy(tab, {
    get(target, key) {
      if (key === 'playwright') return playwright;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
