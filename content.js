/* ========================================================================
 * LLM 翻译助手 - Content Script
 * 职责：识别正文、调度翻译、渲染双语内容与管理翻译批次
 * ====================================================================== */

(() => {
  "use strict";

  // popup 兜底注入时避免重复注册消息监听器。
  if (globalThis.__llmTranslatorContentLoaded) return;
  globalThis.__llmTranslatorContentLoaded = true;

  const i18n = (key, subs) => {
    const substitutions = subs
      ? Object.values(subs).map((value) => String(value))
      : undefined;
    return browser.i18n.getMessage(key, substitutions) || key;
  };

  const TRANSLATED_ATTR = "data-llm-translated";
  const TRANSLATION_CLASS = "llm-translation";
  const TRANSLATION_LOADING_CLASS = "llm-translation--loading";
  const TRANSLATION_ERROR_CLASS = "llm-translation--error";
  const TRANSLATION_CANCELLED_CLASS = "llm-translation--cancelled";

  let reqCounter = 0;
  const nextReqId = () => `r${Date.now()}_${reqCounter++}`;

  async function getConcurrency() {
    try {
      const { config } = await browser.storage.local.get("config");
      return Math.max(1, Math.min(10, Number(config?.concurrency) || 3));
    } catch {
      return 3;
    }
  }

  async function ensureConfigured() {
    try {
      const response = await browser.runtime.sendMessage({ type: "PING_CONFIG" });
      if (response?.configured) return true;
      alert(response?.error || i18n("popupNotConfigured"));
    } catch (error) {
      alert(i18n("popupNoBackend") + ` ${error.message || error}`);
    }
    return false;
  }

  async function translateText(text, batchId) {
    const requestId = nextReqId();
    try {
      const response = await browser.runtime.sendMessage({
        type: "TRANSLATE_TEXT",
        text,
        requestId,
        batchId,
      });
      return response || { ok: false, error: i18n("ctNoResponse") };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error),
        code: "MESSAGE",
        retryable: false,
      };
    }
  }

  /* ---------- 正文与段落识别 ---------- */
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED",
    "CODE", "PRE", "KBD", "SAMP", "VAR", "INPUT", "TEXTAREA",
    "SELECT", "BUTTON", "SVG", "CANVAS", "MATH", "AUDIO", "VIDEO",
    "IMG", "BR", "HR", "META", "LINK",
  ]);

  const BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "BLOCKQUOTE", "DD", "DT", "TD", "TH",
    "FIGCAPTION", "CAPTION", "SUMMARY",
  ]);

  const MAIN_CANDIDATES = [
    ["[itemprop='articleBody']", 1200],
    ["[data-bi-area='body_article']", 1200],
    [".entry-content", 1100],
    [".article-body", 1050],
    [".article-content", 1050],
    [".post-content", 1000],
    [".post-body", 1000],
    ["article[data-clarity-region='article']", 950],
    ["article", 700],
    ["main", 500],
    ["[role='main']", 500],
    ["#content", 450],
    ["#article", 450],
    [".post", 400],
    [".article", 400],
    [".content", 300],
  ];

  function elementText(el) {
    return (el?.innerText || "").trim();
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function scoreMainCandidate(el, selectorWeight) {
    const text = elementText(el);
    if (text.length < 50 || !isVisible(el)) return -Infinity;

    const identity = `${el.id || ""} ${el.className || ""}`.toLowerCase();
    const inPeripheralArea = el.closest("aside, nav, footer, header");
    const peripheralName =
      /(?:sidebar|related|recommend|read-next|comments?|navigation|menu|footer)/.test(
        identity
      );
    const linkTextLength = Array.from(el.querySelectorAll("a")).reduce(
      (total, link) => total + elementText(link).length,
      0
    );
    const linkDensity = Math.min(1, linkTextLength / Math.max(1, text.length));

    return (
      selectorWeight +
      Math.min(250, text.length / 80) -
      linkDensity * 250 -
      (inPeripheralArea ? 1200 : 0) -
      (peripheralName ? 700 : 0)
    );
  }

  function findMainScope(root) {
    const candidates = new Map();
    for (const [selector, weight] of MAIN_CANDIDATES) {
      for (const node of root.querySelectorAll(selector)) {
        const previous = candidates.get(node) || -Infinity;
        candidates.set(node, Math.max(previous, scoreMainCandidate(node, weight)));
      }
    }

    let best = null;
    let bestScore = -Infinity;
    for (const [node, score] of candidates) {
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best || root;
  }

  function isTranslatable(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.hasAttribute(TRANSLATED_ATTR)) return false;
    if (el.closest(`.${TRANSLATION_CLASS}`)) return false;
    if (el.closest("[contenteditable='true']")) return false;
    const text = elementText(el);
    if (!text) return false;
    return text.replace(/[\s\d\p{P}\p{S}]/gu, "").length >= 2;
  }

  function collectBlocks(root = document.body) {
    const searchRoot = findMainScope(root);
    const selector = Array.from(BLOCK_TAGS)
      .map((tag) => tag.toLowerCase())
      .join(",");
    const blocks = [];

    for (const el of searchRoot.querySelectorAll(selector)) {
      if (!isTranslatable(el)) continue;
      // 容器型块使用内部更细粒度的块，避免同一文本重复翻译。
      if (el.querySelector(selector)) continue;
      blocks.push(el);
    }

    return Array.from(new Set(blocks));
  }

  /* ---------- 译文渲染 ---------- */
  const INSERT_INSIDE_TAGS = new Set(["LI", "TD", "TH", "DT", "DD", "CAPTION"]);

  function insertTranslationPlaceholder(sourceEl) {
    const placeholder = document.createElement("div");
    placeholder.className = `${TRANSLATION_CLASS} ${TRANSLATION_LOADING_CLASS}`;
    placeholder.textContent = i18n("ctTranslating");

    // ul/ol、tr、dl 只允许特定直接子元素，译文必须放入源元素内部。
    if (INSERT_INSIDE_TAGS.has(sourceEl.tagName)) sourceEl.appendChild(placeholder);
    else sourceEl.after(placeholder);

    sourceEl.setAttribute(TRANSLATED_ATTR, "1");
    return placeholder;
  }

  function setTranslationResult(placeholder, result) {
    placeholder.classList.remove(
      TRANSLATION_LOADING_CLASS,
      TRANSLATION_CANCELLED_CLASS
    );
    if (result.ok) {
      placeholder.textContent = result.translation || i18n("ctEmptyTranslation");
      return;
    }
    if (result.code === "CANCELLED") {
      setCancelledResult(placeholder);
      return;
    }
    placeholder.classList.add(TRANSLATION_ERROR_CLASS);
    placeholder.textContent =
      i18n("ctErrorPrefix") + (result.error || i18n("ctUnknownError"));
  }

  function setCancelledResult(placeholder) {
    placeholder.classList.remove(TRANSLATION_LOADING_CLASS, TRANSLATION_ERROR_CLASS);
    placeholder.classList.add(TRANSLATION_CANCELLED_CLASS);
    placeholder.textContent = i18n("ctCancelled");
  }

  /* ---------- 批次、取消与进度 ---------- */
  let activeBatch = null;
  let progressEl = null;
  let progressTextEl = null;

  function createBatch() {
    if (activeBatch && !activeBatch.cancelled) cancelBatch(activeBatch);
    activeBatch = {
      id: `b${Date.now()}_${reqCounter++}`,
      cancelled: false,
      failures: 0,
    };
    return activeBatch;
  }

  function cancelBatch(batch) {
    if (!batch || batch.cancelled) return;
    batch.cancelled = true;
    browser.runtime
      .sendMessage({ type: "CANCEL_TRANSLATION", batchId: batch.id })
      .catch(() => {});
  }

  function finishBatch(batch) {
    browser.runtime
      .sendMessage({ type: "FINISH_TRANSLATION", batchId: batch.id })
      .catch(() => {});
    if (activeBatch === batch) activeBatch = null;
  }

  function showProgress(done, total, batch) {
    if (activeBatch !== batch) return;
    if (!progressEl) {
      progressEl = document.createElement("div");
      progressEl.id = "llm-translator-progress";
      progressTextEl = document.createElement("span");
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = i18n("ctCancel");
      cancelButton.addEventListener("click", () => cancelBatch(activeBatch));
      progressEl.append(progressTextEl, cancelButton);
      document.documentElement.appendChild(progressEl);
    }
    progressTextEl.textContent = `${i18n("progressLabel")}${done}/${total}`;
    progressEl.style.display = "flex";
  }

  function hideProgress(batch) {
    if (batch && activeBatch && activeBatch !== batch) return;
    if (progressEl) progressEl.style.display = "none";
  }

  function isFatalResult(result, batch) {
    if (result.ok || result.code === "CANCELLED") return false;
    batch.failures++;
    return (
      result.code === "AUTH" ||
      result.code === "CONFIG" ||
      [400, 401, 403, 404].includes(result.status) ||
      batch.failures >= 3
    );
  }

  async function runWithConcurrency(tasks, limit, batch, onDone) {
    let index = 0;
    let done = 0;

    async function worker() {
      while (!batch.cancelled && index < tasks.length) {
        const current = index++;
        await tasks[current]();
        done++;
        onDone?.(done, tasks.length);
      }
    }

    const workers = Array.from(
      { length: Math.min(limit, tasks.length) },
      () => worker()
    );
    await Promise.all(workers);
  }

  /* ---------- 翻译入口 ---------- */
  async function translatePage() {
    const blocks = collectBlocks();
    if (blocks.length === 0) {
      alert(i18n("ctNoContent"));
      return;
    }
    if (blocks.length > 500 && !confirm(i18n("ctTooMany", { COUNT: blocks.length }))) {
      return;
    }
    if (!(await ensureConfigured())) return;

    // 必须在插入占位符前保存文本；列表和表格译文会插入源元素内部。
    const items = blocks.map((el) => ({ el, text: elementText(el) }));
    const placeholders = items.map(({ el }) => insertTranslationPlaceholder(el));
    const batch = createBatch();
    showProgress(0, items.length, batch);

    const tasks = items.map(({ text }, index) => async () => {
      if (batch.cancelled) return;
      const result = await translateText(text, batch.id);
      setTranslationResult(placeholders[index], result);
      if (isFatalResult(result, batch)) cancelBatch(batch);
    });

    try {
      const concurrency = await getConcurrency();
      await runWithConcurrency(tasks, concurrency, batch, (done, total) =>
        showProgress(done, total, batch)
      );
      if (batch.cancelled) {
        for (const placeholder of placeholders) {
          if (placeholder.classList.contains(TRANSLATION_LOADING_CLASS)) {
            setCancelledResult(placeholder);
          }
        }
      }
    } finally {
      finishBatch(batch);
      hideProgress(batch);
    }
  }

  async function translateSelection(selectionText) {
    const selection = window.getSelection();
    const text = String(selectionText || selection?.toString() || "").trim();
    if (!text) {
      alert(i18n("ctSelectFirst"));
      return;
    }
    if (!(await ensureConfigured())) return;

    const placeholder = document.createElement("span");
    placeholder.className = `${TRANSLATION_CLASS} ${TRANSLATION_LOADING_CLASS}`;
    placeholder.textContent = i18n("ctTranslating");

    try {
      if (!selection?.rangeCount) throw new Error(i18n("ctNoSelection"));
      const range = selection.getRangeAt(0).cloneRange();
      range.collapse(false);
      range.insertNode(placeholder);
      placeholder.after(document.createElement("br"));
    } catch {
      document.body.appendChild(placeholder);
    }

    const batch = createBatch();
    showProgress(0, 1, batch);
    try {
      const result = await translateText(text, batch.id);
      setTranslationResult(placeholder, result);
      showProgress(1, 1, batch);
    } finally {
      finishBatch(batch);
      hideProgress(batch);
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRANSLATE_PAGE") {
      translatePage().catch((error) => {
        hideProgress();
        alert(i18n("ctErrorAlert") + error.message);
      });
    } else if (msg.type === "TRANSLATE_SELECTION") {
      translateSelection(msg.selectionText).catch((error) => {
        hideProgress();
        alert(i18n("ctErrorAlert") + error.message);
      });
    }
  });
})();
