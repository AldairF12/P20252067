// =================== Estado global ===================

// Helper de seguridad: escapa caracteres HTML para evitar XSS al insertar texto de usuario en innerHTML
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

let avisoActivo = null;            // nodo del aviso (singleton)
let ultimoTipoDetectado = null;
let ultimosMatches = [];
let ultimoTarget = null;

// Cola de detecciones múltiples: cuando el texto contiene varios datos sensibles
// (ej. correo + DNI), se muestran en secuencia después de cada omitir/aceptar.
let colaDetecciones = []; // [{tipo, matches, vulnerabilidad, recomendacion}]
let colaTarget = null; // elemento input asociado a la cola actual
let colaTexto = "";   // snapshot del texto que originó la cola

// Timers globales
let autoCloseTimerId = null;
let postAceptarTimerId = null;
let inputDebounceId = null;
let hardCloseTimerId = null;
const HARD_MAX_MS = 15000; // tope duro 15s
let lastCopyNoticeAt = 0;
const COPY_COOLDOWN_MS = 2000; // evita spam por múltiples copy seguidos

// Control de análisis para evitar resultados viejos
let ultimaSolicitudId = 0;

// ====== Cache de ajustes (se actualiza en caliente) ======
const state = {
  activo: true,
  paginas: { steam: true, roblox: true, epic: true, discord: true },
  tipos: { correo: true, nombre: true, tarjeta: true, dni: true },
  omitidos: []
};

// --- HU08: Config y estado por formulario/section ---
const FORM_COOLDOWN_MS = 60000; // 60s
const formLastShown = new WeakMap(); // WeakMap<Element, number>

// --- HU-12: Dominios para enlaces acortados y typosquatting ---
const SHORTENER_DOMAINS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "ow.ly", "is.gd", "buff.ly",
  "rebrand.ly", "cutt.ly", "goo.gl", "tiny.cc", "bit.do"
]);

const LEGITIMATE_DOMAINS = new Set([
  "youtube.com", "google.com", "facebook.com", "discord.com",
  "steamcommunity.com", "steampowered.com", "roblox.com", "epicgames.com",
  "twitter.com", "twitch.tv"
]);

// Cuánta “distancia” permitimos entre un dominio real y uno sospechoso
const TYPO_THRESHOLD = 2;


// Palabras clave por categoría
const KW = {
  correo: /\b(correo|e-?mail|email)\b/i,
  dni: /\b(dni|documento|c[eé]dula|id\s*nacional|nro\s*doc)\b/i,
  tarjeta: /\b(tarjeta|credit|debit|cvv|cvc|n[uú]mero\s*de\s*tarjeta|pan)\b/i,
  nombre: /\b(nombre(?:\s+real)?|name|nombres|apellidos|apellido)\b/i,
  telefono: /\b(t[eé]lefono|cel(ular)?|m[oó]vil|whats?app|phone|n[uú]mero\s*de\s*tel[eé]fono)\b/i,
  ubicacion: /\b(ubicaci[oó]n|ciudad|direcci[oó]n|address|location|provincia|regi[oó]n)\b/i,
};

// categorías que cuentan para el umbral
const CATEGORIAS_SENSIBLES = ["correo", "dni", "tarjeta", "nombre", "telefono"];


// ====== Capa ML (modelo ONNX en la propia extensión) ======
let mlModulePromise = null;

async function analizarTextoML(texto) {
  // Carga perezosa del módulo de inferencia
  console.log("analizar con el inference");
  if (!mlModulePromise) {
    mlModulePromise = import(chrome.runtime.getURL("ml/inference.js"));
  }
  const { analizarTextoConModelo } = await mlModulePromise;
  return analizarTextoConModelo(texto);
}

// ================= Regla correo + tarjeta (menos falsos positivos) =================
function aplicarReglaCorreoTarjeta(texto, { expone, tipo }) {
  const correoRegex = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/;

  const hayCorreo = correoRegex.test(texto);
  const hayTarjeta = extraerTarjetasValidas(texto).length > 0;

  // 1) Si el modelo no marcó nada pero hay correo -> forzamos CORREO
  if (!expone && hayCorreo) {
    expone = true;
    tipo = "correo";
  }

  // 2) Si el modelo dice TARJETA pero NO hay correo -> descartamos (probable falso positivo)
  if (expone && tipo === "tarjeta" && !hayCorreo) {
    expone = false;
    tipo = null;
  }

  // (Opcional) podrías usar hayCorreo/hayTarjeta para más reglas luego
  return { expone, tipo, hayCorreo, hayTarjeta };
}


// ================= HU-12: Distancia de Levenshtein =================
function levenshtein(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const d = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= m; i++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // borrado
        d[i][j - 1] + 1,       // inserción
        d[i - 1][j - 1] + cost // sustitución
      );
    }
  }
  return d[m][n];
}

