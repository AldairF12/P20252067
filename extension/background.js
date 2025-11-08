// background.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "OPEN_CLEAR_SETTINGS") {
    chrome.tabs.create({ url: "chrome://settings/clearBrowserData" })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true; // respuesta async
  }
});
