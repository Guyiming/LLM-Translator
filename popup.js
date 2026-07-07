/* ========================================================================
 * AI 翻译助手 - Popup 逻辑
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
      hint.innerHTML =
        browser.i18n.getMessage("popupNotConfigured") +
        ' <a id="goConfig">' +
        browser.i18n.getMessage("popupGoSettings") +
        "</a>";
      document.getElementById("goConfig").addEventListener("click", openOptions);
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
  try {
    await browser.tabs.sendMessage(tab.id, { type });
    window.close();
    return;
  } catch (e) {
    // content script 可能未注入（如刚加载的页面），尝试用 scripting API 手动注入
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await browser.tabs.sendMessage(tab.id, { type });
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