// ================= HU-12: Analizador de enlaces en texto =================
function hu12_analizarTextoParaLinks(texto) {
  // Regex general para URLs
  const urlRegex = /(https?:\/\/[^\s/$.?#].[^\s]*)/gi;
  const urls = texto.match(urlRegex);

  if (!urls) {
    return { expone: false, tipo: null };
  }

  for (const urlStr of urls) {
    try {
      const url = new URL(urlStr);
      const host = url.hostname.replace(/^www\./, "");

      // 1. Acortadores
      if (SHORTENER_DOMAINS.has(host)) {
        return { expone: true, tipo: "shortlink" };
      }

      // 2. Typosquatting
      if (LEGITIMATE_DOMAINS.has(host)) {
        continue; // dominio legítimo exacto
      }

      // Comparamos contra todos los legítimos
      for (const legit of LEGITIMATE_DOMAINS) {
        const dist = levenshtein(host, legit);
        if (dist > 0 && dist <= TYPO_THRESHOLD) {
          return { expone: true, tipo: "typosquat" };
        }
      }
    } catch (e) {
      // URL inválida, ignoramos
    }
  }

  return { expone: false, tipo: null };
}



// Intenta extraer texto semántico de un “campo” (input real o pseudo-input)
function textoCampoPlus(el) {
  const acc = [];

  // Caso general: label[for], label ascendente, aria/placeholder/name/id
  try {
    if (el.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) acc.push(byFor.textContent || "");
    }
    const labUp = el.closest("label");
    if (labUp) acc.push(labUp.textContent || "");
    for (const a of ["aria-label", "placeholder"]) {
      const v = el.getAttribute?.(a);
      if (v) acc.push(v);
    }
    if (el.name) acc.push(el.name);
    if (el.id) acc.push(el.id);

    // Hermanos cercanos con texto breve
    const prev = el.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.length < 200) acc.push(prev.textContent);

    // Padre con poco texto (evita contenedores gigantes)
    const parent = el.parentElement;
    if (parent && parent.textContent && parent.textContent.length < 300) {
      const clone = parent.cloneNode(true);
      // Evitamos incluir el texto que el usuario está escribiendo (dentro de 'el')
      const index = Array.from(parent.children).indexOf(el);
      if (index !== -1 && clone.children[index]) {
        clone.removeChild(clone.children[index]);
      }
      // Por si acaso, remover también otros inputs
      const inputs = clone.querySelectorAll("input, textarea");
      for (const n of inputs) n.remove();

      acc.push(clone.textContent);
    }
  } catch { }

  // Caso Steam: label visual en .DialogLabel cerca del input/botón
  try {
    const steamLabel = el.closest("label")?.querySelector(".DialogLabel");
    if (steamLabel) acc.push(steamLabel.textContent || "");
    const steamAround = el.closest(".DialogInputLabelGroup, .DialogInput_Wrapper, ._DialogLayout");
    if (steamAround) {
      const lab = steamAround.querySelector(".DialogLabel");
      if (lab) acc.push(lab.textContent || "");
    }
  } catch { }

  // Caso Roblox: bloques con .account-settings-text-field (no hay input editable hasta hacer click)
  try {
    const robloxField = el.closest(".account-settings-text-field");
    if (robloxField) {
      const robloxLabel = robloxField.querySelector(".account-info-inline-label");
      if (robloxLabel) acc.push(robloxLabel.textContent || "");
    }
    // También hay secciones con H2
    const robloxSection = el.closest(".setting-section");
    if (robloxSection) {
      const h2 = robloxSection.querySelector(".setting-section-header");
      if (h2) acc.push(h2.textContent || "");
    }
  } catch { }

  return (acc.join(" ") || "").trim();
}

// Clasifica texto a categoría
function clasificarCategoriaPorTexto(t) {
  if (!t) return null;
  if (KW.correo.test(t)) return "correo";
  if (KW.dni.test(t)) return "dni";
  if (KW.tarjeta.test(t)) return "tarjeta";
  if (KW.nombre.test(t)) return "nombre";
  if (KW.telefono.test(t)) return "telefono";
  if (KW.ubicacion.test(t)) return "ubicacion";
  return null;
}


async function loadSettings() {
  const s = await chrome.storage.local.get(["activo", "paginas", "tipos", "omitidos"]);
  if (typeof s.activo === "boolean") state.activo = s.activo;
  if (s.paginas) state.paginas = { ...state.paginas, ...s.paginas };
  if (s.tipos) state.tipos = { ...state.tipos, ...s.tipos };
  if (Array.isArray(s.omitidos)) state.omitidos = s.omitidos;
}
loadSettings();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.activo) state.activo = changes.activo.newValue;
  if (changes.paginas) state.paginas = { ...state.paginas, ...changes.paginas.newValue };
  if (changes.tipos) state.tipos = { ...state.tipos, ...changes.tipos.newValue };
  if (changes.omitidos) state.omitidos = changes.omitidos.newValue || [];
});

// ====== Helper: ¿esta página está habilitada? ======
function paginaKeyFromLocation() {
  const h = location.hostname;
  if (h.endsWith("steampowered.com") || h.endsWith("steamcommunity.com")) return "steam";
  if (h.endsWith("roblox.com")) return "roblox";
  if (h.endsWith("epicgames.com")) return "epic";
  if (h.endsWith("discord.com")) return "discord";
  return null;
}
function paginaHabilitada() {
  const key = paginaKeyFromLocation();
  if (!key) return false;
  return !!state.paginas[key];
}

// =================== Omisión temporal (runtime) ===================
const OMIT_MS = 30000; // 30 segundos (estaba en 3000 = 3 segundos por error)
let sesionEntrada = 0;
const omitidosRuntime = new Map(); // tipo -> { until, sesion, input }

function nuevaSesion(target) {
  // Si el framework (ej. React) recreó el input, el nodo DOM cambia pero lógicamente es el mismo.
  if (ultimoTarget && target && ultimoTarget !== target) {
    let esMismoCampo = false;
    if (ultimoTarget.name && target.name && ultimoTarget.name === target.name) esMismoCampo = true;
    else if (ultimoTarget.id && target.id && ultimoTarget.id === target.id) esMismoCampo = true;
    else {
      const ctxAnterior = textoCampoPlus(ultimoTarget);
      const ctxActual = textoCampoPlus(target);
      if (ctxAnterior && ctxActual && ctxAnterior === ctxActual) esMismoCampo = true;
    }

    if (esMismoCampo) {
      ultimoTarget = target; // Actualizar referencia DOM
      return sesionEntrada;  // No cambiar de sesión
    }
  }

  sesionEntrada += 1;
  ultimoTarget = target || ultimoTarget;
  colaDetecciones = []; // limpiar cola al cambiar de sesión/input

  // Limpiamos solo los que ya expiraron por tiempo
  const ahora = Date.now();
  for (const [tipo, info] of omitidosRuntime.entries()) {
    if (info.until < ahora) omitidosRuntime.delete(tipo);
  }

  ignoradosUnicos = new Set(); // reinicia ignorados únicos por sesión
  return sesionEntrada;
}
function silenciadoPorOmitir(tipo, target) {
  const info = omitidosRuntime.get(tipo);
  if (!info) return false;
  const ahora = Date.now();
  if (info.until && info.until < ahora) {
    console.log(`[Omitir] Expiró el tiempo de ${tipo}.`);
    omitidosRuntime.delete(tipo);
    return false;
  }

  if (info.input && target) {
    if (info.input === target) {
      console.log(`[Omitir] Silenciado ${tipo} (mismo input exacto). Faltan ${((info.until - ahora) / 1000).toFixed(1)}s`);
      return true;
    }

    if (info.input.name && target.name && info.input.name === target.name) {
      console.log(`[Omitir] Silenciado ${tipo} (mismo name: ${target.name}). Faltan ${((info.until - ahora) / 1000).toFixed(1)}s`);
      return true;
    }
    if (info.input.id && target.id && info.input.id === target.id) {
      console.log(`[Omitir] Silenciado ${tipo} (mismo id: ${target.id}). Faltan ${((info.until - ahora) / 1000).toFixed(1)}s`);
      return true;
    }

    const ctxAnterior = textoCampoPlus(info.input);
    const ctxActual = textoCampoPlus(target);
    if (ctxAnterior && ctxActual && ctxAnterior === ctxActual) {
      console.log(`[Omitir] Silenciado ${tipo} (mismo contexto). Faltan ${((info.until - ahora) / 1000).toFixed(1)}s`);
      return true;
    }

    console.log(`[Omitir] No silenciado ${tipo} (es distinto input). Anterior:`, info.input, `Nuevo:`, target);
    return false;
  }

  if (info.sesion !== sesionEntrada) {
    console.log(`[Omitir] No silenciado ${tipo} (distinta sesión). info: ${info.sesion}, actual: ${sesionEntrada}`);
    return false;
  }

  console.log(`[Omitir] Silenciado ${tipo} (por sesión). Faltan ${((info.until - ahora) / 1000).toFixed(1)}s`);
  return true;
}
// Eliminado: resetOmisionesAlCambiarTipo (causaba que se borraran omisiones prematuramente)

