(() => {
  // 防止重复注入
  if (window.__cg2pdf_injected__) return;
  window.__cg2pdf_injected__ = true;

  // 创建按钮
  const btn = document.createElement('div');
  btn.id = 'cg2pdf-btn';
  btn.textContent = '导出 PDF';
  document.documentElement.appendChild(btn);
  btn.addEventListener('click', onExportClicked);

  // —— 最小抽取：把页面上的“消息块”按顺序抓成 text/html ——
  function extractMinimalConversation() {
    // 选取候选消息容器（不同 UI 可能不同；这里做并联）
    const nodes = [];
    const sels = [
      '[data-message-author-role]', // 常见
      'article'                     // 有时每条消息是 article
    ];
    sels.forEach(sel => {
      document.querySelectorAll(sel).forEach(n => {
        if (!nodes.includes(n)) nodes.push(n);
      });
    });

    // 依据文档顺序排列
    const ordered = nodes.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const items = ordered.map((el, i) => {
      // 简易角色判断
      const roleAttr = (el.getAttribute('data-message-author-role') || '').toLowerCase();
      const role = roleAttr.includes('assistant') ? 'assistant'
                 : roleAttr.includes('user') ? 'user'
                 : (el.textContent || '').trim().length ? 'assistant' : 'user';

      // 在消息内查找 markdown 容器/正文区域；如果找不到，就退化为纯文本包 <p>
      const content =
        el.querySelector('.markdown, .prose, .message-content, .whitespace-pre-wrap') || el;

      // 仅保留基础语义（p/a/strong/em/ul/ol/li/blockquote/br）
      const frag = document.createElement('div');
      frag.innerHTML = content.innerHTML;

      // 简单清洗：移除交互组件（按钮、菜单、头像等）
      frag.querySelectorAll('button, menu, svg').forEach(n => n.remove());

      // 只保留简单标签，其他降级为文本
      const ALLOW = new Set(['P','A','STRONG','B','EM','I','U','S','UL','OL','LI','BLOCKQUOTE','BR','H1','H2','H3','H4','H5','H6']);
      const walker = document.createTreeWalker(frag, NodeFilter.SHOW_ELEMENT);
      const toReplace = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!ALLOW.has(node.tagName)) toReplace.push(node);
        if (node.tagName === 'A') {
          const href = node.getAttribute('href');
          if (href) {
            try { node.setAttribute('href', new URL(href, location.href).href); } catch {}
          }
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
      toReplace.forEach(n => {
        const span = document.createElement('span');
        span.textContent = n.textContent || '';
        n.replaceWith(span);
      });

      const html = frag.innerHTML.trim() || `<p>${(content.textContent || '').trim()}</p>`;

      return {
        id: 'm' + (i + 1),
        role,
        blocks: [{ type: 'text', html }]
      };
    }).filter(m => m.blocks && m.blocks.length);

    const title = (document.title || '').replace(/\s*\|\s*ChatGPT.*/i, '').trim() || 'ChatGPT 对话';
    return {
      title,
      sourceUrl: location.href,
      exportedAt: new Date().toISOString(),
      items
    };
  }

  async function onExportClicked() {
    btn.textContent = '准备中…';
    btn.style.pointerEvents = 'none';

    try {
      const conversation = extractMinimalConversation();
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'OPEN_EXPORTER', conversation }, (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (resp && resp.ok) resolve();
          else reject(new Error('后台未响应'));
        });
      });
      btn.textContent = '已打开预览';
      setTimeout(() => { btn.textContent = '导出 PDF'; btn.style.pointerEvents = 'auto'; }, 1500);
    } catch (e) {
      console.error(e);
      alert('导出失败：' + (e?.message || e));
      btn.textContent = '导出 PDF';
      btn.style.pointerEvents = 'auto';
    }
  }
})();
