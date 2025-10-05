// src/background/sw.js
// 内存缓存（仅本次会话有效，不持久化）
const cache = new Map();

function genTicket() {
  return 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 1) 内容脚本发来“打开导出页 + 会话数据”
  if (msg?.type === 'OPEN_EXPORTER' && msg.conversation) {
    const ticket = genTicket();
    // 临时缓存到内存（而不是 chrome.storage）
    cache.set(ticket, msg.conversation);

    const url = chrome.runtime.getURL(`src/export/export.html?k=${encodeURIComponent(ticket)}`);
    chrome.tabs.create({ url }, (tab) => {
      sendResponse({ ok: true, ticket, tabId: tab?.id });
    });
    // 异步 sendResponse
    return true;
  }

  // 2) 导出页来取数据
  if (msg?.type === 'REQUEST_CONVERSATION' && msg.ticket) {
    const convo = cache.get(msg.ticket);
    if (convo) {
      sendResponse({ ok: true, conversation: convo });
    } else {
      sendResponse({ ok: false, error: 'not_found' });
    }
    return true;
  }

  // 3) 导出完成后清理
  if (msg?.type === 'CLEANUP' && msg.ticket) {
    cache.delete(msg.ticket);
    sendResponse({ ok: true });
    return true;
  }
});