// =================== Historial (mínimo requerido) ===================
const HIST_KEY = "historialAvisos";
let ignoradosUnicos = new Set(); // `${sesionEntrada}:${tipo}`
let avisoPendiente = null;        // { tipo, sesion, actionTomada: boolean }

async function guardarHistorialEntrada({ tipo, accion }) {
  try {
    const entry = {
      accion,                       // "aceptar" | "omitir" | "ignorar"
      ts: new Date().toISOString(), // para ordenar
      tipo,                         // dni|correo|nombre|tarjeta
      url: location.href
    };
    const store = await chrome.storage.local.get(HIST_KEY);
    const arr = Array.isArray(store[HIST_KEY]) ? store[HIST_KEY] : [];
    arr.push(entry);
    await chrome.storage.local.set({ [HIST_KEY]: arr });
  } catch (e) {
    console.warn("No se pudo guardar historial:", e);
  }
}

// --- Helper robusto para registrar acción y cerrar sin crash ---
let _cerrandoAviso = false;
async function registrarAccionYCerrar(accion, { forceClose = false } = {}) {
  if (_cerrandoAviso) return;
  _cerrandoAviso = true;
  try {
    const pend = avisoPendiente; // snapshot
    if (pend && !pend.actionTomada) {
      pend.actionTomada = true;
      await guardarHistorialEntrada({ tipo: pend.tipo, accion });
    }
  } catch (e) {
    console.warn("registrarAccionYCerrar error:", e);
  } finally {
    limpiarAviso({ respectHover: !forceClose });
    _cerrandoAviso = false;
  }
  limpiarAviso({ respectHover: !forceClose });
}

// =================== Evento principal (con debounce) ===================
let ignorarEventosProgramaticos = false;

// Listener para inputs y textareas estándar
document.addEventListener("input", (event) => {
  if (ignorarEventosProgramaticos) return;
  const target = event.target;
  clearTimeout(inputDebounceId);
  inputDebounceId = setTimeout(() => {
    onUserInput(target);
  }, 500);
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
  clearTimeout(inputDebounceId);
  inputDebounceId = setTimeout(() => {
    onUserInput(target);
  }, 500);
}, true); // capture = true para llegar antes que Slate.js

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
    // data: { expone: boolean, tipo: "dni"|"tarjeta"|"nombre"|"correo"|null }

    const expone = !!data?.expone;
    let tipo = data?.tipo || "";
    if (expone && (!tipo || !state.tipos?.[tipo])) {
      tipo = detectarTipoDato(texto); // fallback local
    }

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
    textoSeccion = (clone.textContent || "").slice(0, 2000); // recorta por rendimiento
  } catch (e) {
    textoSeccion = (container.textContent || "").slice(0, 2000);
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
    limpiarAviso({ respectHover: false });
    return;
  }

  if (ultimoTarget !== target) {
    nuevaSesion(target);
  }

  ejecutarAnalisisTexto(texto, target, solicitudId);
}

