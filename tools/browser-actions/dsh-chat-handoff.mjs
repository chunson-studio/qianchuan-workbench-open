
export async function renameDshChat({tab, oldTitle, newTitle, marker, checkpoint}) {
  if (!oldTitle || !newTitle || !marker || typeof checkpoint !== 'function') throw new Error('缺少重命名参数');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = await tab.playwright.domSnapshot();
  const hasTitle = (dom, title) => dom.includes('generic: ' + title + '\n');
  if (hasTitle(before, newTitle) && oldTitle !== newTitle) throw new Error('同名会话已存在，先核对象，不自动重命名');
  await tab.playwright.getByRole('treeitem', {name: new RegExp('^' + escape(oldTitle) + ' ')}).click();
  const selected = await tab.playwright.domSnapshot();
  if (!selected.includes('generic: ' + oldTitle + '\n  - button "智能体团队"')) throw new Error('当前会话身份未核准');
  await checkpoint({id:marker+'.select', status:'read_verified', dom:selected, old_title:oldTitle, new_title:newTitle});
  await tab.playwright.getByRole('button', {name:'会话“'+oldTitle+'”的操作', exact:true}).click();
  const menu = await tab.playwright.domSnapshot();
  await checkpoint({id:marker+'.menu', status:'opened', dom:menu});
  if (!menu.includes('menuitem "重命名"')) throw new Error('重命名菜单未核准');
  await tab.playwright.getByRole('menuitem', {name:'重命名', exact:true}).click();
  const dialog = await tab.playwright.domSnapshot();
  await checkpoint({id:marker+'.dialog', status:'opened', dom:dialog});
  if (!dialog.includes('textbox "会话名称" [active]: ' + oldTitle)) throw new Error('原会话名未核准');
  await tab.playwright.getByRole('textbox', {name:'会话名称', exact:true}).fill(newTitle);
  const filled = await tab.playwright.domSnapshot();
  await checkpoint({id:marker+'.fill', status:'read_verified', dom:filled, old_title:oldTitle, new_title:newTitle});
  await checkpoint({id:marker+'.submit-intent', status:'submission_pending', dom:filled, old_title:oldTitle, new_title:newTitle});
  await tab.playwright.getByRole('button', {name:'重命名', exact:true}).click();
  const after = await tab.playwright.domSnapshot();
  const verified = hasTitle(after, newTitle) && !after.includes('dialog "重命名会话"');
  await checkpoint({id:marker+'.submit', status:verified?'write_verified':'submission_unknown', dom:after, old_title:oldTitle, new_title:newTitle});
  if (!verified) throw new Error('结果未知，先查原会话，不再次提交');
  return {status:'write_verified', old_title:oldTitle, new_title:newTitle};
}


export async function createDshPreparationChat({tab, message, marker, checkpoint}) {
  if (!message || !marker || !message.includes(marker)) throw new Error('消息需包含唯一核验标记');
  const before = await tab.playwright.domSnapshot();
  if (before.includes('审批详情')) throw new Error('权限审批交由用户处理，不代批');
  const previousEditors = await tab.playwright.getByRole('textbox', {
    name: '发消息或创建任务, / 调用指令, @ 文件或对话', exact: true,
  }).all();
  if (previousEditors.length && (await previousEditors[0].innerText()).trim()) {
    throw new Error('当前存在人工草稿，先保护草稿');
  }

  await tab.playwright.getByRole('button', {name: '新建会话', exact: true}).first().click();
  
  await tab.playwright.getByRole('textbox', {
    name: '描述你想要构建的内容, / 调用指令, @ 文件或对话', exact: true,
  }).waitFor({state: 'visible', timeoutMs: 8000});
  let dom = await tab.playwright.domSnapshot();
  await checkpoint({id: 'dsh.chat.create', status: 'opened', dom});
  return prepareEmptyDshChat({tab, message, marker, checkpoint});
}


export async function prepareEmptyDshChat({tab, message, marker, checkpoint}) {
  let dom = await tab.playwright.domSnapshot();
  if (!dom.includes('treeitem "新会话" [selected]') || !dom.includes('描述你想要构建的内容')) {
    throw new Error('未核准选中的空新会话，停止');
  }

  if (dom.includes('button "标准模式"')) {
    await tab.playwright.getByRole('button', {name: '标准模式', exact: true}).click();
    dom = await tab.playwright.domSnapshot();
    await checkpoint({id: 'dsh.mode.menu', status: 'opened', dom});
    await tab.playwright.getByRole('menuitem', {name: /^千川投手模式 /}).click();
    dom = await tab.playwright.domSnapshot();
    if (!dom.includes('button "千川投手模式"')) throw new Error('模式选择未核准');
    await checkpoint({id: 'dsh.mode.select', status: 'read_verified', dom});
  } else if (!dom.includes('千川投手模式')) {
    throw new Error('未观察到可用模式；不修改preset');
  }

  const editor = tab.playwright.getByRole('textbox', {
    name: '描述你想要构建的内容, / 调用指令, @ 文件或对话', exact: true,
  });
  if ((await editor.innerText()).trim()) throw new Error('新会话编辑器不是空白');
  await editor.fill(message);
  dom = await tab.playwright.domSnapshot();
  if (!dom.includes(marker)) throw new Error('填写内容未核准');
  await checkpoint({id: 'dsh.message.fill', status: 'read_verified', dom});
  await checkpoint({id: 'dsh.message.submit-intent', status: 'submission_pending', dom});
  await tab.playwright.getByRole('button', {name: '发送消息', exact: true}).click();
  dom = await tab.playwright.domSnapshot();
  const normalizedMarker = marker.replace(/\s+/g, ' ');
  if (!dom.includes('- generic: ' + normalizedMarker)) {
    await checkpoint({id: 'dsh.message.submit', status: 'submission_unknown', dom});
    throw new Error('提交未知：只核原会话，不重发');
  }
  await checkpoint({id: 'dsh.message.submit', status: 'write_verified', dom,
    note: '仅证明DSH聊天指令送达；不代表准备完成、广告写入或调度启动'});
  return {status: 'instruction_sent', dom};
}
