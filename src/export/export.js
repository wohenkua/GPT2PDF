// 解析 URL 参数
function getQuery(key) {
  const m = new URLSearchParams(location.search);
  return m.get(key);
}

function escapeHtml(s='') {
  return s.replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function renderImageBlock(block) {
  if (!block?.src) {
    const altText = block?.alt ? `图片：${block.alt}` : '图片缺失';
    return `<p>${escapeHtml(altText)}</p>`;
  }

  const attrs = [];
  const alt = 'alt' in block ? String(block.alt ?? '') : '';
  attrs.push(`src="${escapeHtml(String(block.src))}"`);
  attrs.push(`alt="${escapeHtml(alt)}"`);
  if (block.srcset) attrs.push(`srcset="${escapeHtml(String(block.srcset))}"`);
  if (block.sizes) attrs.push(`sizes="${escapeHtml(String(block.sizes))}"`);
  if (block.width) attrs.push(`width="${escapeHtml(String(block.width))}"`);
  if (block.height) attrs.push(`height="${escapeHtml(String(block.height))}"`);

  const imgHtml = `<img ${attrs.join(' ')}>`;
  const caption = block.caption ? `<figcaption>${escapeHtml(String(block.caption))}</figcaption>` : '';
  return `<figure class="image-block">${imgHtml}${caption}</figure>`;
}

function waitForImages(root = document, timeout = 7000) {
  const images = Array.from(root.querySelectorAll('img'));
  if (!images.length) return Promise.resolve();

  return Promise.all(images.map(img => new Promise(resolve => {
    if (img.complete && img.naturalWidth !== 0) {
      resolve();
      return;
    }
    if (img.complete && img.naturalWidth === 0) {
      resolve();
      return;
    }

    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      img.removeEventListener('load', onEvent);
      img.removeEventListener('error', onEvent);
      resolve();
    };
    const onEvent = () => finish();
    img.addEventListener('load', onEvent, { once: true });
    img.addEventListener('error', onEvent, { once: true });
    timer = setTimeout(finish, timeout);
  }))).then(() => undefined);
}

function render(conversation) {
  // 顶部信息
  const title = conversation.title || 'ChatGPT 对话导出';
  document.getElementById('doc-title').textContent = title;
  document.title = title;

  // 消息
  const app = document.getElementById('app');
  app.innerHTML = (conversation.items || []).map(item => {
    // 当前版本：渲染文本与图片块（后续可扩展表格、代码等）
    const htmlBlocks = (item.blocks || []).map(b => {
      if (b.type === 'text' && b.html) return b.html;
      if (b.type === 'text' && b.text) return `<p>${escapeHtml(b.text)}</p>`;
      if (b.type === 'image') return renderImageBlock(b);
      // 其它类型暂时保底展示为纯文本提示
      return '';
    }).join('\n');
    return `
      <section class="msg ${item.role}">
        <div class="bubble">${htmlBlocks}</div>
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

  // 资源准备好后触发打印：等待图片加载完成或超时
  await waitForImages(document);
  window.print();

  // 打印触发后清理临时数据（异步）
  chrome.runtime.sendMessage({ type: 'CLEANUP', key }).catch(()=>{});
}

main().catch(err => {
  console.error(err);
  document.getElementById('app').textContent = '渲染失败：' + (err?.message || err);
});