async function ejecutarAnalisisTexto(textoOriginal, target, solicitudId) {
  try {
    if (solicitudId !== ultimaSolicitudId) return;

    // Limpiamos los datos que ya están enmascarados para no volver a detectarlos
    const texto = limpiarDatosEnmascarados(textoOriginal);
    if (!texto.trim() || texto.length < 5) return;

    // ── Fase 1: regex — detecta TODOS los tipos explícitos presentes ───────────────
    // Correo, DNI, tarjeta tienen patrones únicos verificables con regex.
    // Si se detectan varios, se encolan y se muestran uno a uno.
    const tiposEncontrados = detectarTiposDato(texto);
    const itemsCola = tiposEncontrados
      .filter(t => state.tipos?.[t] && !silenciadoPorOmitir(t, target))
      .map(t => ({
        tipo: t,
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
      mostrarAviso(`⚠ Campo sensible: ${tipoContexto.toUpperCase()}`, vc, rc, { tipo: tipoContexto });
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

    const expone = !!data?.expone;
    let tipo = data?.tipo || "";
    if (expone && (!tipo || !state.tipos?.[tipo])) {
      tipo = detectarTipoDato(texto); // fallback local
    }
    console.log("[ONNX]", data, "| expone:", expone, "| tipo:", tipo);

    if (!expone || !tipo || tipo === "ninguno" || !state.tipos?.[tipo]
      || silenciadoPorOmitir(tipo, target)) {
      limpiarAviso({ respectHover: false });
      return;
    }

    colaDetecciones = []; // un solo resultado del modelo, sin cola
    ultimosMatches = detectarMatches(texto, tipo);
    ultimoTipoDetectado = tipo;
    const { vulnerabilidad, recomendacion } = mensajesPorTipo(tipo);
    mostrarAviso(`⚠ ${tipo.toUpperCase()} detectado`, vulnerabilidad, recomendacion, { tipo });

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

    mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo: tipoHeuristico });
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
          mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo: "ninguno" });
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



// ================= VALIDACION DE TARJETAS (ESTRICTA) =================
function validarTarjeta(str) {
  const digits = str.replace(/\D/g, "");
  // Prefijos: Visa (4), Mastercard (51-55), Discover (6011, 65), Amex (34, 37)
  if (!/^(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})$/.test(digits)) return false;
  
  // Algoritmo de Luhn
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n = (n % 10) + 1;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function extraerTarjetasValidas(texto) {
  // Captura secuencias largas de números que parecen tarjetas
  const re = /(?:^|[^\d])((?:\d[ \-]?){13,19})(?=[^\d]|$)/g;
  const matches = [];
  let m;
  while ((m = re.exec(texto)) !== null) {
    const candidato = m[1].trim();
    if (validarTarjeta(candidato)) {
      matches.push(candidato);
    }
  }
  return matches;
}

// ================= LIMPIEZA DE DATOS YA ENMASCARADOS =================
function limpiarDatosEnmascarados(texto) {
  if (!texto) return "";
  let t = String(texto);
  // Correo: letra/numero seguido de asteriscos y luego @ (ej. j***@correo.com)
  t = t.replace(/\b[a-z0-9]\*+@[a-z0-9.\-]+\.[a-z]{2,}\b/gi, " ");
  // DNI: asteriscos seguidos de 1 a 4 digitos finales (ej. ******12 o *****834)
  t = t.replace(/\b\*+\d{1,4}\b/g, " ");
  // Tarjeta: bloques de asteriscos seguidos de 4 digitos finales (ej. **** **** **** 1234)
  t = t.replace(/(?:\*+[ \-]?){3,}\d{4}\b/g, " ");
  return t;
}

// ========= Detecciones / ejemplos / enmascarado =========
// Detecta el PRIMER tipo (para fallback y operaciones simples)
function detectarTipoDato(texto) {
  texto = (texto || "").toLowerCase();
  if (/\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/.test(texto)) return "correo";
  // DNI: estricto a 8 dígitos exactos, otros tamaños van al modelo ML
  if (/\b\d{8}\b/.test(texto)) return "dni";
  if (extraerTarjetasValidas(texto).length > 0) return "tarjeta";
  // "nombre" solo lo detecta el modelo (evitar falsos positivos con regex)
  return "ninguno";
}

// Detecta TODOS los tipos presentes en el texto (para la cola de avisos)
function detectarTiposDato(texto) {
  const tipos = [];
  const t = (texto || "").toLowerCase();
  if (/\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/.test(t)) tipos.push("correo");
  // DNI: estricto a 8 dígitos exactos
  if (/\b\d{8}\b/.test(t)) tipos.push("dni");
  if (extraerTarjetasValidas(t).length > 0) tipos.push("tarjeta");
  return tipos;
}

// Muestra el siguiente aviso de la cola (se llama tras Omitir o tras cerrar post-Aceptar)
function procesarSiguienteDeLaCola() {
  while (colaDetecciones.length) {
    const item = colaDetecciones.shift();
    if (!state.tipos?.[item.tipo]) continue;              // tipo desactivado en ajustes
    if (silenciadoPorOmitir(item.tipo, colaTarget)) continue; // ya omitido
    ultimosMatches = item.matches;
    ultimoTipoDetectado = item.tipo;
    mostrarAviso(
      `⚠ ${item.tipo.toUpperCase()} detectado`,
      item.vulnerabilidad,
      item.recomendacion,
      { tipo: item.tipo }
    );
    return;
  }
  // Cola vacía — no hay más tipos pendientes
}

function detectarMatches(texto, tipo) {
  if (!texto) return [];
  let re;
  switch (tipo) {
    case "correo": re = /\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/gi; break;
    case "dni": re = /\b\d{7,9}\b/g; break; // Se usa sólo para extraer/enmascarar cuando el ML lo detecta
    case "tarjeta": re = /\b(?:\d[ \-]?){13,19}\b/g; break; // Regex laxo para extraer y permitir enmascarar tarjetas inválidas detectadas por ML
    case "nombre":
      re = /\b(?!.*[@\d])([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}){1,3})\b/gi;
      break;
    default: return [];
  }
  return re ? (texto.match(re) || []) : [];
}
function mensajesPorTipo(tipo) {
  switch (tipo) {
    case "correo":
      return { vulnerabilidad: "Correo electrónico expuesto.", recomendacion: "Evita compartir tu correo en chats o foros públicos." };
    case "dni":
      return { vulnerabilidad: "Número de DNI detectado.", recomendacion: "Nunca compartas tu DNI en plataformas abiertas." };
    case "tarjeta":
      return { vulnerabilidad: "Posible número de tarjeta detectado.", recomendacion: "No escribas números de tarjeta en ningún campo de texto no seguro." };
    case "nombre":
      return { vulnerabilidad: "Exposición de nombre.", recomendacion: "Evita publicar tu nombre completo en foros o juegos públicos." };
    case "multiple_campos":
      return { vulnerabilidad: "Este formulario solicita múltiples datos sensibles.", recomendacion: "Revisa la política del sitio y comparte solo lo necesario." };
    default:
      return { vulnerabilidad: "Dato potencialmente sensible detectado.", recomendacion: "Evita compartir información personal en espacios públicos." };
  }
}

