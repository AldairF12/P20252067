/* === content/content.js: Listeners, Eventos y Lógica Principal === */

// =================== Evento principal (con debounce) ===================
let ignorarEventosProgramaticos = false;

// Listener para inputs y textareas estándar
const inputDebounceMap = new WeakMap();

document.addEventListener("input", (event) => {
  if (ignorarEventosProgramaticos) return;
  const target = event.target;
  
  // No procesar passwords ni interferir en sus eventos
  if (target && target.tagName === "INPUT" && target.type === "password") return;

  const existingTimer = inputDebounceMap.get(target);
  if (existingTimer) clearTimeout(existingTimer);
  
  const timerId = setTimeout(() => {
    onUserInput(target);
  }, 500);
  inputDebounceMap.set(target, timerId);
});

// Listener adicional para contenteditable (ej. chat de Discord con Slate.js).
// Usamos 'keyup' en modo capture porque Slate.js puede consumir el evento 'input'
// antes de que llegue al document, o dispararlo en nodos internos.
document.addEventListener("keyup", (event) => {
  if (ignorarEventosProgramaticos) return;
  const target = event.target;
  // Solo actuar sobre elementos dentro de un contenteditable
  if (!target?.isContentEditable) return;
  // Ignorar teclas de navegación/modificadores que no cambian texto
  const ignore = ["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown", "Escape", "F1",
    "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
  if (ignore.includes(event.key)) return;

  const existingTimer = inputDebounceMap.get(target);
  if (existingTimer) clearTimeout(existingTimer);
  
  const timerId = setTimeout(() => {
    onUserInput(target);
  }, 500);
  inputDebounceMap.set(target, timerId);
}, true); // capture = true para llegar antes que Slate.js

document.addEventListener("change", (event) => {
  if (ignorarEventosProgramaticos) return;
  const target = event.target;
  
  if (target && target.tagName === "INPUT" && target.type === "password") return;

  // Especialmente útil para autocompletado del navegador (:-webkit-autofill)
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
    const existingTimer = inputDebounceMap.get(target);
    if (existingTimer) clearTimeout(existingTimer);
    
    const timerId = setTimeout(() => {
      onUserInput(target);
    }, 100);
    inputDebounceMap.set(target, timerId);
  }
}, true);

// HU07: detectar nombres de archivo sensibles al seleccionar un archivo
document.addEventListener("change", (event) => {
  // Usamos capture para agarrar cambios en inputs dentro de modales/iframes embebidos
  onFileSelected(event);
}, true);


document.addEventListener("copy", async (event) => {
  try {
    if (!state.activo || !paginaHabilitada()) return;

    // evita password fields
    const activeEl = document.activeElement;
    const isPwd = activeEl && activeEl.tagName === "INPUT" && activeEl.type === "password";
    if (isPwd) return;

    // cooldown
    const now = Date.now();
    if (now - lastCopyNoticeAt < COPY_COOLDOWN_MS) return;
    lastCopyNoticeAt = now;

    // obtener texto copiado
    let texto = "";
    if (event.clipboardData) {
      // lo que va a ir al portapapeles (si la página lo setea)
      texto = event.clipboardData.getData("text/plain") || "";
    }
    if (!texto) {
      // fallback: selección visible
      texto = (window.getSelection()?.toString() || "").trim();
    }

    // Ignorar datos que ya están enmascarados
    texto = limpiarDatosEnmascarados(texto);
    if (!texto || texto.length < 5) return; // ignora cosas muy cortas

    // mantener la misma noción de sesión/target (no forzamos nueva sesión)
    // pero podrías hacer nuevaSesion(activeEl) si deseas separar flujos.

    // pedir al modelo ONNX interno (sin backend)
    const data = await analizarTextoML(texto);
    
    // Pasamos por aplicarReglaCorreoTarjeta para validación final de Regex
    const resultCorregido = aplicarReglaCorreoTarjeta(texto, data || { expone: false, tipo: null });

    const expone = !!resultCorregido.expone;
    let tipo = resultCorregido.tipo || "";

    // cierres inmediatos si no aplica
    if (!expone || !tipo || tipo === "ninguno") {
      limpiarAviso({ respectHover: false });
      return;
    }
    if (!state.tipos?.[tipo]) {
      limpiarAviso({ respectHover: false });
      return;
    }
    if (silenciadoPorOmitir(tipo, activeEl)) {
      limpiarAviso({ respectHover: false });
      return;
    }

    if (ultimoTipoDetectado && ultimoTipoDetectado !== tipo) {
      // Si cambia el tipo, se limpian las omisiones anteriores
    }

    ultimosMatches = detectarMatches(texto, tipo);
    const { vulnerabilidad, recomendacion } = mensajesPorTipo(tipo);
    ultimoTipoDetectado = tipo;
    const titulo = `⚠ ${tipo.toUpperCase()} detectado (copiado)`;

    mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo });

  } catch (e) {
    console.warn("copy-listener error:", e);
  }
});

