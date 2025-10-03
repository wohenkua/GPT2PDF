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
    let nodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
    if (!nodes.length) {
      nodes = Array.from(document.querySelectorAll('article'));
    }

    nodes = nodes.filter((node, index, arr) => {
      return !arr.some((other, otherIndex) => otherIndex !== index && other.contains(node));
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
      const ALLOW = new Set([
        'P','A','STRONG','B','EM','I','U','S','UL','OL','LI','BLOCKQUOTE','BR',
        'H1','H2','H3','H4','H5','H6','PRE','CODE','KBD','SAMP','IMG',
        'FIGURE','FIGCAPTION','PICTURE','SOURCE'
      ]);
      const allowedDescendantSelector = Array.from(ALLOW)
        .map(tag => tag.toLowerCase())
        .join(',');
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
        } else if (node.tagName === 'IMG') {
          const absolutize = (url) => {
            if (!url) return '';
            try { return new URL(url, location.href).href; } catch { return ''; }
          };

          const cleanupAttributes = () => {
            Array.from(node.attributes).forEach(attr => {
              const name = attr.name.toLowerCase();
              if (name.startsWith('on')) {
                node.removeAttribute(attr.name);
              }
            });
          };

          const parseSrcset = (value) => {
            if (!value) return { list: [], best: '' };
            const entries = value.split(',').map(part => {
              const trimmed = part.trim();
              if (!trimmed) return null;
              const spaceIndex = trimmed.lastIndexOf(' ');
              let url = trimmed;
              let descriptor = '';
              if (spaceIndex > -1) {
                url = trimmed.slice(0, spaceIndex).trim();
                descriptor = trimmed.slice(spaceIndex + 1).trim();
              }
              const abs = absolutize(url);
              if (!abs) return null;
              let score = 0;
              if (/^[0-9]+w$/.test(descriptor)) {
                score = parseInt(descriptor, 10) || 0;
              } else if (/^[0-9]*\.?[0-9]+x$/.test(descriptor)) {
                score = parseFloat(descriptor) || 0;
              } else {
                score = abs.length;
              }
              return { abs, descriptor, score };
            }).filter(Boolean);

            let best = '';
            if (entries.length) {
              entries.sort((a, b) => b.score - a.score);
              best = entries[0].abs;
            }
            const setValue = entries.map(e => `${e.abs}${e.descriptor ? ` ${e.descriptor}` : ''}`).join(', ');
            return { list: entries, best, setValue };
          };

          const srcsetAttr = node.getAttribute('srcset') || node.getAttribute('data-srcset');
          const parsedSrcset = parseSrcset(srcsetAttr);
          if (parsedSrcset.list.length) {
            node.setAttribute('srcset', parsedSrcset.setValue);
          } else {
            node.removeAttribute('srcset');
          }
          if (node.hasAttribute('data-srcset')) {
            node.removeAttribute('data-srcset');
          }

          const candidateAttrs = [
            'src', 'data-src', 'data-original', 'data-url', 'data-lazy-src',
            'data-lazyload', 'data-image', 'data-zoom-src', 'data-href'
          ];
          const candidates = [];
          candidateAttrs.forEach(attr => {
            const val = node.getAttribute(attr);
            if (val) candidates.push(val);
          });
          if (parsedSrcset.best) {
            candidates.push(parsedSrcset.best);
          }
          const finalSrc = candidates.map(absolutize).find(Boolean);
          if (finalSrc) {
            node.setAttribute('src', finalSrc);
          }
          candidateAttrs.forEach(attr => {
            if (attr !== 'src') node.removeAttribute(attr);
          });

          const alt = node.getAttribute('alt');
          if (alt == null) {
            node.setAttribute('alt', '');
          }

          cleanupAttributes();
        }
      }
      toReplace.forEach(n => {
        const shouldPreserveChildren =
          typeof n.querySelector === 'function' &&
          allowedDescendantSelector &&
          n.querySelector(allowedDescendantSelector);
        if (shouldPreserveChildren) {
          n.replaceWith(...Array.from(n.childNodes));
          return;
        }
        const text = n.textContent || '';
        const withinCode = typeof n.closest === 'function' ? n.closest('pre, code') : null;

        if (!text.trim() && !withinCode) {
          n.remove();
          return;
        }

        if (withinCode) {
          n.replaceWith(document.createTextNode(text));
          return;
        }

        if (/\n/.test(text)) {
          const pre = document.createElement('pre');
          pre.textContent = text;
          n.replaceWith(pre);
          return;
        }

        const span = document.createElement('span');
        span.textContent = text;
        n.replaceWith(span);
      });

      let html = frag.innerHTML.trim();
      if (!html) {
        const rawText = content.textContent || '';
        const trimmed = rawText.trim();
        if (trimmed) {
          if (/\n/.test(rawText)) {
            const pre = document.createElement('pre');
            pre.textContent = rawText.replace(/^[\n\r]+|[\n\r]+$/g, '');
            html = pre.outerHTML;
          } else {
            const p = document.createElement('p');
            p.textContent = trimmed;
            html = p.outerHTML;
          }
        } else {
          html = '';
        }
      }

      return {
        id: 'm' + (i + 1),
        role,
        blocks: [{ type: 'text', html }]
      };
    }).filter(m => m.blocks && m.blocks.length);

    const title = (document.title || '').replace(/\s*\|\s*ChatGPT.*/i, '').trim() || 'ChatGPT 对话';
    return {
      title,
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
