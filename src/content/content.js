(() => {
  // 防止重复注入
  if (window.__cg2pdf_injected__) return;
  window.__cg2pdf_injected__ = true;

  // ================= 工具函数 =================
  function toAbs(url) { try { return new URL(url, location.href).href; } catch { return url; } }

  // 在原 DOM 与克隆 DOM 间用“路径”定位同一元素
  function elemPath(el, root) {
    const path = [];
    let cur = el;
    while (cur && cur !== root) {
      if (!cur.parentElement) break;
      const siblings = Array.from(cur.parentElement.children);
      const idx = siblings.indexOf(cur);
      path.unshift(idx);
      cur = cur.parentElement;
    }
    return path;
  }
  function elemByPath(root, path) {
    let cur = root;
    for (const i of path) {
      if (!cur || !cur.children || !cur.children[i]) return null;
      cur = cur.children[i];
    }
    return cur;
  }

  // 规范化富文本：保留语义标签；对交互外壳做“解包”，不删子节点
  function sanitizeRichText(container) {
    const ALLOW = new Set([
      'P','H1','H2','H3','H4','H5','H6',
      'STRONG','EM','B','I','U','S','SUB','SUP','SMALL','MARK',
      'UL','OL','LI','BLOCKQUOTE',
      'A','CODE','BR','HR','SPAN'
    ]);

    function unwrapKeepChildren(el) {
      const parent = el.parentNode;
      if (!parent) { el.remove(); return; }
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      el.remove();
    }

    const div = document.createElement('div');
    div.innerHTML = container.innerHTML;

    // 解包交互性外壳，避免把占位符一并删掉（如 <button><img/></button>）
    div.querySelectorAll('button, menu, label, span[role="button"]').forEach(unwrapKeepChildren);

    // 纯装饰/表单控件直接移除
    div.querySelectorAll('svg, path, input, textarea, select').forEach(n => n.remove());

    // 移除仅用于可访问性的隐藏角色标签
    div.querySelectorAll('[data-testid="conversation-turn-label"], .sr-only, [aria-hidden="true"]').forEach(n => n.remove());

    // 规范链接、降级未知标签
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_ELEMENT, null);
    const toReplace = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const tag = el.tagName;
      if (!ALLOW.has(tag)) {
        const span = document.createElement('span');
        span.innerHTML = el.innerHTML;
        toReplace.push([el, span]);
      }
      if (tag === 'A') {
        const href = el.getAttribute('href');
        if (href) {
          try { el.setAttribute('href', new URL(href, location.href).href); } catch {}
        }
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    toReplace.forEach(([from, to]) => from.replaceWith(to));
    return div;
  }

  // 角色识别
  function detectRole(el) {
    const attr = (el.getAttribute('data-message-author-role') || '').toLowerCase();
    if (attr.includes('assistant')) return 'assistant';
    if (attr.includes('user')) return 'user';
    const cls = (el.className || '').toLowerCase();
    if (/assistant|bot|model/.test(cls)) return 'assistant';
    if (/user|human/.test(cls)) return 'user';
    if (el.querySelector('pre code, .katex, mjx-container, img, figure')) return 'assistant';
    return 'user';
  }

  // ============ 图片 URL 处理（去 Next.js 代理、选最大 srcset） ============
  function unwrapNextImage(u) {
    try {
      const url = new URL(u, location.href);
      if (url.pathname.includes('/_next/image') && url.searchParams.get('url')) {
        return decodeURIComponent(url.searchParams.get('url'));
      }
    } catch {}
    return u;
  }
  function pickLargestFromSrcset(srcset) {
    try {
      const items = srcset.split(',').map(s => s.trim()).map(s => {
        const m = s.match(/(\S+)\s+(\d+)w/);
        return m ? { url: m[1], w: parseInt(m[2], 10) } : null;
      }).filter(Boolean);
      if (!items.length) return null;
      items.sort((a,b) => b.w - a.w);
      return items[0].url;
    } catch { return null; }
  }
  function normalizeImageUrl(imgEl) {
    const largest = imgEl.getAttribute('srcset') ? pickLargestFromSrcset(imgEl.getAttribute('srcset')) : null;
    let url = largest || imgEl.currentSrc || imgEl.src || '';
    url = unwrapNextImage(url);
    try { url = new URL(url, location.href).href; } catch {}
    return url;
  }

  // ============ chatgpt.com 后端临时签名图：强制转 data: ============
  function isEphemeralChatgptImage(url) {
    try {
      const u = new URL(url, location.href);
      return u.hostname === 'chatgpt.com'
        && u.pathname.startsWith('/backend-api/estuary/content')
        && (u.searchParams.get('sig') || u.searchParams.get('ts') || u.searchParams.get('id'));
    } catch { return false; }
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  async function inlineEphemeralImages(blocks, sizeLimitMB = 10) {
    const sizeLimit = sizeLimitMB * 1024 * 1024;
    for (const b of blocks) {
      if (b.type === 'image' && b.src && isEphemeralChatgptImage(b.src)) {
        try {
          const resp = await fetch(b.src, { credentials: 'include' });
          if (!resp.ok) { console.warn('图片直链不可用：', b.src, resp.status); continue; }
          const blob = await resp.blob();
          if (!/^image\//i.test(blob.type)) { console.warn('非图片 MIME：', b.src, blob.type); continue; }
          if (blob.size > sizeLimit) { console.warn('图片太大，跳过内联：', b.src, blob.size); continue; }
          b.originalSrc = b.src;
          b.src = await blobToDataURL(blob); // 改为 data:image/...;base64,...
        } catch (e) {
          console.warn('图片内联失败：', b.src, e);
        }
      }
    }
  }

  // ================= 抽取消息 blocks =================
  // 识别 text / image / code / formula，并保持文档顺序
  function extractBlocks(msgNode) {
    const ROLE_HINT_TEXTS = new Set([
      '您说',
      '你说',
      'chatgpt 说',
      'you said',
      'chatgpt said',
      'assistant said'
    ].map(t => t.toLowerCase()));

    // 找“重要块”
    const important = [];
    const tw = document.createTreeWalker(msgNode, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'pre' && el.querySelector('code')) return NodeFilter.FILTER_ACCEPT;
        if (tag === 'figure') return NodeFilter.FILTER_ACCEPT;
        if (tag === 'img' && !el.closest('figure')) return NodeFilter.FILTER_ACCEPT;
        if (el.classList?.contains('katex') || el.querySelector?.('.katex')) return NodeFilter.FILTER_ACCEPT;
        if (tag.startsWith('mjx-') || el.querySelector?.('mjx-container')) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    while (tw.nextNode()) important.push(tw.currentNode);

    // 克隆并用占位符替换重要块，同时收集块数据
    const clone = msgNode.cloneNode(true);
    const blocksInOrder = [];
    important.forEach((origNode, idx) => {
      const path = elemPath(origNode, msgNode);
      const nodeInClone = elemByPath(clone, path);
      if (!nodeInClone) return;

      const tag = origNode.tagName.toLowerCase();
      if (tag === 'pre' && origNode.querySelector('code')) {
        const codeEl = origNode.querySelector('code');
        const lang = (codeEl.className || '').match(/language-([\w+-]+)/i)?.[1]?.toLowerCase() || null;
        const code = codeEl.textContent || '';
        blocksInOrder.push({ type: 'code', lang, code });
      } else if (tag === 'figure') {
        const img = origNode.querySelector('img');
        if (img) {
          blocksInOrder.push({
            type: 'image',
            src: normalizeImageUrl(img),
            alt: img.getAttribute('alt') || '',
            caption: (origNode.querySelector('figcaption')?.textContent || '').trim() || undefined
          });
        }
      } else if (tag === 'img') {
        blocksInOrder.push({
          type: 'image',
          src: normalizeImageUrl(origNode),
          alt: origNode.getAttribute('alt') || ''
        });
      } else if (origNode.classList?.contains('katex') || origNode.querySelector?.('.katex')) {
        const container = origNode.classList.contains('katex') ? origNode : origNode.querySelector('.katex');
        const texAnn = container.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
        const tex = texAnn ? texAnn.textContent : null;
        const isDisplay = container.querySelector('.katex-display') ? true : false;
        blocksInOrder.push({ type: 'formula', tex: tex || undefined, html: tex ? undefined : container.outerHTML, display: isDisplay });
      } else if (tag.startsWith('mjx-') || origNode.querySelector('mjx-container')) {
        const mjx = origNode.closest('mjx-container') || origNode.querySelector('mjx-container') || origNode;
        const isDisplay = mjx.getAttribute('display') === 'true';
        blocksInOrder.push({ type: 'formula', html: mjx.outerHTML, display: isDisplay });
      }

      const ph = document.createElement('span');
      ph.setAttribute('data-cg2pdf-ph', String(idx));
      nodeInClone.replaceWith(ph);
    });

    // 清洗剩余富文本
    const cleaned = sanitizeRichText(clone);
    const html = cleaned.innerHTML.trim();

    // 用占位符把 text 与“重要块”拼回原顺序
    const parts = html.split(/<span[^>]*data-cg2pdf-ph="(\d+)"[^>]*><\/span>/g);
    const blocks = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        const textHtml = parts[i]?.trim();
        if (textHtml) {
          const tmp = document.createElement('div');
          tmp.innerHTML = textHtml;
          const rawText = (tmp.textContent || '').trim();
          const normalized = rawText.replace(/[:：\s]+$/g, '').toLowerCase();
          if (rawText && !ROLE_HINT_TEXTS.has(normalized)) {
            blocks.push({ type: 'text', html: textHtml });
          }
        }
      } else {
        const idx = Number(parts[i]);
        const b = blocksInOrder[idx];
        if (b) blocks.push(b);
      }
    }
    return blocks.filter(b => {
      if (b.type === 'text') return !!b.html;
      if (b.type === 'image') return !!b.src;
      if (b.type === 'code') return !!(b.code && b.code.trim());
      if (b.type === 'formula') return !!(b.tex || b.html);
      return false;
    });
  }

  // 找到页面中的消息节点（尽量稳的并联选择器）
  function findMessageNodes() {
    const seen = new Set();
    const out = [];
    const sels = [
      '[data-message-author-role]',
      'article'
    ];
    sels.forEach(sel => {
      document.querySelectorAll(sel).forEach(n => {
        if (sel === 'article') {
          const ancestorWithRole = n.closest('[data-message-author-role]');
          if (ancestorWithRole && ancestorWithRole !== n) return;
        }
        if (!seen.has(n)) { seen.add(n); out.push(n); }
      });
    });
    out.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    const filtered = [];
    out.forEach(node => {
      if (filtered.some(parent => parent !== node && parent.contains(node))) return;
      filtered.push(node);
    });
    return filtered;
  }

  // ================= DOM → 结构化：异步（为图片内联） =================
  async function extractConversationRich() {
    const nodes = findMessageNodes();
    const items = nodes.map((el, i) => {
      const role = detectRole(el);
      const blocks = extractBlocks(el);
      return { id: 'm' + (i + 1), role, blocks };
    }).filter(m => m.blocks.length);

    // 对每条消息处理临时签名图 → data:
    for (const m of items) {
      await inlineEphemeralImages(m.blocks, 10); // 10MB 阈值可调
    }

    const title = (document.title || '').replace(/\s*\|\s*ChatGPT.*/i, '').trim() || 'ChatGPT 对话';
    return {
      title,
      sourceUrl: location.href,
      exportedAt: new Date().toISOString(),
      items
    };
  }

  // ================= 悬浮按钮 & 导出动作 =================
  const btn = document.createElement('div');
  btn.id = 'cg2pdf-btn';
  btn.textContent = '导出 PDF';
  document.documentElement.appendChild(btn);
  btn.addEventListener('click', onExportClicked);

  async function onExportClicked() {
    btn.textContent = '解析中…';
    btn.style.pointerEvents = 'none';
    try {
      const conversation = await extractConversationRich();
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