// --- HU08: Escáner de formularios/sections con múltiples datos sensibles ---
let scanFormsDebounceId = null;
let hu08MostradoEnPagina = false;

function scheduleScanForms() {
  clearTimeout(scanFormsDebounceId);
  scanFormsDebounceId = setTimeout(scanFormsForSensitive, 500);
}

function elementosTipoCampoEn(container) {
  // Inputs clásicos
  const basics = Array.from(container.querySelectorAll("input, textarea, select"));

  // Pseudo-inputs: botones/combobox, inputs de Steam, contenteditable
  const pseudo = Array.from(container.querySelectorAll(
    `[role="combobox"], button[role="combobox"], [contenteditable="true"]`
  ));

  // Campos “visualizados” de Roblox (sin input editable hasta pulsar el “editar”)
  const robloxBlocks = Array.from(container.querySelectorAll(".account-settings-text-field, .settings-text-lines-container"));

  // Devuelve mezcla única
  const set = new Set([...basics, ...pseudo, ...robloxBlocks]);
  return Array.from(set);
}

function contarCategoriasSensiblesEn(container) {
  const tiposDetectados = new Set();

  // Recorre cada “campo” real o virtual
  for (const el of elementosTipoCampoEn(container)) {
    // Evitar passwords reales
    if (el.tagName === "INPUT" && el.type && el.type.toLowerCase() === "password") continue;

    const t = textoCampoPlus(el);
    const cat = clasificarCategoriaPorTexto(t);
    if (cat) tiposDetectados.add(cat);
  }

  // Fallback: también escanea headers/labels de la sección
  // Evitamos leer el texto de los inputs del usuario
  let textoSeccion = "";
  try {
    const clone = container.cloneNode(true);
    const inputs = clone.querySelectorAll("input, textarea, [contenteditable='true']");
    for (const n of inputs) n.remove();
    textoSeccion = clone.innerHTML.replace(/<[^>]*>/g, " ").slice(0, 2000); // recorta por rendimiento
  } catch (e) {
    textoSeccion = container.innerHTML.replace(/<[^>]*>/g, " ").slice(0, 2000);
  }

  for (const [cat, re] of Object.entries(KW)) {
    if (re.test(textoSeccion)) tiposDetectados.add(cat);
  }

  // Cuenta solo categorías sensibles (umbral)
  const sensiblesCount = Array.from(tiposDetectados).filter(c => CATEGORIAS_SENSIBLES.includes(c)).length;
  return { sensiblesCount, tiposDetectados };
}

function scanFormsForSensitive() {
  if (!state.activo || !paginaHabilitada()) return;

  // NUEVO: Escanear campos autocompletados al cargar la página (HU19)
  const autofilledInputs = document.querySelectorAll("input:-webkit-autofill, input:autofill, input[data-kwimpalastatus]");
  for (const input of autofilledInputs) {
    if (input.type === "password") continue;
    if (input.dataset.autofillScanned) continue;
    input.dataset.autofillScanned = "true";
    onUserInput(input);
  }

  // Considera <form>, secciones de Steam, y secciones de Roblox
  const candidates = new Set([
    ...document.querySelectorAll("form"),
    ...document.querySelectorAll(".DialogInputLabelGroup, ._DialogLayout, .uwqwoAlIVWyJ8l71i77-i, ._3s6BBoF1hXm0yeOzoVsAQj"),
    ...document.querySelectorAll(".setting-section, #settings-container, #rbx-account-info-header")
  ]);

  for (const container of candidates) {
    try {
      const last = formLastShown.get(container) || 0;
      if (Date.now() - last < FORM_COOLDOWN_MS) continue;

      const { sensiblesCount, tiposDetectados } = contarCategoriasSensiblesEn(container);
      if (sensiblesCount >= 2) {
        if (hu08MostradoEnPagina) return;
        if (avisoActivo && avisoPendiente?.tipo !== "multiple_campos") return;

        // Respeta omisión temporal por tipo “multiple_campos”
        if (silenciadoPorOmitir("multiple_campos", container)) continue;

        const lista = Array.from(tiposDetectados).join(", ");
        const vulnerabilidad = `Este formulario solicita *múltiples datos sensibles* como ${lista}.`;
        const recomendacion = "Revisa la política del sitio y comparte solo lo necesario. Evita pegar datos en chats públicos.";

        const titulo = "⚠ Formulario solicita múltiples datos sensibles";
        ultimoTipoDetectado = "multiple_campos";
        ultimosMatches = [];

        mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo: "multiple_campos" });
        formLastShown.set(container, Date.now());
        hu08MostradoEnPagina = true;
      }
    } catch { /* noop */ }
  }
}

// Observer para páginas dinámicas (): Roblox/Steam/Discord
const mo = new MutationObserver(() => scheduleScanForms());
mo.observe(document.documentElement, { childList: true, subtree: true });

