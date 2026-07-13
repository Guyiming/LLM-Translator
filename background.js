/* ========================================================================
 * LLM 翻译助手 - Background Service Script
 * 职责：右键菜单、配置管理、LLM API 调用与请求生命周期管理
 * ====================================================================== */

/* ---------- 默认配置 ---------- */
function defaultConfig() {
  return {
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic",
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

async function getConfig() {
  const stored = await browser.storage.local.get("config");
  return { ...defaultConfig(), ...(stored.config || {}) };
}

function validateConfig(config) {
  if (!config.apiKey || !String(config.apiKey).trim()) {
    throw createError(browser.i18n.getMessage("bgMissingApiKey"), {
      code: "CONFIG",
    });
  }
  if (!config.baseUrl || !String(config.baseUrl).trim()) {
    throw createError(browser.i18n.getMessage("bgMissingBaseUrl"), {
      code: "CONFIG",
    });
  }
  if (!config.model || !String(config.model).trim()) {
    throw createError(browser.i18n.getMessage("bgMissingModel"), {
      code: "CONFIG",
    });
  }
}

/* ---------- URL 与提示词 ---------- */
function buildEndpoint(baseUrl, protocol) {
  const base = String(baseUrl || "https://api.anthropic.com")
    .trim()
    .replace(/\/+$/, "");
  const isOpenAI = String(protocol || "anthropic").toLowerCase() === "openai";
  const endpoint = isOpenAI ? "chat/completions" : "messages";

  // 允许直接填写完整端点。
  if (isOpenAI && /\/chat\/completions$/i.test(base)) return base;
  if (!isOpenAI && /\/messages$/i.test(base)) return base;

  // 路径已经以版本号结尾时直接追加端点，例如 GLM 的 /api/paas/v4。
  if (/\/v\d+(?:\.\d+)?$/i.test(base)) return `${base}/${endpoint}`;
  return `${base}/v1/${endpoint}`;
}

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
  if (!code || code === "auto") return "";
  const key = LANG_CODE_TO_KEY[code];
  return key ? browser.i18n.getMessage(key) || code : code;
}

function replacePlaceholder(template, name, value) {
  // 使用函数作为 replacer，避免网页文本中的 $&、$`、$$ 被特殊解释。
  return template.replace(new RegExp(`\\{\\{${name}\\}\\}`, "g"), () => value);
}

function buildPrompt(text, config) {
  let prompt = String(config.promptTemplate || defaultConfig().promptTemplate);
  prompt = replacePlaceholder(prompt, "sourceLang", langName(config.sourceLang));
  prompt = replacePlaceholder(
    prompt,
    "targetLang",
    langName(config.targetLang) || config.targetLang
  );
  return replacePlaceholder(prompt, "text", text);
}

/* ---------- 请求生命周期、超时与退避 ---------- */
const activeBatches = new Map();

function batchState(batchId) {
  if (!batchId) return null;
  let state = activeBatches.get(batchId);
  if (!state) {
    state = {
      cancelled: false,
      controllers: new Set(),
      waiters: new Set(),
      cleanupTimer: null,
    };
    activeBatches.set(batchId, state);
  }
  return state;
}

function cancelBatch(batchId) {
  if (!batchId) return;
  // 即使请求尚未在后台创建，也保留取消标记，覆盖消息并发产生的竞态。
  const state = batchState(batchId);
  if (!state) return;
  state.cancelled = true;
  for (const controller of state.controllers) controller.abort();
  for (const wake of state.waiters) wake();
  state.waiters.clear();
  clearTimeout(state.cleanupTimer);
  state.cleanupTimer = setTimeout(() => activeBatches.delete(batchId), 60000);
}

function finishBatch(batchId) {
  const state = activeBatches.get(batchId);
  if (!state) return;
  for (const controller of state.controllers) controller.abort();
  for (const wake of state.waiters) wake();
  clearTimeout(state.cleanupTimer);
  activeBatches.delete(batchId);
}

function createError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function cancelledError() {
  return createError(browser.i18n.getMessage("bgCancelled"), {
    code: "CANCELLED",
    retryable: false,
  });
}

function waitForRetry(ms, batchId) {
  const state = batchState(batchId);
  if (state?.cancelled) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      state?.waiters.delete(cancelled);
      if (state?.cancelled) reject(cancelledError());
      else resolve();
    };
    const cancelled = () => done();
    state?.waiters.add(cancelled);
    timer = setTimeout(done, ms);
  });
}

function retryDelay(resp, attempt) {
  const value = resp.headers.get("Retry-After");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(10000, Math.max(0, seconds * 1000));
    const dateDelay = Date.parse(value) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.min(10000, Math.max(0, dateDelay));
  }
  return Math.min(10000, 600 * 2 ** attempt + Math.floor(Math.random() * 250));
}

