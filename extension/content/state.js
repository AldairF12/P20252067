/* === content/state.js: Estado Global, Ajustes e Historial === */

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
  tipos: { correo: true, nombre: true, tarjeta: true, dni: true, celular: true, edad: true, ubicacion: true, enlace_sospechoso: true },
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
  celular: /\b(t[eé]lefono|cel(ular)?|m[oó]vil|whats?app|phone|n[uú]mero\s*de\s*tel[eé]fono)\b/i,
  ubicacion: /\b(ubicaci[oó]n|ciudad|direcci[oó]n|address|location|provincia|regi[oó]n)\b/i,
};

// ================= Regex de datos estructurados (peruanos) =================
// Celular peruano: 9 dígitos empezando en 9, con o sin prefijo +51 / 51 / 0051. Se usa lookahead/lookbehind negativo para asegurar que no hay más dígitos
const REGEX_CELULAR = /(?<!\d)(?:\+51[\s\-]?|51[\s\-]?|0051[\s\-]?)?9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}(?!\d)/g;
// DNI peruano: exactamente 8 dígitos (no 9, no 7, no más)
const REGEX_DNI     = /(?<!\d)\d{8}(?!\d)/g;
// Correo estándar
const REGEX_CORREO  = /\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/gi;
// Tarjeta: 13-19 dígitos con posibles espacios/guiones
const REGEX_TARJETA = /\b(?:\d[ \-]?){13,19}\b/g;

// categorías que cuentan para el umbral
const CATEGORIAS_SENSIBLES = ["correo", "dni", "tarjeta", "nombre", "celular", "ubicacion"];



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