// Triggers extra por SPA: hashchange y navegación por botones
window.addEventListener("hashchange", scheduleScanForms, true);
window.addEventListener("click", (e) => {
  // al abrir editores “Cambiar/Editar”, reescanea
  const t = e.target;
  if (!t) return;
  const txt = (t.textContent || "").toLowerCase();
  if (txt.includes("editar") || txt.includes("cambiar") || txt.includes("actualizar") || txt.includes("save") || txt.includes("guardar")) {
    scheduleScanForms();
  }
}, true);

// Primer escaneo
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scheduleScanForms);
} else {
  scheduleScanForms();
}


// =================== Manejo de input con control de relevancia ===================

function onUserInput(target) {
  if (!state.activo || !paginaHabilitada()) return;

  // Soporte para contenteditable (ej. chat de Discord)
  const esContentEditable = !!target?.isContentEditable;
  if (!target || (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA" && !esContentEditable)) return;

  // Ignorar inputs de tipo password
  if (target.tagName === "INPUT" && target.type === "password") return;

  let texto;
  if (esContentEditable) {
    // Subir hasta el nodo contenteditable raíz para leer el texto completo.
    // Slate.js (Discord) puede disparar el evento en un <span> interno;
    // si usamos solo ese nodo obtendríamos texto parcial.
    let root = target;
    while (root && root !== document.body) {
      if (root.getAttribute?.("contenteditable") === "true") break;
      root = root.parentElement;
    }
    texto = (root?.textContent || "").trim();
  } else {
    texto = (target.value || "").trim();
  }

  // ID de solicitud para invalidar resultados viejos
  const solicitudId = ++ultimaSolicitudId;

  if (texto.length < 5) {
    if (ultimoTarget !== target) nuevaSesion(target);
    if (!avisoPendiente?.isFile) limpiarAviso({ respectHover: false });
    return;
  }

  if (ultimoTarget !== target) {
    nuevaSesion(target);
  }

  const isAutofill = target.matches?.(":-webkit-autofill") || target.matches?.(":autofill") || target.hasAttribute?.("data-kwimpalastatus") || false;
  ejecutarAnalisisTexto(texto, target, solicitudId, isAutofill);
}

async function ejecutarAnalisisTexto(textoOriginal, target, solicitudId, isAutofill = false) {
  try {
    if (solicitudId !== ultimaSolicitudId) return;

    // Limpiamos los datos que ya están enmascarados para no volver a detectarlos
    const texto = limpiarDatosEnmascarados(textoOriginal);
    if (!texto.trim() || texto.length < 5) return;

    // ── Fase 1: regex — detecta TODOS los tipos explícitos presentes ───────────────
    // Correo, DNI, Celular, tarjeta tienen patrones únicos verificables con regex.
    // Si se detectan varios, se encolan y se muestran uno a uno.
    const tiposEncontrados = detectarTiposDato(texto);
    const itemsCola = tiposEncontrados
      .filter(t => state.tipos?.[t] && !silenciadoPorOmitir(t, target))
      .map(t => ({
        tipo: t,
        isAutofill: isAutofill,
        matches: detectarMatches(texto, t),
        ...mensajesPorTipo(t)
      }));

    if (itemsCola.length > 0) {
      colaDetecciones = itemsCola;
      colaTarget = target;
      colaTexto = texto;
      procesarSiguienteDeLaCola();
      return; // no hace falta correr el modelo
    }

    // ── Fase 0.5: contexto del campo (ajustes/perfil) ─────────────────────────────
    const textoContexto = textoCampoPlus(target);
    const tipoContexto = clasificarCategoriaPorTexto(textoContexto);
    if (tipoContexto && state.tipos?.[tipoContexto] && !silenciadoPorOmitir(tipoContexto, target)) {
      ultimosMatches = [];
      ultimoTipoDetectado = tipoContexto;
      colaDetecciones = [];
      const sitio = location.hostname.replace(/^www\./, "");
      const { vulnerabilidad: vc, recomendacion: rc } = mensajesPorContextoCampo(tipoContexto, sitio);
      mostrarAviso(`⚠ Campo sensible: ${tipoContexto.toUpperCase()}${isAutofill ? ' (autocompletado)' : ''}`, vc, rc, { tipo: tipoContexto });
      return;
    }

    // ── Fase 2: modelo ONNX (nombre + casos que el regex no cubre) ──────────────
    // Evitamos ejecutar el modelo en páginas de configuración/perfil donde se asume
    // que el usuario completará sus datos personales explícitamente.
    const urlStr = location.href.toLowerCase();
    if (
      urlStr.includes("accounts.epicgames.com/account/personal") ||
      urlStr.includes("roblox.com/my/account") ||
      (urlStr.includes("steamcommunity.com/id/") && urlStr.includes("/edit"))
    ) {
      return;
    }

    await new Promise(r => setTimeout(r, 0)); // ceder hilo antes de inferencia
    if (solicitudId !== ultimaSolicitudId) return;

    const start = performance.now();
    const data = await analizarTextoML(texto);
    console.log(`[ML] Tiempo de inferencia: ${performance.now() - start} ms`);

    if (solicitudId !== ultimaSolicitudId) return;

    // Pasamos el resultado del modelo por la regla correctora de Regex
    const resultCorregido = aplicarReglaCorreoTarjeta(texto, data || { expone: false, tipo: null });
    
    const expone = !!resultCorregido.expone;
    let tipo = resultCorregido.tipo || "";
    
    console.log("[ONNX + Regex Corrector]", resultCorregido, "| expone:", expone, "| tipo:", tipo);

    if (!expone || !tipo || tipo === "ninguno" || !state.tipos?.[tipo]
      || silenciadoPorOmitir(tipo, target)) {
      if (!avisoPendiente?.isFile) limpiarAviso({ respectHover: false });
      return;
    }

    colaDetecciones = []; // un solo resultado del modelo, sin cola
    ultimosMatches = detectarMatches(texto, tipo);
    ultimoTipoDetectado = tipo;
    const { vulnerabilidad, recomendacion } = mensajesPorTipo(tipo);
    mostrarAviso(`⚠ ${tipo.toUpperCase()} detectado${isAutofill ? ' (autocompletado)' : ''}`, vulnerabilidad, recomendacion, { tipo });

  } catch (err) {
    // ── Fallback: WASM no disponible (CSP restrictiva en Roblox, Discord, etc.) ──
    console.warn("[ML] ONNX no disponible, usando heurística local:", err.message);
    if (solicitudId !== ultimaSolicitudId) return;
    const itemsFallback = detectarTiposDato(texto)
      .filter(t => state.tipos?.[t] && !silenciadoPorOmitir(t, target))
      .map(t => ({ tipo: t, matches: detectarMatches(texto, t), ...mensajesPorTipo(t) }));
    if (itemsFallback.length > 0) {
      colaDetecciones = itemsFallback;
      colaTarget = target;
      colaTexto = texto;
      procesarSiguienteDeLaCola();
    }
  }
}

// === HU07: alerta por nombres de archivo sensibles ===
async function onFileSelected(event) {
  const input = event.target;

  console.log("[HU07] change disparado en:", input);

  if (!state.activo || !paginaHabilitada()) {
    console.log("[HU07] Extensión inactiva o página no habilitada");
    return;
  }

  if (!input || input.tagName !== "INPUT" || input.type !== "file") {
    return;
  }

  // Función que hace TODO el análisis dado un archivo
  const procesarArchivo = async (file) => {
    if (!file || !file.name) {
      console.log("[HU07] procesarArchivo: archivo inválido");
      return;
    }

    const rawName = file.name;
    console.log("[HU07] Nombre de archivo seleccionado:", rawName);

    // Normalizar nombre: quitar acentos, guiones, underscores, pasar a minúsculas
    let normalizado = rawName
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // sin acentos
      .replace(/[_\-\.]+/g, " ")                        // _ - . -> espacio
      .toLowerCase()
      .trim();

    console.log("[HU07] Nombre normalizado:", normalizado);

    if (!normalizado || normalizado.length < 3) {
      return;
    }

    // --- Heurística rápida por palabras clave (dni, pasaporte, passport, carnet, etc.) ---
    const patronSensibles = /(dni|documento\s*de\s*identidad|id\b|pasaporte|passport|carnet|extranj(er[ia]|eria)|licencia|license)/i;

    let expone = false;
    let tipoHeuristico = null;

    if (patronSensibles.test(normalizado)) {
      expone = true;
      if (normalizado.includes("dni")) tipoHeuristico = "dni";
      else if (normalizado.includes("pasaporte") || normalizado.includes("passport")) tipoHeuristico = "dni";
      else tipoHeuristico = "nombre"; // fallback genérico
    }

    // Intentar también con el modelo (no es muy pesado, se ejecuta solo 1 vez por selección)
    try {
      const resultadoML = await analizarTextoML(normalizado);
      console.log("[HU07] Resultado modelo para nombre archivo:", resultadoML);

      if (resultadoML?.expone && resultadoML?.tipo && state.tipos?.[resultadoML.tipo]) {
        expone = true;
        tipoHeuristico = resultadoML.tipo;
      }
    } catch (err) {
      console.error("[HU07] Error llamando al modelo para nombre de archivo:", err);
    }

    if (!expone || !tipoHeuristico || tipoHeuristico === "ninguno") {
      console.log("[HU07] Nombre de archivo no considerado sensible");
      return;
    }

    // Asociamos la sesión al input file para que el aviso sepa "dónde" ocurrió
    if (ultimoTarget !== input) {
      nuevaSesion(input);
    }

    ultimoTipoDetectado = tipoHeuristico;
    ultimosMatches = [rawName];

    const titulo = "⚠ Nombre de archivo posiblemente sensible";
    const vulnerabilidad = `El archivo <b>"${escapeHTML(rawName)}"</b> parece incluir <b>${escapeHTML(tipoHeuristico)}</b> u otro dato personal en su nombre.`;
    const recomendacion = "Antes de subirlo, revisa que no contenga datos como DNI, pasaporte, correos o tarjetas.";

    console.log("[HU07] Mostrando aviso por nombre de archivo sensible");

    mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo: tipoHeuristico, isFile: true });
  };

  // 1) Intento inmediato
  let file = input.files && input.files[0];
  if (file && file.name) {
    console.log("[HU07] Archivo detectado al primer intento");
    await procesarArchivo(file);
    return;
  }

  // 2) Si no hay archivo aún, reintentamos unas cuantas veces (Steam puede tocar el input raro)
  console.log("[HU07] No hay archivo seleccionado en el momento del change, reintentando...");

  let intentos = 5;
  const delayMs = 150;

  const reintentar = () => {
    const f = input.files && input.files[0];
    if (f && f.name) {
      console.log("[HU07] Archivo detectado en reintento:", f.name);
      procesarArchivo(f);
      return;
    }

    intentos--;
    if (intentos > 0) {
      setTimeout(reintentar, delayMs);
    } else {
      console.log("[HU07] No se detectó archivo tras reintentos");
    }
  };

  reintentar();
}

