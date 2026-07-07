/* ========================================================================
 * AI 翻译助手 - Content Script
 * 职责：
 *   1. 接收翻译指令（整页 / 选中）
 *   2. 识别正文段落
 *   3. 并发调用 background 翻译，按原文顺序在下方插入译文
 *   4. 显示进度浮层
 * ====================================================================== */

(() => {
  "use strict";

  /* ---------- i18n helper ---------- */
  const i18n = (key, subs) => {
    let msg = browser.i18n.getMessage(key) || key;
    if (subs) {
      for (const k in subs) {
        msg = msg.replace(new RegExp(`\\$${k}\\$`, "g"), String(subs[k]));
      }
    }
    return msg;
  };

  /* 已翻译标记，避免重复翻译 */
  const TRANSLATED_ATTR = "data-ai-translated";
  const TRANSLATION_CLASS = "ai-translation";
  const TRANSLATION_LOADING_CLASS = "ai-translation--loading";
  const TRANSLATION_ERROR_CLASS = "ai-translation--error";

  /* ---------- 工具：生成唯一请求 id ---------- */
  let reqCounter = 0;
  const nextReqId = () => `r${Date.now()}_${reqCounter++}`;

  /* ---------- 读取并发配置 ---------- */
  async function getConcurrency() {
    try {
      const { config } = await browser.storage.local.get("config");
      return Math.max(1, Math.min(10, Number(config?.concurrency) || 3));
    } catch {
      return 3;
    }
  }

  /* ---------- 调用 background 翻译单段文本 ---------- */
  function translateText(text) {
    const requestId = nextReqId();
    return new Promise((resolve) => {
      browser.runtime.sendMessage(
        { type: "TRANSLATE_TEXT", text, requestId },
        (resp) => {
          if (browser.runtime.lastError) {
            resolve({ ok: false, error: browser.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: i18n("ctNoResponse") });
        }
      );
    });
  }

  /* ---------- 判断节点是否值得翻译 ---------- */
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED",
    "CODE", "PRE", "KBD", "SAMP", "VAR", "INPUT", "TEXTAREA",
    "SELECT", "BUTTON", "SVG", "CANVAS", "MATH", "AUDIO", "VIDEO",
    "IMG", "BR", "HR", "META", "LINK",
  ]);

  function isTranslatable(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return false;
    if (el.hasAttribute(TRANSLATED_ATTR)) return false;
    if (el.closest(".ai-translation")) return false; // 不翻译已插入的译文
    if (el.closest("[contenteditable='true']")) return false;
    const text = (el.innerText || "").trim();
    if (text.length < 1) return false;
    // 跳过几乎全是数字/符号的节点
    if (text.replace(/[\s\d\p{P}\p{S}]/gu, "").length < 2) return false;
    return true;
  }

  /* ---------- 收集可翻译的段落块 ----------
   * 优先选择语义容器；若容器内文字过长则下沉到叶子块级元素。
   * 策略：取正文区域内所有候选块级元素，去重保留最细粒度可翻译单元。
   */
  const BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "BLOCKQUOTE", "DD", "DT", "TD", "TH",
    "FIGCAPTION", "CAPTION", "SUMMARY", "DT",
  ]);

  function collectBlocks(root = document.body) {
    // 先尝试定位正文容器
    const mainSelectors = [
      "article", "main", "[role='main']", "#content", "#article",
      ".post", ".article", ".content", ".entry-content",
    ];
    let scope = null;
    for (const sel of mainSelectors) {
      const node = root.querySelector(sel);
      if (node && node.innerText && node.innerText.length > 50) {
        scope = node;
        break;
      }
    }
    const searchRoot = scope || root;

    const blocks = [];
    const candidates = searchRoot.querySelectorAll(
      BLOCK_TAGS.size
        ? Array.from(BLOCK_TAGS).map((t) => t.toLowerCase()).join(",")
        : "p"
    );

    for (const el of candidates) {
      if (!isTranslatable(el)) continue;
      // 若该块内部还含有其它块级元素，说明它是容器，跳过（用叶子块翻译更精准）
      const innerBlocks = el.querySelectorAll(Array.from(BLOCK_TAGS).join(","));
      if (innerBlocks.length === 0) {
        blocks.push(el);
      }
    }

    // 兜底：若一个都没找到，退化到对所有块级元素翻译
    if (blocks.length === 0) {
      const all = searchRoot.querySelectorAll(
        "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption"
      );
      for (const el of all) {
        if (isTranslatable(el)) blocks.push(el);
      }
    }

    // 去重（嵌套情况下可能重复）
    const seen = new Set();
    return blocks.filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return true;
    });
  }

  /* ---------- 在原文下方插入译文占位 ---------- */
  function insertTranslationPlaceholder(sourceEl) {
    const placeholder = document.createElement("div");
    placeholder.className = `${TRANSLATION_CLASS} ${TRANSLATION_LOADING_CLASS}`;
    placeholder.textContent = i18n("ctTranslating");
    // 插入到源元素之后；对 li 等也用 after 保证就近
    sourceEl.after(placeholder);
    sourceEl.setAttribute(TRANSLATED_ATTR, "1");
    return placeholder;
  }

  /* ---------- 更新译文内容 ---------- */
  function setTranslationResult(placeholder, result) {
    placeholder.classList.remove(TRANSLATION_LOADING_CLASS);
    if (result.ok) {
      placeholder.textContent = result.translation || i18n("ctEmptyTranslation");
    } else {
      placeholder.classList.add(TRANSLATION_ERROR_CLASS);
      placeholder.textContent = i18n("ctErrorPrefix") + (result.error || i18n("ctUnknownError"));
    }
  }

  /* ---------- 进度浮层 ---------- */
  let progressEl = null;
  function showProgress(done, total) {
    if (!progressEl) {
      progressEl = document.createElement("div");
      progressEl.id = "ai-translator-progress";
      document.documentElement.appendChild(progressEl);
    }
    progressEl.textContent = `${i18n("progressLabel")}${done}/${total}`;
    progressEl.style.display = "block";
  }
  function hideProgress() {
    if (progressEl) progressEl.style.display = "none";
  }

  /* ---------- 并发调度 ---------- */
  async function runWithConcurrency(tasks, limit = 3, onDone) {
    let index = 0;
    let done = 0;
    const total = tasks.length;

    async function worker() {
      while (index < tasks.length) {
        const cur = index++;
        await tasks[cur]();
        done++;
        if (onDone) onDone(done, total);
      }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
      worker()
    );
    await Promise.all(workers);
  }

  /* ---------- 整页翻译 ---------- */
  async function translatePage() {
    const blocks = collectBlocks();
    if (blocks.length === 0) {
      alert(i18n("ctNoContent"));
      return;
    }
    if (blocks.length > 500) {
      if (!confirm(i18n("ctTooMany", { COUNT: blocks.length }))) {
        return;
      }
    }

    showProgress(0, blocks.length);

    // 先建立占位（保持原文顺序），再并发填充
    const placeholders = blocks.map((el) => insertTranslationPlaceholder(el));

    const tasks = blocks.map((el, i) => async () => {
      const text = (el.innerText || "").trim();
      const result = await translateText(text);
      setTranslationResult(placeholders[i], result);
    });

    try {
      const concurrency = await getConcurrency();
      await runWithConcurrency(tasks, concurrency, (done, total) =>
        showProgress(done, total)
      );
    } finally {
      hideProgress();
    }
  }

  /* ---------- 选中内容翻译 ----------
   * 取用户选区覆盖的最小块级元素集合，仅翻译这些块。
   */
  async function translateSelection(selectionText) {
    const sel = window.getSelection();
    let blocks = [];

    if (selectionText && selectionText.trim()) {
      // 直接翻译选中的纯文本：插入到选区末尾
      const span = document.createElement("span");
      span.className = `${TRANSLATION_CLASS} ${TRANSLATION_LOADING_CLASS}`;
      span.textContent = i18n("ctTranslating");

      let range;
      try {
        if (sel && sel.rangeCount) {
          range = sel.getRangeAt(0).cloneRange();
          range.collapse(false); // 折叠到末尾
          range.insertNode(span);
          // 插入后换行
          span.parentNode.insertBefore(
            document.createElement("br"),
            span.nextSibling
          );
        } else {
          throw new Error(i18n("ctNoSelection"));
        }
      } catch {
        // 兜底：直接 body 末尾
        document.body.appendChild(span);
      }

      const result = await translateText(selectionText.trim());
      setTranslationResult(span, result);
      return;
    }

    // 通过选区收集块
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const fragment = range.cloneContents();
      const tmp = document.createElement("div");
      tmp.appendChild(fragment);
      const cand = tmp.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption, span, div");
      for (const el of cand) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t.length > 1 && !el.querySelector("p, li, h1, h2, h3, h4, h5, h6, blockquote, div")) {
          blocks.push({ text: t, parent: null });
        }
      }
      // 去重
      const seen = new Set();
      blocks = blocks.filter((b) => {
        if (seen.has(b.text)) return false;
        seen.add(b.text);
        return true;
      });
    }

    if (blocks.length === 0) {
      alert(i18n("ctSelectFirst"));
      return;
    }

    showProgress(0, blocks.length);
    // 在选区末尾插入一个容器，按序追加译文
    const container = document.createElement("div");
    container.className = "ai-translation-group";
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(false);
      r.insertNode(container);
    } else {
      document.body.appendChild(container);
    }

    const placeholders = blocks.map(() => {
      const p = document.createElement("div");
      p.className = `${TRANSLATION_CLASS} ${TRANSLATION_LOADING_CLASS}`;
      p.textContent = i18n("ctTranslating");
      container.appendChild(p);
      return p;
    });

    const tasks = blocks.map((b, i) => async () => {
      const result = await translateText(b.text);
      setTranslationResult(placeholders[i], result);
    });

    try {
      const concurrency = await getConcurrency();
      await runWithConcurrency(tasks, concurrency, (done, total) =>
        showProgress(done, total)
      );
    } finally {
      hideProgress();
    }
  }

  /* ---------- 接收消息 ---------- */
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRANSLATE_PAGE") {
      translatePage().catch((e) => {
        hideProgress();
        alert(i18n("ctErrorAlert") + e.message);
      });
    } else if (msg.type === "TRANSLATE_SELECTION") {
      translateSelection(msg.selectionText).catch((e) => {
        hideProgress();
        alert(i18n("ctErrorAlert") + e.message);
      });
    }
  });
})();