// Mensajes para detección por CONTEXTO del campo (configuración/perfil)
// Se usa cuando el campo mismo indica el tipo (label, placeholder, etc.)
// pero el valor aún no forma un patrón reconocible.
function mensajesPorContextoCampo(tipo, sitio) {
  const en = sitio ? ` en <b>${escapeHTML(sitio)}</b>` : "";
  switch (tipo) {
    case "correo":
      return {
        vulnerabilidad: `Estás ingresando tu <b>correo electrónico</b>${en}. Este dato quedará guardado en los servidores del sitio.`,
        recomendacion: "Asegúrate de estar en el sitio correcto y que la URL comience con <b>https</b>."
      };
    case "nombre":
      return {
        vulnerabilidad: `Estás ingresando tu <b>nombre real</b>${en}. Este dato puede ser visible para otros usuarios.`,
        recomendacion: "Considera si el sitio realmente necesita tu nombre real o si puedes usar un alias."
      };
    case "dni":
      return {
        vulnerabilidad: `Este campo parece solicitar tu <b>número de identidad</b>${en}.`,
        recomendacion: "Comparte tu DNI/cédula solo en sitios de confianza que lo requieran legalmente."
      };
    case "tarjeta":
      return {
        vulnerabilidad: `Este campo parece solicitar datos de <b>tarjeta de pago</b>${en}.`,
        recomendacion: "Verifica que el sitio tenga certificado SSL y sea una plataforma de pago legítima."
      };
    default:
      return {
        vulnerabilidad: `Estás ingresando datos potencialmente sensibles en este campo${en}.`,
        recomendacion: "Asegúrate de confiar en este sitio antes de compartir información personal."
      };
  }
}
function ejemplosEnmascarados(tipo) {
  switch (tipo) {
    case "correo": return ["j***@correo.com", "m*****.p****@dominio.pe", "u*****+promo@ejemplo.org"];
    case "dni": return ["******12", "*****834", "******90"];
    case "tarjeta": return ["**** **** **** 1234", "****-****-****-9876", "************4321"];
    case "nombre": return [];
    default: return [];
  }
}
function enmascararValorEnInput(input, tipo) {
  if (!input || !input.value) return;
  let nuevo = input.value;
  switch (tipo) {
    case "correo":
      nuevo = nuevo.replace(/[a-z0-9._%+\-]+@/gi, (m) => {
        const [user] = m.split("@");
        const visible = user.slice(0, 1);
        return visible + "*".repeat(Math.max(3, user.length - 1)) + "@";
      });
      break;
    case "dni":
      nuevo = nuevo.replace(/\b(\d{6})(\d{1,3})\b/g, (_, a, b) => "*".repeat(a.length) + b);
      break;
    case "tarjeta":
      nuevo = nuevo.replace(/\b((?:\d[ \-]?){13,19})\b/g, (full) => {
        const digits = full.replace(/\D/g, "");
        const masked = "*".repeat(Math.max(0, digits.length - 4)) + digits.slice(-4);
        return masked.replace(/(.{4})/g, "$1 ").trim();
      });
      break;
    case "nombre":
    default:
      return;
  }
  input.value = nuevo;

  // Disparamos eventos para que la página web sepa que el texto cambió, 
  // pero marcamos que nosotros lo hicimos para no desatar análisis infinitos ni resetear la cola.
  ignorarEventosProgramaticos = true;
  const eventos = ['input', 'change', 'blur'];
  eventos.forEach(tipoEvento => {
    input.dispatchEvent(new Event(tipoEvento, { bubbles: true }));
  });

  // Liberamos la bandera después de un margen de tiempo para que los listeners de la página terminen
  setTimeout(() => {
    ignorarEventosProgramaticos = false;
  }, 200);
}

// ========= UI del aviso + historial =========
let blurListenerActual = null;

function clearTimers() {
  clearTimeout(autoCloseTimerId);
  clearTimeout(postAceptarTimerId);
  clearTimeout(hardCloseTimerId);
  autoCloseTimerId = null;
  postAceptarTimerId = null;
  hardCloseTimerId = null;
}

function limpiarAviso({ respectHover = false } = {}) {
  // No cerrar si está en hover y se pidió respetarlo (solo para autocierre)
  if (respectHover && avisoActivo && avisoActivo.matches && avisoActivo.matches(':hover')) {
    return;
  }

  // Ignorar (una sola vez por tipo/sesión) si el aviso se va sin acción
  if (avisoPendiente && !avisoPendiente.actionTomada) {
    const key = `${avisoPendiente.sesion}:${avisoPendiente.tipo}`;
    if (!ignoradosUnicos.has(key)) {
      ignoradosUnicos.add(key);
      guardarHistorialEntrada({ tipo: avisoPendiente.tipo, accion: "ignorar" });
    }
  }

  clearTimers();

  if (avisoActivo) {
    const el = avisoActivo;
    avisoActivo = null; // liberamos para no bloquear siguientes
    el.style.opacity = "0";
    setTimeout(() => { try { el.remove(); } catch { } }, 400);
  }
  avisoPendiente = null;

  if (blurListenerActual) {
    if (ultimoTarget) ultimoTarget.removeEventListener("blur", blurListenerActual);
    blurListenerActual = null;
  }
}

function startAutoClose() {
  clearTimeout(autoCloseTimerId);
  const AUTOCLOSE_MS = 6000;
  autoCloseTimerId = setTimeout(() => limpiarAviso({ respectHover: true }), AUTOCLOSE_MS);

  // Tope duro: cierre sí o sí incluso si el mouse queda eternamente encima
  clearTimeout(hardCloseTimerId);
  hardCloseTimerId = setTimeout(() => limpiarAviso({ respectHover: false }), HARD_MAX_MS);
}
function stopAutoClose() {
  clearTimeout(autoCloseTimerId);
  autoCloseTimerId = null;
  // No limpiamos el tope duro: debe cumplirse sí o sí
}