// ================= HU07 - Fallback para Steam: botón "Sube tu avatar" =================

let steamAvatarWarningShown = false;

function setupSteamAvatarWarning() {
  // Solo aplica en Steam Community
  if (!location.hostname.includes("steamcommunity.com")) return;

  function hookButtons() {
    const buttons = document.querySelectorAll("button.DialogButton");

    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      // Buscamos específicamente el botón "Sube tu avatar"
      if (!/sube tu avatar/i.test(text)) continue;

      // Evitar enganchar el mismo botón más de una vez
      if (btn._hu07SteamHooked) continue;
      btn._hu07SteamHooked = true;

      btn.addEventListener("click", () => {
        if (!state.activo || !paginaHabilitada()) return;

        // Si ya mostramos la advertencia una vez en esta sesión, no spamear
        if (steamAvatarWarningShown) return;
        steamAvatarWarningShown = true;

        // Asociamos la "sesión" al propio botón, para que el aviso se ancle al contexto
        try {
          if (typeof nuevaSesion === "function") {
            nuevaSesion(btn);
          }
        } catch (e) {
          console.warn("[HU07 Steam] Error llamando a nuevaSesion:", e);
        }

        const titulo = "Revisa el nombre del archivo antes de subirlo";
        const vulnerabilidad =
          'Evita nombres de archivos que incluyan datos personales como ' +
          '<b>DNI</b>, <b>pasaporte</b>, <b>correo</b> o <b>teléfono</b> ' +
          '(por ejemplo: <code>dni_45874568.png</code>).';
        const recomendacion =
          "Si tu avatar tiene un nombre sensible, renómbralo antes de subirlo para proteger tu información.";

        try {
          mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo: "ninguno", isFile: true });
        } catch (e) {
          console.error("[HU07 Steam] Error mostrando aviso:", e);
        }
      });
    }
  }

  // Intento inicial
  hookButtons();

  // Steam suele re-renderizar el DOM, así que usamos MutationObserver
  const mo = new MutationObserver(() => {
    hookButtons();
  });

  mo.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

