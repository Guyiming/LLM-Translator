/* ========================================================================
 * LLM 翻译助手 - Background Service Script
 * 职责：
 *   1. 管理右键菜单
 *   2. 接收 content script 的翻译请求，调用 Anthropic 兼容 API
 *   3. 转发翻译进度/结果回 content script
 * ====================================================================== */

/* ---------- 默认配置 ---------- */
function defaultConfig() {
  return {
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic", // "anthropic" | "openai"
    apiKey: "",
    model: "claude-sonnet-5",
    apiVersion: "2023-06-01",
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

/* ---------- 解析 API 错误响应 ---------- */
async function parseError(resp) {
  const errText = await resp.text();
  let msg = `HTTP ${resp.status}`;
  try {
    const errJson = JSON.parse(errText);
    msg = errJson.error?.message || errJson.message || msg;
  } catch {
    if (errText) msg = errText.slice(0, 300);
  }
  return msg;
}

/* ---------- 调用 LLM API（按协议风格分支） ---------- */
async function callLLM(text, config) {
  const protocol = (config.protocol || "anthropic").toLowerCase();
  const base = normalizeBaseUrl(config.baseUrl);
  const prompt = buildPrompt(text, config);
  const messages = [{ role: "user", content: prompt }];

  let url, headers, body;

  if (protocol === "openai") {
    // OpenAI 风格：/v1/chat/completions + Bearer 认证
    url = base + "/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
    body = {
      model: config.model,
      max_tokens: Number(config.maxTokens) || 1024,
      temperature: Number(config.temperature) || 0.3,
      messages,
    };
  } else {
    // Anthropic 风格：/v1/messages + x-api-key
    url = base + "/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": config.apiVersion || "2023-06-01",
    };
    body = {
      model: config.model,
      max_tokens: Number(config.maxTokens) || 1024,
      temperature: Number(config.temperature) || 0.3,
      messages,
    };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(await parseError(resp));
  }

  const data = await resp.json();
  // 优先按请求协议解析，但两种格式都做兼容回退
  if (protocol === "openai" && data.choices && data.choices[0]) {
    const c = data.choices[0].message?.content || data.choices[0].text || "";
    return (typeof c === "string" ? c : JSON.stringify(c)).trim();
  }
  // Anthropic 风格：content 数组
  if (Array.isArray(data.content)) {
    return data.content.map((c) => c.text || "").join("").trim();
  }
  // 交叉兼容回退
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
      .then((config) => callLLM(msg.text, config))
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