// ==========================================================
// ============ INYECCIÓN DE ESTILOS CSS ====================
// ==========================================================
function inyectarEstilosAviso() {
  if (document.getElementById("extension-privacidad-styles")) return;
  const style = document.createElement("style");
  style.id = "extension-privacidad-styles";
  style.textContent = `
    @keyframes priv-slide-up {
      0% { opacity: 0; transform: translateY(15px) scale(0.97); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    .priv-alert {
      --bg: #FFE100;
      --border: #F1D400;
      --shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
      --text-main: #1F2023;
      --text-sub: #3A3B40;
      --bg-success: #dcfce7;
      --border-success: #bbf7d0;
      --text-success: #166534;
      --bg-ignored: #f3f4f6;
      --border-ignored: #e5e7eb;
      --text-ignored: #374151;
    }
    .priv-alert.priv-alert-dark {
      --bg: #EAC900;
      --border: #D1B300;
      --shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
      --text-main: #0A0A0A;
      --text-sub: #222222;
      --bg-success: #064e3b;
      --border-success: #047857;
      --text-success: #a7f3d0;
      --bg-ignored: #27272a;
      --border-ignored: #3f3f46;
      --text-ignored: #e5e7eb;
    }
    .priv-alert {
      background-color: var(--bg);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      color: var(--text-main);
      transition: opacity 0.3s ease, background-color 0.4s ease, border-color 0.4s ease, transform 0.4s ease;
      animation: priv-slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      box-sizing: border-box;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .priv-alert p { margin: 0; line-height: 1.4; }
    .priv-alert-btn {
      flex: 1;
      padding: 10px 14px;
      border-radius: 30px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      font-family: inherit;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 6px;
    }
    .priv-alert-btn-aceptar {
      background: linear-gradient(135deg, #D400FF, #2600FF);
      color: #ffffff;
      box-shadow: 0 4px 12px rgba(38, 0, 255, 0.3);
    }
    .priv-alert-btn-aceptar:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(38, 0, 255, 0.4);
      filter: brightness(1.1);
    }
    .priv-alert-btn-omitir {
      background: linear-gradient(135deg, #D400FF, #FF0004);
      color: #ffffff;
      box-shadow: 0 4px 12px rgba(255, 0, 4, 0.3);
    }
    .priv-alert-btn-omitir:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(255, 0, 4, 0.4);
      filter: brightness(1.1);
    }
    .priv-alert-btn-neutral {
      background: rgba(255, 255, 255, 0.5);
      color: #1F2023;
      border: 1px solid rgba(0, 0, 0, 0.1);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
    }
    .priv-alert-btn-neutral:hover {
      background: rgba(255, 255, 255, 0.8);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
    }
    .priv-alert-close:hover { opacity: 1 !important; transform: scale(1.1); }
  `;
  document.head.appendChild(style);
}

