/* ========================================================================
 * AI 翻译助手 - Background Service Script
 * 职责：
 *   1. 管理右键菜单
 *   2. 接收 content script 的翻译请求，调用 Anthropic 兼容 API
 *   3. 转发翻译进度/结果回 content script
 * ====================================================================== */

/* ---------- 默认配置 ---------- */
function defaultConfig() {
  return {
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    model: "claude-sonnet-5",
    targetLang: "zh",
    sourceLang: "auto",
    maxTokens: 1024,
    temperature: 0.3,
    concurrency: 3,
    promptTemplate:
      browser.i18n.getMessage("promptDefault") ||
      "你是专业翻译。将以下{{sourceLang}}文本翻译为{{targetLang}}，仅输出译文，不要任何解释或前后缀，保留原文的格式、标点与专有名词。\n\n原文：\n{{text}}",
  };
}

/* ---------- 读取配置 ---------- */
async function getConfig() {
  const stored = await browser.storage.local.get("config");
  return { ...defaultConfig(), ...(stored.config || {}) };
}

/* ---------- 归一化 Base URL ---------- */
function normalizeBaseUrl(url) {
  if (!url) return "https://api.anthropic.com";
  url = url.trim().replace(/\/+$/, "");
  // 去掉结尾的 /v1，后续统一拼接
  url = url.replace(/\/v1$/i, "");
  return url;
}

/* ---------- 语言代码 -> 本地化名称 ---------- */
const LANG_CODE_TO_KEY = {
  zh: "langChinese",
  en: "langEnglish",
  ja: "langJapanese",
  ko: "langKorean",
  fr: "langFrench",
  de: "langGerman",
  es: "langSpanish",
  ru: "langRussian",
};

function langName(code) {
  if (!code || code === "auto") return ""; // 自动检测留空
  const key = LANG_CODE_TO_KEY[code];
  return key ? browser.i18n.getMessage(key) || code : code;
}

/* ---------- 构造提示词 ---------- */
function buildPrompt(text, config) {
  const sourceLang = langName(config.sourceLang);
  return config.promptTemplate
    .replace(/\{\{sourceLang\}\}/g, sourceLang)
    .replace(/\{\{targetLang\}\}/g, langName(config.targetLang) || config.targetLang)
    .replace(/\{\{text\}\}/g, text);
}

/* ---------- 调用 Anthropic Messages API ---------- */
async function callAnthropic(text, config) {
  const url = normalizeBaseUrl(config.baseUrl) + "/v1/messages";

  const body = {
    model: config.model,
    max_tokens: Number(config.maxTokens) || 1024,
    temperature: Number(config.temperature) || 0.3,
    messages: [{ role: "user", content: buildPrompt(text, config) }],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": config.apiVersion || "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let msg = `HTTP ${resp.status}`;
    try {
      const errJson = JSON.parse(errText);
      msg = errJson.error?.message || errJson.message || msg;
    } catch {
      if (errText) msg = errText.slice(0, 300);
    }
    throw new Error(msg);
  }

  const data = await resp.json();
  // Messages API 返回 content 数组
  if (Array.isArray(data.content)) {
    return data.content.map((c) => c.text || "").join("").trim();
  }
  // 兼容 OpenAI 风格返回
  if (data.choices && data.choices[0]) {
    return (data.choices[0].message?.content || "").trim();
  }
  throw new Error(browser.i18n.getMessage("bgUnrecognizedResponse"));
}

/* ---------- 右键菜单 ---------- */
function createContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: "translate-selection",
      title: browser.i18n.getMessage("ctxTranslateSelection"),
      contexts: ["selection"],
    });
    browser.contextMenus.create({
      id: "translate-page",
      title: browser.i18n.getMessage("ctxTranslatePage"),
      contexts: ["page"],
    });
  });
}

browser.runtime.onInstalled.addListener(() => {
  createContextMenus();
  // 初始化默认配置
  browser.storage.local.get("config").then((res) => {
    if (!res.config) {
      browser.storage.local.set({ config: defaultConfig() });
    }
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "translate-selection") {
    browser.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_SELECTION",
      selectionText: info.selectionText || "",
    });
  } else if (info.menuItemId === "translate-page") {
    browser.tabs.sendMessage(tab.id, { type: "TRANSLATE_PAGE" });
  }
});

/* ---------- 消息处理 ---------- */
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TRANSLATE_TEXT") {
    // 单段翻译请求，来自 content script
    getConfig()
      .then((config) => callAnthropic(msg.text, config))
      .then((translation) => {
        sendResponse({ ok: true, translation, requestId: msg.requestId });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message, requestId: msg.requestId });
      });
    return true; // 保持消息通道，等待异步 sendResponse
  }

  if (msg.type === "PING_CONFIG") {
    getConfig().then((config) => {
      sendResponse({
        ok: true,
        configured: Boolean(config.apiKey),
      });
    });
    return true;
  }
});
