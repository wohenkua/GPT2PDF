// src/background/sw.js

// 生成一个简易唯一键
function genKey() {
  return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'OPEN_EXPORTER' && msg.conversation) {
    const key = genKey();
    chrome.storage.local.set({ [key]: msg.conversation }, () => {
      const url = chrome.runtime.getURL(`src/export/export.html?k=${encodeURIComponent(key)}`);
      chrome.tabs.create({ url });
      sendResponse({ ok: true, key });
    });
    return true; // 表示异步 sendResponse
  }

  if (msg?.type === 'CLEANUP' && msg.key) {
    chrome.storage.local.remove(msg.key, () => sendResponse({ ok: true }));
    return true;
  }
});
