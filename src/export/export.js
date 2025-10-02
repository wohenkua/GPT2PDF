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
  const time  = conversation.exportedAt
    ? new Date(conversation.exportedAt).toLocaleString()
    : new Date().toLocaleString();
  const link  = conversation.sourceUrl || '';

  document.getElementById('doc-title').textContent = title;
  const timeEl = document.getElementById('doc-time');
  timeEl.textContent = `导出时间：${time}`;
  const linkEl = document.getElementById('doc-link');
  linkEl.textContent = link;
  linkEl.href = link;

  // 消息
  const app = document.getElementById('app');
  app.innerHTML = (conversation.items || []).map(item => {
    const roleLabel = item.role === 'user' ? '用户' : '助手';
    // 当前最小版：只渲染 text 块（下一轮会支持代码、表格、图片、公式等）
    const htmlBlocks = (item.blocks || []).map(b => {
      if (b.type === 'text' && b.html) return b.html;
      if (b.type === 'text' && b.text) return `<p>${escapeHtml(b.text)}</p>`;
      if (b.type === 'image' && b.src) {
        const alt = b.alt ? ` alt="${escapeHtml(b.alt)}"` : '';
        return `<figure class="img-block"><img src="${escapeHtml(b.src)}"${alt}></figure>`;
      }
      // 其它类型暂时保底展示为纯文本提示
      return '';
    }).join('\n');
    return `
      <section class="msg ${item.role}">
        <div class="role">${roleLabel}</div>
        ${htmlBlocks}
      </section>
    `;
  }).join('\n');
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

  render(conversation);

  await waitForImages();
  window.print();

  // 打印触发后清理临时数据（异步）
  chrome.runtime.sendMessage({ type: 'CLEANUP', key }).catch(()=>{});
}

async function waitForImages() {
  const images = Array.from(document.querySelectorAll('img'));
  await Promise.all(images.map((img) => {
    if (img.complete) return;
    return new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  }));
}

main().catch(err => {
  console.error(err);
  document.getElementById('app').textContent = '渲染失败：' + (err?.message || err);
});