// Llamar esto en la inicialización del content script
setupSteamAvatarWarning();




// =================== HU23: Recordatorio al cerrar sesión ===================

// Reutiliza el background de HU23 para abrir settings
// background.js escucha { type: "HU23_OPEN_CLEAR_SETTINGS" }

const HU23_PENDING_KEY = "HU23_PENDING_BANNER";

// Sitios soportados (host y pistas de logout por href/texto)
const HU23_SITES = [
  {
    key: "steam",
    hosts: ["steampowered.com", "steamcommunity.com"],
    hrefHints: ["/logout"], // ej: https://store.steampowered.com/logout/
    textHints: ["cerrar sesión", "cerrar sesion", "logout", "log out", "sign out", "logoff"]
  },
  {
    key: "roblox",
    hosts: ["roblox.com"],
    hrefHints: ["/logout", "/auth/logout"],
    textHints: ["cerrar sesión", "cerrar sesion", "logout", "log out", "sign out"]
  },
  {
    key: "epic",
    hosts: ["epicgames.com"],
    hrefHints: ["/logout", "/log-out", "/signout"],
    textHints: ["cerrar sesión", "cerrar sesion", "logout", "log out", "sign out"]
  },
  {
    key: "discord",
    hosts: ["discord.com"],
    hrefHints: ["/logout"], // a veces no navega; nos apoyamos también en texto
    textHints: ["cerrar sesión", "cerrar sesion", "logout", "log out", "sign out"]
  }
];