// ==========================================================
// ============ FUNCIÓN mostrarAviso UNIFICADA =============
//    (con posición + tema + historial + enmascarado)
// ==========================================================
async function mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo }) {
  // Reemplazo: cerramos aunque el mouse esté encima (evita superposiciones)
  limpiarAviso({ respectHover: false });
  inyectarEstilosAviso();

  const aviso = document.createElement("div");
  aviso.className = "priv-alert";
  aviso.setAttribute("id", "aviso-proteccion");

  // Tooltip SVG Icon
  const tooltipIcon = `<span title="Punto débil por donde pueden robar tus datos" style="cursor:help;margin-left:4px;opacity:0.75;font-size:13px;">🛈</span>`;

  aviso.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
      <strong style="font-size:16px; font-weight:700;">${titulo}</strong>
      <button class="priv-alert-close" id="btn-cerrar-aviso" type="button" style="background:transparent; border:none; color:inherit; opacity:0.6; font-size:24px; cursor:pointer; line-height:1; padding:0; margin-top:-4px; transition: all 0.2s;">&times;</button>
    </div>
    <p style="font-size:14px; color:var(--text-main); margin:0 0 8px 0; font-weight:600;">
      Vulnerabilidad${tooltipIcon}:<br>
      <span style="font-weight:400; color:var(--text-sub); display:inline-block; margin-top:3px; line-height:1.4;">${vulnerabilidad}</span>
    </p>
    <p style="font-size:14px; color:var(--text-main); margin:0 0 16px 0; font-weight:600;">
      Recomendación:<br>
      <span style="font-weight:400; color:var(--text-sub); display:inline-block; margin-top:3px; line-height:1.4;">${recomendacion}</span>
    </p>
    
    <div class="acciones-inferiores" id="acciones-inferiores" style="display:flex; gap:10px; align-items:center;">
      <button class="priv-alert-btn priv-alert-btn-omitir" id="btn-omitir" type="button">Omitir</button>
      <button class="priv-alert-btn priv-alert-btn-aceptar" id="btn-aceptar" type="button">Aceptar</button>
    </div>
    
    <div id="zona-extra" style="margin-top:12px; display:none;">
      <button class="priv-alert-btn priv-alert-btn-neutral" id="btn-ver-ejemplos" type="button" style="width:100%; margin-bottom:10px;">Ver ejemplos</button>
      <div id="contenedor-ejemplos" style="display:none; font-family:monospace; font-size:13px; color:var(--text-main); margin-bottom:10px; padding:10px; background:rgba(255,255,255,0.4); border-radius:8px; border:1px solid rgba(0,0,0,0.05);"></div>
      <div id="zona-enmascarar" style="display:none;">
        <button class="priv-alert-btn priv-alert-btn-neutral" id="btn-enmascarar" type="button" style="width:100%; display:flex; justify-content:center; align-items:center; gap:6px;">
          <svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
          Enmascarar detectado
        </button>
      </div>
    </div>
  `;

  // --- INICIO DE LÓGICA DE TEMA Y POSICIÓN ---

  // 1. Leer ambas configuraciones del storage
  const { posicionAlerta, theme } = await chrome.storage.local.get(["posicionAlerta", "theme"]);

  // 2. Determinar Posición
  const posicion = posicionAlerta ?? "bottom-right";
  const estilosPosicion = {
    "bottom-right": { bottom: "24px", right: "24px", left: "auto", top: "auto" },
    "bottom-left": { bottom: "24px", left: "24px", right: "auto", top: "auto" },
    "top-right": { top: "24px", right: "24px", left: "auto", bottom: "auto" },
    "top-left": { top: "24px", left: "24px", right: "auto", bottom: "auto" }
  };

  // 3. Determinar Tema
  let temaFinal = theme ?? "system";
  if (temaFinal === "system") {
    temaFinal = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  // 4. Asignar clases
  aviso.className = `priv-alert ${temaFinal === "dark" ? "priv-alert-dark" : "priv-alert-light"}`;

  // 5. Aplicar base position styles
  Object.assign(aviso.style, {
    position: "fixed",
    width: "380px",
    padding: "16px",
    borderRadius: "16px",
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    zIndex: "2147483647",
    ...estilosPosicion[posicion]
  });

  // --- FIN DE LÓGICA DE TEMA Y POSICIÓN ---

  document.body.appendChild(aviso);
  avisoActivo = aviso;

  let accionResueltaVisualmente = false;

  // Prevenir que hacer click en la alerta quite el foco del input
  aviso.addEventListener("mousedown", (e) => e.preventDefault());

  // Cerrar cuando el input original pierda foco (y el click no fue en la alerta)
  if (ultimoTarget) {
    blurListenerActual = () => {
      if (ignorarEventosProgramaticos) return; // Si fue un blur forzado por nuestra extensión, ignóralo
      setTimeout(() => {
        if (document.activeElement !== ultimoTarget) {
          limpiarAviso({ respectHover: false });
        }
      }, 150);
    };
    ultimoTarget.addEventListener("blur", blurListenerActual);
  }

  // AUTOCIERRE con pausa por hover + tope duro
  aviso.addEventListener("mouseenter", stopAutoClose);
  aviso.addEventListener("mouseleave", () => {
    if (accionResueltaVisualmente) {
      clearTimers();
      limpiarAviso({ respectHover: false });
      setTimeout(() => procesarSiguienteDeLaCola(), 350);
    } else {
      startAutoClose();
    }
  });
  startAutoClose();

  // Estado del aviso visible (para “ignorar” si se cierra solo)
  avisoPendiente = { tipo, sesion: sesionEntrada, actionTomada: false };

  // Bind de botones
  const btnCerrar = aviso.querySelector("#btn-cerrar-aviso");
  const btnOmitir = aviso.querySelector("#btn-omitir");
  const btnAceptar = aviso.querySelector("#btn-aceptar");
  const accionesInferiores = aviso.querySelector("#acciones-inferiores");
  const zonaExtra = aviso.querySelector("#zona-extra");
  const btnVerEjemplos = aviso.querySelector("#btn-ver-ejemplos");
  const contEjemplos = aviso.querySelector("#contenedor-ejemplos");
  const zonaEnmascarar = aviso.querySelector("#zona-enmascarar");
  const btnEnmascarar = aviso.querySelector("#btn-enmascarar");

  btnCerrar.addEventListener("click", () => limpiarAviso({ respectHover: false }));

  // Helper de estado resuelto visual
  function mostrarEstadoResuelto(texto = "Resuelto", estado = "success", ocultarExtra = true) {
    accionResueltaVisualmente = true;
    
    // Transicionar CSS variables para estado
    if (estado === "success") {
      aviso.style.setProperty("--bg", "var(--bg-success)");
      aviso.style.setProperty("--border", "var(--border-success)");
      aviso.style.setProperty("--text-main", "var(--text-success)");
      aviso.style.setProperty("--text-sub", "var(--text-success)");
      aviso.style.setProperty("--icon-warn", "var(--text-success)");
    } else if (estado === "ignored") {
      aviso.style.setProperty("--bg", "var(--bg-ignored)");
      aviso.style.setProperty("--border", "var(--border-ignored)");
      aviso.style.setProperty("--text-main", "var(--text-ignored)");
      aviso.style.setProperty("--text-sub", "var(--text-ignored)");
      aviso.style.setProperty("--icon-warn", "var(--text-ignored)");
    }

    if (ocultarExtra && zonaExtra) zonaExtra.style.display = "none";
    
    // Icono animado para success o ignorado
    const svgIcon = estado === "success" 
      ? `<svg style="width:18px;height:18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>`
      : `<svg style="width:18px;height:18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`;

    accionesInferiores.style.display = "flex";
    accionesInferiores.innerHTML = `
      <div style="flex:1; display:flex; justify-content:center; align-items:center; gap:8px; padding:10px; font-weight:600; font-size:14px; color:inherit; background:transparent;">
        ${svgIcon} ${texto}
      </div>
    `;

    clearTimers();
    postAceptarTimerId = setTimeout(() => {
      // Solo cerrar si el mouse NO está encima
      if (avisoActivo && avisoActivo.matches(':hover')) return;
      
      limpiarAviso({ respectHover: false });
      setTimeout(() => procesarSiguienteDeLaCola(), 350);
    }, 4500); // Fallback para móviles o si dejan el ratón encima un rato largo
  }

  // Omitir (robusto)
  btnOmitir.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopAutoClose();

    omitidosRuntime.set(tipo, {
      until: Date.now() + OMIT_MS,
      sesion: sesionEntrada,
      input: ultimoTarget
    });
    console.log(`[Omitir] Clic en Omitir. Silenciando '${tipo}' por ${OMIT_MS / 1000}s para este input.`);

    await registrarAccionYCerrar("omitir", { forceClose: false });

    // Estado visual Omitido
    mostrarEstadoResuelto("Omitido", "ignored", true);
  });

  // Aceptar
  btnAceptar.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopAutoClose();

    // Silenciar el campo también al aceptar para evitar doble advertencia 
    // (ej. Fase 0.5 por etiqueta, y luego Fase 1 al terminar de escribir)
    omitidosRuntime.set(tipo, {
      until: Date.now() + OMIT_MS,
      sesion: sesionEntrada,
      input: ultimoTarget
    });
    console.log(`[Omitir] Clic en Aceptar. Silenciando '${tipo}' por ${OMIT_MS / 1000}s para este input.`);

    const pend = avisoPendiente;
    if (pend && !pend.actionTomada) {
      pend.actionTomada = true;
      await guardarHistorialEntrada({ tipo, accion: "aceptar" });
    }

    const puedeEnmascarar =
      ["correo", "dni", "tarjeta"].includes(tipo) &&
      ultimosMatches.length > 0 &&
      tipo !== "multiple_campos" &&
      ultimoTarget && typeof ultimoTarget.value === "string";

    const tieneEjemplos = ejemplosEnmascarados(tipo).length > 0;

    if (puedeEnmascarar || tieneEjemplos) {
      zonaExtra.style.display = "block";
      zonaEnmascarar.style.display = puedeEnmascarar ? "block" : "none";
      btnVerEjemplos.style.display = tieneEjemplos ? "block" : "none";
      mostrarEstadoResuelto("Aceptado", "success", false);
    } else {
      mostrarEstadoResuelto("Resuelto", "success", true);
    }
  });

  btnVerEjemplos.addEventListener("click", () => {
    const ejemplos = ejemplosEnmascarados(tipo);
    contEjemplos.innerHTML = ejemplos.length
      ? ejemplos.map(e => `<div>• ${e}</div>`).join("")
      : "<div>No hay ejemplos para este tipo.</div>";
    contEjemplos.style.display = "block";
  });

  btnEnmascarar.addEventListener("click", () => {
    if (ultimoTarget && typeof ultimoTarget.value === "string") {
      enmascararValorEnInput(ultimoTarget, tipo);
    }
    mostrarEstadoResuelto("✔ Enmascarado y Resuelto", "#dcfce7", "#166534", "#bbf7d0", true);
  });
}



