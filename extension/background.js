// background.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "HU23_OPEN_CLEAR_SETTINGS") {
    chrome.tabs.create({ url: "chrome://settings/clearBrowserData" })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true; // respuesta async
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("onboarding/guia_inicial.html")
  });
});

chrome.runtime.onInstalled.addListener((details) => {

  // Comprueba si el motivo es la 'instalación'
  if (details.reason === "install") {

    // Ruta a tu guía, según tu estructura
    const urlGuia = chrome.runtime.getURL("onboarding/guia_inicial.html");

    // Creamos una nueva pestaña con esa URL
    chrome.tabs.create({ url: urlGuia });

    // Opcional: Inicializar valores en el storage
    // Es una buena práctica hacerlo aquí
    chrome.storage.local.set({
      activo: true,
      paginas: { steam: true, roblox: true, epic: true, discord: true },
      tipos: { correo: true, nombre: true, tarjeta: true, dni: true }
    });
  }
});