function hu23_siteMatch() {
  const h = location.hostname;
  for (const s of HU23_SITES) {
    if (s.hosts.some(dom => h.endsWith(dom))) return s;
  }
  return null;
}

async function hu23_sessionGet(keys) {
  try { if (chrome.storage?.session) return await chrome.storage.session.get(keys); } catch { }
  return await chrome.storage.local.get(keys);
}
async function hu23_sessionSet(obj) {
  try { if (chrome.storage?.session) return await chrome.storage.session.set(obj); } catch { }
  return await chrome.storage.local.set(obj);
}
async function hu23_sessionRemove(keys) {
  try { if (chrome.storage?.session) return await chrome.storage.session.remove(keys); } catch { }
  return await chrome.storage.local.remove(keys);
}

// Marca “pendiente de mostrar” por si hay navegación inmediata
async function hu23_markPending() {
  const payload = { ts: Date.now(), host: location.hostname };
  await hu23_sessionSet({ [HU23_PENDING_KEY]: payload });
}

// Si hay pendiente (máx 30s), re-muestra el banner al cargar la nueva página
async function hu23_checkPendingAndShow() {
  const store = await hu23_sessionGet(HU23_PENDING_KEY);
  const pending = store?.[HU23_PENDING_KEY];
  if (!pending) return;
  if (Date.now() - (pending.ts || 0) > 30000) {
    await hu23_sessionRemove(HU23_PENDING_KEY);
    return;
  }
  hu23_showBanner();
}

function hu23_removeBanner() {
  limpiarAviso({ respectHover: false });
}

function hu23_showBanner() {
  const host = location.hostname;
  mostrarAviso(
    `⚠ Limpia autocompletado y cookies`,
    `Has cerrado sesión en **${host}**. Te recomendamos limpiar datos del sitio para proteger tu privacidad.
<ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13px; opacity: 0.9;">
  <li>1. Abrir configuración de Chrome.</li>
  <li>2. Ir a Privacidad y seguridad.</li>
  <li>3. Borrar cookies, datos temporales y autocompletado si corresponde.</li>
</ul>`,
    "Usa el botón para ir a la configuración de privacidad de tu navegador.",
    { 
      tipo: "logout", 
      hideButtons: false,
      btnAceptarText: "Limpiar ahora",
      btnOmitirText: "Cerrar"
    } 
  );
}

// Heurística de logout SOLO por click (href/texto), limitada a los 4 sitios
function hu23_isLogoutClick(target, siteCfg) {
  if (!target || !siteCfg) return false;

  // A) link con href que contiene hint
  const a = target.closest?.("a[href]") || (target.tagName === "A" ? target : null);
  if (a?.href) {
    const hrefLow = a.href.toLowerCase();
    if (siteCfg.hrefHints.some(p => hrefLow.includes(p))) return true;
  }

  // B) texto visible del ELEMENTO INTERACTIVO más cercano (botón o link),
  // NO del elemento clicado directamente (que podría ser un contenedor grande).
  // Limitamos el texto a 80 caracteres para evitar falsos positivos en secciones
  // que contienen "cerrar sesión" en alguno de sus hijos.
  const interactivo = target.closest?.("button, a, [role='button'], [role='menuitem']") || target;
  const txt = (interactivo.innerText || interactivo.textContent || "").trim().toLowerCase();
  if (txt && txt.length <= 80 && siteCfg.textHints.some(t => txt.includes(t))) return true;

  return false;
}

// Bind principal: SOLO por click y SOLO para los 4 sitios
const hu23Site = hu23_siteMatch();
if (hu23Site) {
  // Mostrar si venimos de un logout que navegó
  hu23_checkPendingAndShow().catch(() => { });

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (hu23_isLogoutClick(t, hu23Site)) {
      // Mostrar inmediatamente…
      hu23_showBanner();
      // …y marcar pendiente por si la página navega y perdemos el banner
      hu23_markPending().catch(() => { });
    }
  }, { capture: true });
}


// =================== HU24: Nota al usar "Continuar con <proveedor>" ===================

// Reutiliza el background de HU23 para abrir settings
// background.js escucha { type: "HU23_OPEN_CLEAR_SETTINGS" }

const HU24_PENDING_KEY = "HU24_PENDING_NOTE";

