/* ========================================================================
 * LLM 翻译助手 - Popup 逻辑
 * ====================================================================== */

/* ---------- 应用 i18n 到带 data-i18n 的元素 ---------- */
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const msg = browser.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function getSelectionText(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() || "",
    });
    return results?.[0]?.result || "";
  } catch {
    // content script 仍会再从页面选区读取一次。
    return "";
  }
}

/* ---------- 检查配置状态 ---------- */
async function checkConfig() {
  const dot = document.getElementById("statusDot");
  const hint = document.getElementById("hint");
  try {
    const resp = await browser.runtime.sendMessage({ type: "PING_CONFIG" });
    if (resp && resp.configured) {
      dot.classList.add("ok");
      hint.textContent = browser.i18n.getMessage("popupConfigured");
    } else {
      dot.classList.add("warn");
      hint.textContent = browser.i18n.getMessage("popupNotConfigured") + " ";
      const link = document.createElement("a");
      link.id = "goConfig";
      link.textContent = browser.i18n.getMessage("popupGoSettings");
      link.addEventListener("click", openOptions);
      hint.appendChild(link);
    }
  } catch {
    dot.classList.add("warn");
    hint.textContent = browser.i18n.getMessage("popupNoBackend");
  }
}

/* ---------- 打开设置 ---------- */
function openOptions() {
  browser.runtime.openOptionsPage();
  window.close();
}

/* ---------- 发送翻译指令 ---------- */
async function sendTranslate(type) {
  const tab = await getActiveTab();
  if (!tab) return;
  // Firefox 对内置页面（about:）无法注入
  if (/^(about|moz-extension|chrome|file):/.test(tab.url || "")) {
    alert(browser.i18n.getMessage("popupUnsupportedPage"));
    return;
  }
  const message = { type };
  if (type === "TRANSLATE_SELECTION") {
    message.selectionText = await getSelectionText(tab.id);
  }
  try {
    await browser.tabs.sendMessage(tab.id, message);
    window.close();
    return;
  } catch (e) {
    // content script 可能未注入（如刚加载的页面），尝试用 scripting API 手动注入
  }
  try {
    await browser.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content.css"],
    });
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await browser.tabs.sendMessage(tab.id, message);
    window.close();
  } catch (e2) {
    alert(browser.i18n.getMessage("popupTranslateFailed") + (e2.message || e2));
  }
}

/* ---------- 绑定 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  applyI18n();
  checkConfig();
});
document.getElementById("translatePage").addEventListener("click", () =>
  sendTranslate("TRANSLATE_PAGE")
);
document.getElementById("translateSelection").addEventListener("click", () =>
  sendTranslate("TRANSLATE_SELECTION")
);
document.getElementById("openOptions").addEventListener("click", openOptions);