async function fetchWithRetry(url, options, batchId) {
  const maxRetries = 2;
  const timeoutMs = 45000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const state = batchState(batchId);
    if (state?.cancelled) throw cancelledError();

    const controller = new AbortController();
    let timedOut = false;
    state?.controllers.add(controller);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let resp;
    try {
      resp = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (state?.cancelled) throw cancelledError();
      const wrapped = timedOut
        ? createError(browser.i18n.getMessage("bgRequestTimeout"), {
            code: "TIMEOUT",
            retryable: true,
          })
        : createError(error.message, { code: "NETWORK", retryable: true });
      if (attempt === maxRetries) throw wrapped;
      await waitForRetry(600 * 2 ** attempt, batchId);
      continue;
    } finally {
      clearTimeout(timeout);
      state?.controllers.delete(controller);
    }

    if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
      try {
        await resp.body?.cancel();
      } catch {
        // 某些兼容实现不支持取消响应流，不影响重试。
      }
      await waitForRetry(retryDelay(resp, attempt), batchId);
      continue;
    }
    return resp;
  }

  throw createError(browser.i18n.getMessage("ctUnknownError"));
}

async function parseError(resp) {
  const errText = await resp.text();
  let message = `HTTP ${resp.status}`;
  try {
    const data = JSON.parse(errText);
    message = data.error?.message || data.message || message;
  } catch {
    if (errText) message = errText.slice(0, 300);
  }
  return createError(message, {
    status: resp.status,
    code: resp.status === 401 || resp.status === 403 ? "AUTH" : "API",
    retryable: resp.status === 429 || resp.status >= 500,
  });
}

/* ---------- 调用 LLM API ---------- */
async function callLLM(text, config, { batchId, rawPrompt } = {}) {
  validateConfig(config);
  const protocol = String(config.protocol || "anthropic").toLowerCase();
  const prompt = rawPrompt ?? buildPrompt(text, config);
  const messages = [{ role: "user", content: prompt }];
  const url = buildEndpoint(config.baseUrl, protocol);

  let headers;
  if (protocol === "openai") {
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
  } else {
    headers = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": config.apiVersion || "2023-06-01",
    };
  }

  const maxTokens = Number(config.maxTokens);
  const temperature = Number(config.temperature);
  const body = {
    model: config.model,
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1024,
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    messages,
  };

  const resp = await fetchWithRetry(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    batchId
  );
  if (!resp.ok) throw await parseError(resp);

  const data = await resp.json();
  if (protocol === "openai" && data.choices?.[0]) {
    const content = data.choices[0].message?.content || data.choices[0].text || "";
    return (typeof content === "string" ? content : JSON.stringify(content)).trim();
  }
  if (Array.isArray(data.content)) {
    return data.content.map((item) => item.text || "").join("").trim();
  }
  if (data.choices?.[0]) {
    return (data.choices[0].message?.content || "").trim();
  }
  throw createError(browser.i18n.getMessage("bgUnrecognizedResponse"), {
    code: "RESPONSE",
    retryable: false,
  });
}

function errorResponse(error, requestId) {
  return {
    ok: false,
    error: error.message,
    requestId,
    status: error.status || 0,
    code: error.code || "UNKNOWN",
    retryable: Boolean(error.retryable),
  };
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
  browser.storage.local.get("config").then((res) => {
    if (!res.config) browser.storage.local.set({ config: defaultConfig() });
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

/* ---------- 消息处理：Firefox browser.* 使用 Promise 返回异步结果 ---------- */
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRANSLATE_TEXT") {
    return getConfig()
      .then((config) => callLLM(String(msg.text || ""), config, { batchId: msg.batchId }))
      .then((translation) => ({
        ok: true,
        translation,
        requestId: msg.requestId,
      }))
      .catch((error) => errorResponse(error, msg.requestId));
  }

  if (msg.type === "TEST_CONNECTION") {
    const config = {
      ...defaultConfig(),
      ...(msg.config || {}),
      maxTokens: 64,
      temperature: 0,
    };
    return callLLM("", config, {
      rawPrompt: "Reply with: OK",
    })
      .then((translation) => ({ ok: true, translation }))
      .catch((error) => errorResponse(error));
  }

  if (msg.type === "PING_CONFIG") {
    return getConfig().then((config) => {
      try {
        validateConfig(config);
        return { ok: true, configured: true };
      } catch (error) {
        return { ok: true, configured: false, error: error.message };
      }
    });
  }

  if (msg.type === "CANCEL_TRANSLATION") {
    cancelBatch(msg.batchId);
    return Promise.resolve({ ok: true });
  }

  if (msg.type === "FINISH_TRANSLATION") {
    finishBatch(msg.batchId);
    return Promise.resolve({ ok: true });
  }
});