// =================== HU23: Recordatorio al cerrar sesión ===================

// =================== HU23 (simple por clic y 4 sitios) ===================

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
  await hu23_sessionRemove(HU23_PENDING_KEY);
}

// UI del banner
let hu23BannerEl = null;
function hu23_removeBanner() {
  if (hu23BannerEl) { hu23BannerEl.remove(); hu23BannerEl = null; }
}

function hu23_showBanner() {
  hu23_removeBanner();

  const host = location.hostname;
  const el = document.createElement("div");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  Object.assign(el.style, {
    position: "fixed",
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    maxWidth: "520px",
    width: "calc(100% - 40px)",
    background: "#0f172a",
    color: "#fff",
    padding: "14px 16px",
    border: "1px solid rgba(255,255,255,.15)",
    borderRadius: "12px",
    boxShadow: "0 10px 24px rgba(0,0,0,.35)",
    zIndex: "2147483647",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    fontSize: "14px"
  });
  el.innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <div style="font-size:18px;line-height:1;">🔒</div>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">
          Limpia autocompletado y cookies
        </div>
        <div style="opacity:.95;line-height:1.45;margin-bottom:10px;">
          Has cerrado sesión en <b>${host}</b>. Te recomendamos limpiar datos del sitio para proteger tu privacidad.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="hu23-btn-clean" type="button"
            style="flex:1 0 180px;padding:9px 12px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;">
            Limpiar ahora
          </button>
          <button id="hu23-btn-close" type="button"
            style="flex:1 0 120px;padding:9px 12px;border:1px solid #334155;border-radius:10px;background:#0f172a;color:#fff;font-weight:700;cursor:pointer;">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  hu23BannerEl = el;

  const btnClean = el.querySelector("#hu23-btn-clean");
  const btnClose = el.querySelector("#hu23-btn-close");
  btnClean.addEventListener("click", async () => {
    try { await chrome.runtime.sendMessage({ type: "OPEN_CLEAR_SETTINGS" }); } catch { }
    // El usuario decide cerrar; no autocerramos
  });
  btnClose.addEventListener("click", () => hu23_removeBanner());
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
  ["amazon", "amazon"], ["linkedin", "linkedin"]
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

let hu24NoteEl = null;
function hu24_removeNote() {
  if (hu24NoteEl) { hu24NoteEl.remove(); hu24NoteEl = null; }
}

function hu24_guessProviderFromText(text) {
  const low = (text || "").toLowerCase();
  for (const [needle, label] of HU24_PROVIDER_ALIASES) {
    if (low.includes(needle)) return label;
  }
  return null;
}

function hu24_showNote(providerGuess = null) {
  hu24_removeNote();

  const host = location.hostname;
  const el = document.createElement("div");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  Object.assign(el.style, {
    position: "fixed",
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    maxWidth: "540px",
    width: "calc(100% - 40px)",
    background: "#0b1220",
    color: "#fff",
    padding: "16px 18px",
    border: "1px solid rgba(255,255,255,.15)",
    borderRadius: "12px",
    boxShadow: "0 10px 24px rgba(0,0,0,.35)",
    zIndex: "2147483647",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    fontSize: "14px"
  });

  const prov = providerGuess ? providerGuess[0].toUpperCase() + providerGuess.slice(1) : "un proveedor";
  el.innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <div style="font-size:18px;line-height:1;">ℹ️</div>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">
          Iniciar sesión con ${prov}
        </div>
        <div style="opacity:.95;line-height:1.5;margin-bottom:10px;">
          Al continuar con <b>${prov}</b> en <b>${host}</b>, podrías compartir datos como tu perfil, correo y foto.
          Revisa los permisos solicitados y asegúrate de confiar en el sitio antes de autorizar.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="hu24-btn-privacy" type="button"
            style="flex:1 0 180px;padding:9px 12px;border:none;border-radius:10px;background:#0ea5e9;color:#0b1220;font-weight:800;cursor:pointer;">
            Más privacidad
          </button>
          <button id="hu24-btn-close" type="button"
            style="flex:1 0 120px;padding:9px 12px;border:1px solid #334155;border-radius:10px;background:#0b1220;color:#fff;font-weight:700;cursor:pointer;">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  hu24NoteEl = el;

  const btnPrivacy = el.querySelector("#hu24-btn-privacy");
  const btnClose = el.querySelector("#hu24-btn-close");

  // No autocierre; el usuario decide.
  btnPrivacy.addEventListener("click", async () => {
    try { await chrome.runtime.sendMessage({ type: "HU23_OPEN_CLEAR_SETTINGS" }); } catch { }
  });
  btnClose.addEventListener("click", () => hu24_removeNote());
}

// ¿El clic parece un botón de “Continuar con …”?
function hu24_isSocialLoginClick(target) {
  if (!target) return { match: false, provider: null };

  // 1) Href hacia OAuth/OpenID
  const a = target.closest?.("a[href]") || (target.tagName === "A" ? target : null);
  if (a?.href) {
    const hrefLow = a.href.toLowerCase();
    if (HU24_HREF_HINTS.some(h => hrefLow.includes(h))) {
      return { match: true, provider: hu24_guessProviderFromText(hrefLow) };
    }
  }

  // 2) Texto visible del propio target
  const text = (target.innerText || target.textContent || "").trim().toLowerCase();
  if (text && HU24_TEXT_HINTS.some(t => text.includes(t))) {
    return { match: true, provider: hu24_guessProviderFromText(text) };
  }

  // 3) Atributos comunes en botones
  const labelish = (target.getAttribute?.("aria-label") || target.getAttribute?.("title") || "").toLowerCase();
  if (labelish && HU24_TEXT_HINTS.some(t => labelish.includes(t))) {
    return { match: true, provider: hu24_guessProviderFromText(labelish) };
  }

  // 4) Imágenes con alt dentro del botón
  const img = target.closest("button, a")?.querySelector?.("img[alt]");
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
  const btn = target.closest("button, a, div");
  const dataProv = btn?.getAttribute?.("data-provider") || btn?.dataset?.provider;
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
