function escapeHtml(s='') {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function getQuery(key) {
  return new URLSearchParams(location.search).get(key);
}

function renderBlocks(blocks) {
  const out = [];
  for (const b of (blocks || [])) {
    if (b.type === 'text' && b.html) {
      out.push(b.html);
    } else if (b.type === 'image' && b.src) {
      const cap = b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : '';
      const alt = b.alt ? ` alt="${escapeHtml(b.alt)}"` : '';
      // 关键：避免 Referer 干扰
      out.push(`<figure><img referrerpolicy="no-referrer" src="${b.src}"${alt}>${cap}</figure>`);
    } else if (b.type === 'code' && b.code) {
      const langClass = b.lang ? ` class="language-${b.lang}"` : '';
      out.push(`<pre><code${langClass}>${escapeHtml(b.code)}</code></pre>`);
    } else if (b.type === 'formula') {
      if (b.tex) {
        const cls = b.display ? 'math-block' : 'math-inline';
        out.push(`<span class="${cls}" data-cg-tex="${encodeURIComponent(b.tex)}"></span>`);
      } else if (b.html) {
        const cls = b.display ? 'math-block' : 'math-inline';
        out.push(`<span class="${cls}">${b.html}</span>`);
      }
    }
  }
  return out.join('\n');
}

function render(conversation) {
  const title = conversation.title || 'ChatGPT 对话导出';
  const time  = conversation.exportedAt
    ? new Date(conversation.exportedAt).toLocaleString()
    : new Date().toLocaleString();
  const link  = conversation.sourceUrl || '';

  document.getElementById('doc-title').textContent = title;
  document.getElementById('doc-time').textContent = `导出时间：${time}`;
  const linkEl = document.getElementById('doc-link');
  linkEl.textContent = link; linkEl.href = link;

  const app = document.getElementById('app');
  app.innerHTML = (conversation.items || []).map(item => {
    const blocksHTML = renderBlocks(item.blocks);
    return `
      <section class="msg ${item.role}">
        ${blocksHTML}
      </section>
    `;
  }).join('\n');
}

function waitImagesLoaded() {
  const imgs = Array.from(document.images || []);
  if (!imgs.length) return Promise.resolve();
  return Promise.all(imgs.map(img => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise(res => {
      let done = false;
      const finish = () => { if (!done) { done = true; res(); } };
      img.onload = finish;
      img.onerror = () => {
        console.warn('图片加载失败：', img.src);
        finish();
      };
      setTimeout(finish, 8000); // 兜底超时
    });
  }));
}

function renderFormulasWithKaTeX() {
  if (!window.katex) return;
  document.querySelectorAll('[data-cg-tex]').forEach(el => {
    const tex = decodeURIComponent(el.getAttribute('data-cg-tex') || '');
    const displayMode = el.classList.contains('math-block');
    try {
      window.katex.render(tex, el, { throwOnError: false, displayMode });
    } catch (e) {}
  });
}

function highlightCodes() {
  if (window.hljs) window.hljs.highlightAll();
}

async function pipelineAndPrint() {
  try { highlightCodes(); } catch {}
  try { renderFormulasWithKaTeX(); } catch {}
  try { await waitImagesLoaded(); } catch {}
  setTimeout(() => window.print(), 200);
}

async function requestConversation(ticket) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'REQUEST_CONVERSATION', ticket }, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (resp && resp.ok && resp.conversation) return resolve(resp.conversation);
      reject(new Error('会话数据不存在或已清理'));
    });
  });
}

async function main() {
  const ticket = getQuery('k');
  if (!ticket) {
    document.getElementById('app').textContent = '未找到数据票据（k）。';
    return;
  }

  let conversation;
  try {
    conversation = await requestConversation(ticket);
  } catch (e) {
    console.error(e);
    document.getElementById('app').textContent = '获取会话数据失败：' + (e?.message || e);
    return;
  }

  render(conversation);

  if (document.readyState === 'complete') {
    pipelineAndPrint();
  } else {
    window.addEventListener('load', pipelineAndPrint, { once: true });
  }

  // 打印触发后让后台清理临时缓存
  chrome.runtime.sendMessage({ type: 'CLEANUP', ticket }).catch(()=>{});
}

main().catch(err => {
  console.error(err);
  document.getElementById('app').textContent = '渲染失败：' + (err?.message || err);
});