// Pistas por texto visible (multilenguaje) y atributos comunes
const HU24_TEXT_HINTS = [
  // Español
  "continuar con google", "iniciar sesión con google", "inicia sesión con google",
  "continuar con facebook", "iniciar sesión con facebook",
  "continuar con apple", "iniciar sesión con apple",
  "continuar con microsoft", "iniciar sesión con microsoft",
  "continuar con steam", "iniciar sesión con steam",
  "continuar con discord", "iniciar sesión con discord",
  "continuar con github", "iniciar sesión con github",
  "continuar con twitter", "iniciar sesión con twitter", "continuar con x", "iniciar sesión con x",
  "continuar con twitch", "iniciar sesión con twitch",
  "continuar con epic", "iniciar sesión con epic", "continuar con epic games", "iniciar sesión con epic games",
  "continuar con amazon", "iniciar sesión con amazon",
  "continuar con linkedin", "iniciar sesión con linkedin",
  // Inglés
  "continue with google", "sign in with google", "log in with google",
  "continue with facebook", "sign in with facebook", "log in with facebook",
  "continue with apple", "sign in with apple",
  "continue with microsoft", "sign in with microsoft",
  "continue with steam", "sign in with steam",
  "continue with discord", "sign in with discord",
  "continue with github", "sign in with github",
  "continue with twitter", "sign in with twitter", "continue with x", "sign in with x",
  "continue with twitch", "sign in with twitch",
  "continue with epic", "sign in with epic", "continue with epic games", "sign in with epic games",
  "continue with amazon", "sign in with amazon",
  "continue with linkedin", "sign in with linkedin"
];

// Pistas por destino (href hacia endpoints OAuth/OpenID conocidos)
const HU24_HREF_HINTS = [
  "accounts.google.com/o/oauth2", "accounts.google.com/gsi",
  "facebook.com/v", "/dialog/oauth",
  "appleid.apple.com/auth", "appleid.cdn-apple.com",
  "login.live.com", "microsoftonline.com",
  "steamcommunity.com/openid", "steamcommunity.com/oauth",
  "discord.com/api/oauth2",
  "github.com/login/oauth",
  "api.twitter.com/oauth", "x.com/i/oauth", "twitter.com/i/oauth",
  "id.twitch.tv/oauth2",
  "auth.epicgames.com",
  "amazon.com/ap/signin", "signin.aws.amazon.com",
  "linkedin.com/oauth"
];

// Proveedores por palabra clave (para pintar cabecera más clara)
const HU24_PROVIDER_ALIASES = [
  ["google", "google"], ["facebook", "facebook"], ["apple", "apple"],
  ["microsoft", "microsoft"], ["steam", "steam"], ["discord", "discord"],
  ["github", "github"], ["twitter", "twitter"], ["x ", "x"],
  ["twitch", "twitch"], ["epic", "epic"], ["epic games", "epic games"],
  ["amazon", "amazon"], ["linkedin", "linkedin"],
  ["playstation", "playstation"], ["psn", "playstation"],
  ["xbox", "xbox"], ["xbl", "xbox"],
  ["nintendo", "nintendo"], ["disney", "disney"]
];

async function hu24_sessionGet(keys) {
  try { if (chrome.storage?.session) return await chrome.storage.session.get(keys); } catch { }
  return await chrome.storage.local.get(keys);
}
async function hu24_sessionSet(obj) {
  try { if (chrome.storage?.session) return await chrome.storage.session.set(obj); } catch { }
  return await chrome.storage.local.set(obj);
}
async function hu24_sessionRemove(keys) {
  try { if (chrome.storage?.session) return await chrome.storage.session.remove(keys); } catch { }
  return await chrome.storage.local.remove(keys);
}

// Marca pendiente (por si la web navega inmediatamente después del clic)
async function hu24_markPending(providerGuess) {
  const payload = { ts: Date.now(), host: location.hostname, provider: providerGuess || null };
  await hu24_sessionSet({ [HU24_PENDING_KEY]: payload });
}

// Si hay pendiente (<=30s), vuelve a mostrar la nota
async function hu24_checkPendingAndShow() {
  const store = await hu24_sessionGet(HU24_PENDING_KEY);
  const pending = store?.[HU24_PENDING_KEY];
  if (!pending) return;
  if (Date.now() - (pending.ts || 0) > 30000) {
    await hu24_sessionRemove(HU24_PENDING_KEY);
    return;
  }
  hu24_showNote(pending.provider);
  await hu24_sessionRemove(HU24_PENDING_KEY);
}

function hu24_removeNote() {
  limpiarAviso({ respectHover: false });
}

function hu24_guessProviderFromText(text) {
  const low = (text || "").toLowerCase();
  for (const [needle, label] of HU24_PROVIDER_ALIASES) {
    if (low.includes(needle)) return label;
  }
  return null;
}

function hu24_showNote(providerGuess = null) {
  const prov = providerGuess ? providerGuess[0].toUpperCase() + providerGuess.slice(1) : "un proveedor";
  const host = location.hostname;
  
  mostrarAviso(
    `⚠ Iniciar sesión con ${prov}`,
    `Al continuar con **${prov}** en **${host}**, podrías compartir datos como tu perfil, correo y foto.`,
    "Revisa los permisos solicitados y asegúrate de confiar en el sitio antes de autorizar.",
    { tipo: "social_login", hideButtons: true }
  );
}

