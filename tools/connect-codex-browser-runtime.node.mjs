// 在 Codex 的 mcp__node_repl.js 中调用，不作为终端浏览器控制入口。
export async function connectCodexBrowserRuntime({ clientPath, extensionInstanceId, sessionName }) {
  if (!clientPath || !extensionInstanceId || !sessionName) throw new Error('缺少连接参数');
  const { setupBrowserRuntime } = await import(clientPath);
  const agent = await setupBrowserRuntime({});
  const browsers = await agent.browsers.list();
  const matches = browsers.filter(item => item.type === 'extension' && item.metadata?.extensionInstanceId === extensionInstanceId);
  if (matches.length !== 1) throw new Error(`扩展连接数量异常：${matches.length}`);
  const browser = await agent.browsers.get(matches[0].id);
  const documentation = await browser.documentation();
  await browser.nameSession(sessionName);
  const openTabs = await browser.user.openTabs();
  return { agent, browser, documentation, openTabs };
}
