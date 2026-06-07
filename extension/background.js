// background.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "HU23_OPEN_CLEAR_SETTINGS") {
    chrome.tabs.create({ url: "chrome://settings/clearBrowserData" })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    const urlGuia = chrome.runtime.getURL("onboarding/guia_inicial.html");
    chrome.tabs.create({ url: urlGuia });

    // Valores por defecto — incluye los 3 tipos nuevos
    chrome.storage.local.set({
      activo: true,
      paginas: { steam: true, roblox: true, epic: true, discord: true },
      tipos: {
        correo: true,
        nombre: true,
        tarjeta: true,
        dni: true,
        edad: true,
        ubicacion: true,
        enlace_sospechoso: true
      }
    });
  }
});