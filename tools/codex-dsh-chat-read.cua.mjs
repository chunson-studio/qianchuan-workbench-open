export async function readDshChatTail(tab,{expectedTitle,tailChars=11000,on_checkpoint}={}) {
 const url=await tab.url(); const title=await tab.title();
 if (!url?.startsWith("http://127.0.0.1:3080/") || (expectedTitle&&!title?.includes(expectedTitle))) throw new Error("DSH会话绑定不符");
 const text=await tab.playwright.locator("div.wSkVaW_scrollBody").innerText();
 const result={captured_at:new Date().toISOString(),url,title,text:text.slice(-tailChars),scope:"rendered_chat_only",actions:[]};
 if(on_checkpoint) await on_checkpoint(result);
 return result;
}
