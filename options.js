/* ========================================================================
 * LLM 翻译助手 - 选项页逻辑
 * ====================================================================== */

const FIELDS = [
  "baseUrl", "protocol", "apiKey", "model", "apiVersion",
  "targetLang", "sourceLang", "maxTokens", "temperature",
  "concurrency", "promptTemplate",
];

const DEFAULTS = {
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
  promptTemplate: null, // 用 i18n 默认值
};

/* ---------- 应用 i18n ---------- */
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const msg = browser.i18n.getMessage(key);
    if (!msg) return;
    if (el.tagName === "OPTION") {
      el.textContent = msg;
    } else if (el.tagName === "TITLE") {
      document.title = msg;
    } else {
      el.textContent = msg;
    }
  });
}

/* ---------- 加载 ---------- */
async function load() {
  const { config } = await browser.storage.local.get("config");
  const stored = config || {};
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (!el) continue;
    let v = stored[k] != null ? stored[k] : DEFAULTS[k];
    if (k === "promptTemplate" && (v == null || v === "")) {
      v = browser.i18n.getMessage("promptDefault");
    }
    el.value = v;
  }
}

/* ---------- 收集 ---------- */
function collect() {
  const cfg = {};
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (el) cfg[k] = el.value;
  }
  cfg.maxTokens = Number(cfg.maxTokens) || 1024;
  cfg.temperature = Number(cfg.temperature) || 0;
  cfg.concurrency = Number(cfg.concurrency) || 3;
  return cfg;
}

/* ---------- 保存 ---------- */
async function save() {
  const cfg = collect();
  await browser.storage.local.set({ config: cfg });
  showStatus(browser.i18n.getMessage("optSaved"), false);
}

/* ---------- 状态提示 ---------- */
function showStatus(msg, isError) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => el.classList.remove("show"), 2500);
}

/* ---------- 测试连接 ---------- */
async function test() {
  const cfg = collect();
  const resultEl = document.getElementById("testResult");
  const statusEl = document.getElementById("status");

  if (!cfg.apiKey) {
    showStatus(browser.i18n.getMessage("optNeedApiKey"), true);
    return;
  }

  statusEl.textContent = browser.i18n.getMessage("optTesting");
  statusEl.classList.remove("error");
  statusEl.classList.add("show");

  const baseUrl = (cfg.baseUrl || DEFAULTS.baseUrl)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");

  const protocol = (cfg.protocol || "anthropic").toLowerCase();
  let url, headers;
  const body = {
    model: cfg.model,
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with: OK" }],
  };

  if (protocol === "openai") {
    url = baseUrl + "/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    };
  } else {
    url = baseUrl + "/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": cfg.apiVersion || "2023-06-01",
    };
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      const msg = data.error?.message || data.message || `HTTP ${resp.status}`;
      throw new Error(msg);
    }

    let reply = "";
    if (Array.isArray(data.content)) {
      reply = data.content.map((c) => c.text || "").join("");
    } else if (data.choices && data.choices[0]) {
      reply = data.choices[0].message?.content || data.choices[0].text || "";
    }

    resultEl.textContent =
      browser.i18n.getMessage("optTestReplyPrefix") + String(reply).slice(0, 80);
    resultEl.style.color = "#27ae60";
    statusEl.textContent = browser.i18n.getMessage("optTestOk");
    statusEl.classList.remove("error");
  } catch (e) {
    resultEl.textContent =
      browser.i18n.getMessage("optTestFailPrefix") + e.message;
    resultEl.style.color = "#c0392b";
    statusEl.textContent = browser.i18n.getMessage("optTestFail");
    statusEl.classList.add("error");
  } finally {
    resultEl.classList.add("show");
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => statusEl.classList.remove("show"), 3500);
  }
}

/* ---------- 绑定 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  applyI18n();
  load();
});
document.getElementById("save").addEventListener("click", save);
document.getElementById("save2").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