// ¿El clic parece un botón de “Continuar con …”?
function hu24_isSocialLoginClick(target) {
  if (!target) return { match: false, provider: null };

  const interactivo = target.closest?.("button, a, [role='button'], [role='menuitem'], .MuiButtonBase-root") || target;
  if (!interactivo.matches?.("button, a, [role='button'], [role='menuitem'], .MuiButtonBase-root")) {
    return { match: false, provider: null };
  }

  // 1) Href hacia OAuth/OpenID
  const a = interactivo.tagName === "A" ? interactivo : interactivo.closest?.("a[href]");
  if (a?.href) {
    const hrefLow = a.href.toLowerCase();
    if (HU24_HREF_HINTS.some(h => hrefLow.includes(h))) {
      return { match: true, provider: hu24_guessProviderFromText(hrefLow) };
    }
  }

  // 2) Texto visible del propio target
  const text = (interactivo.innerText || interactivo.textContent || "").trim().toLowerCase().slice(0, 100);
  if (text && HU24_TEXT_HINTS.some(t => text.includes(t))) {
    return { match: true, provider: hu24_guessProviderFromText(text) };
  }
  if (text && text.length <= 35) {
    const prov = hu24_guessProviderFromText(text);
    if (prov) return { match: true, provider: prov };
  }

  // 3) Atributos comunes en botones
  const labelish = (interactivo.getAttribute?.("aria-label") || interactivo.getAttribute?.("title") || "").toLowerCase();
  if (labelish && HU24_TEXT_HINTS.some(t => labelish.includes(t))) {
    return { match: true, provider: hu24_guessProviderFromText(labelish) };
  }
  if (labelish && labelish.length <= 35) {
    const prov = hu24_guessProviderFromText(labelish);
    if (prov) return { match: true, provider: prov };
  }

  // 4) Imágenes con alt dentro del botón
  const img = interactivo.querySelector?.("img[alt]");
  if (img?.alt) {
    const altLow = img.alt.toLowerCase();
    if (HU24_TEXT_HINTS.some(t => altLow.includes(t))) {
      return { match: true, provider: hu24_guessProviderFromText(altLow) };
    }
    // También si el alt es solo "Google", "Facebook", etc.
    const prov = hu24_guessProviderFromText(altLow);
    if (prov) return { match: true, provider: prov };
  }

  // 5) Botón con data-provider
  const dataProv = interactivo.getAttribute?.("data-provider") || interactivo.dataset?.provider;
  if (dataProv) {
    const prov = hu24_guessProviderFromText(String(dataProv).toLowerCase());
    if (prov) return { match: true, provider: prov };
  }

  return { match: false, provider: null };
}

// Bind principal: solo por clic; mostramos ya y marcamos "pendiente" para re-aparecer si navega.
document.addEventListener("click", (ev) => {
  const { match, provider } = hu24_isSocialLoginClick(ev.target);
  if (match) {
    hu24_showNote(provider);
    hu24_markPending(provider).catch(() => { });
  }
}, { capture: true });

// Si venimos de una navegación inmediatamente tras autorizar, re-muestra la nota
hu24_checkPendingAndShow().catch(() => { });

// =================== Deteccion de Enlaces Acortados ===================
const shorteners = ["bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd", "cli.gs", "yfrog.com", "migre.me", "ff.im", "url4.eu", "tr.im", "twit.ac", "su.pr", "twurl.nl", "snipurl.com", "short.to", "BudURL.com", "ping.fm", "post.ly", "Just.as", "bkite.com", "snipr.com", "fic.kr", "loopt.us", "doiop.com", "short.ie", "kl.am", "wp.me", "rubyurl.com", "om.ly", "to.ly", "bit.do", "t2m.io", "rebrand.ly", "cutt.ly", "shorte.st", "adf.ly"];

window.addEventListener('click', function(e) {
    const anchor = e.target.closest('a');

    if (anchor && anchor.href) {
        let urlString = anchor.href;
        
        // Manejar el filtro de Steam si existe
        if (urlString.includes('linkfilter/?url=')) {
            const params = new URLSearchParams(new URL(urlString).search);
            const steamUrlParam = params.get('url');
            if (steamUrlParam) urlString = steamUrlParam;
        }

        try {
            const isShortener = shorteners.some(s => urlString.includes(s));

            if (isShortener) {
                e.preventDefault();
                e.stopImmediatePropagation();
                
                mostrarAviso(
                    "⚠ Enlace Acortado Detectado",
                    `Este enlace podría ser peligroso o rastrear tu actividad:\n${urlString}`,
                    "Asegúrate de confiar en el remitente antes de continuar bajo tu propio riesgo.",
                    { tipo: "shortlink", urlDestino: urlString }
                );
            }
        } catch(err) {
            console.error("[PrivacyExtension] Error en detección de enlace acortado:", err);
        }
    }
}, true);