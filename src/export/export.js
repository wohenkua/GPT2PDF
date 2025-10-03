// 解析 URL 参数
function getQuery(key) {
  const m = new URLSearchParams(location.search);
  return m.get(key);
}

function escapeHtml(s='') {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function render(conversation) {
  // 顶部信息
  const title = conversation.title || 'ChatGPT 对话导出';
  document.getElementById('doc-title').textContent = title;
  document.title = title;

  // 消息
  const app = document.getElementById('app');
  app.innerHTML = (conversation.items || []).map(item => {
    // 当前最小版：只渲染 text 块（下一轮会支持代码、表格、图片、公式等）
    const htmlBlocks = (item.blocks || []).map(b => {
      if (b.type === 'text' && b.html) return b.html;
      if (b.type === 'text' && b.text) return `<p>${escapeHtml(b.text)}</p>`;
      // 其它类型暂时保底展示为纯文本提示
      return '';
    }).join('\n');
    return `
      <section class="msg ${item.role}">
        <div class="bubble">${htmlBlocks}</div>
      </section>
    `;
  }).join('\n');

  app.querySelectorAll('img').forEach(img => {
    if (!img.getAttribute('alt')) img.setAttribute('alt', '');
    img.loading = 'eager';
    if (!img.decoding) img.decoding = 'sync';
  });

  return app;
}

function waitForImages(root) {
  const images = Array.from(root.querySelectorAll('img'));
  if (!images.length) return Promise.resolve();

  return Promise.all(images.map(img => {
    if (img.complete) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
        resolve();
      };
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  }));
}

async function main() {
  const key = getQuery('k');
  if (!key) {
    document.getElementById('app').textContent = '未找到数据键（k）。';
    return;
  }
  // 从 storage 取数据
  const data = await chrome.storage.local.get(key);
  const conversation = data[key];
  if (!conversation) {
    document.getElementById('app').textContent = '数据不存在或已过期。';
    return;
  }

  const app = render(conversation);

  await waitForImages(app);

  // 等待下一帧确保排版完成
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  window.print();

  // 打印触发后清理临时数据（异步）
  chrome.runtime.sendMessage({ type: 'CLEANUP', key }).catch(()=>{});
}

main().catch(err => {
  console.error(err);
  document.getElementById('app').textContent = '渲染失败：' + (err?.message || err);
});
