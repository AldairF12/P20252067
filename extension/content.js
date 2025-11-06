// =================== Estado global ===================
let avisoActivo = null;            // nodo del aviso (singleton)
let ultimoTipoDetectado = null;
let ultimosMatches = [];
let ultimoTarget = null;

// Timers globales
let autoCloseTimerId = null;
let postAceptarTimerId = null;
let inputDebounceId = null;
let hardCloseTimerId = null;
const HARD_MAX_MS = 15000; // tope duro 15s
let lastCopyNoticeAt = 0;
const COPY_COOLDOWN_MS = 2000; // evita spam por múltiples copy seguidos

// ====== Cache de ajustes (se actualiza en caliente) ======
const state = {
  activo: true,
  paginas: { steam: true, roblox: true, epic: true, discord: true },
  tipos: { correo: true, nombre: true, tarjeta: true, dni: true },
  omitidos: []
};

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
const OMIT_MS = 30000; // 30s
let sesionEntrada = 0;
const omitidosRuntime = new Map(); // tipo -> { until, sesion, input }

function nuevaSesion(target) {
  sesionEntrada += 1;
  ultimoTarget = target || ultimoTarget;
  for (const [tipo, info] of omitidosRuntime.entries()) {
    if (info.sesion !== sesionEntrada) omitidosRuntime.delete(tipo);
  }
  ignoradosUnicos = new Set(); // reinicia ignorados únicos por sesión
  return sesionEntrada;
}
function silenciadoPorOmitir(tipo, target) {
  const info = omitidosRuntime.get(tipo);
  if (!info) return false;
  const ahora = Date.now();
  if (info.until && info.until < ahora) {
    omitidosRuntime.delete(tipo);
    return false;
  }
  if (info.input && target && info.input !== target) return false;
  if (info.sesion !== sesionEntrada) return false;
  return true;
}
function resetOmisionesAlCambiarTipo(tipoActual) {
  for (const [tipo] of omitidosRuntime.entries()) {
    if (tipo !== tipoActual) omitidosRuntime.delete(tipo);
  }
}

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
}

// =================== Evento principal (con debounce) ===================
document.addEventListener("input", (event) => {
  clearTimeout(inputDebounceId);
  inputDebounceId = setTimeout(() => onUserInput(event), 250);
});

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
    if (!texto || texto.length < 5) return; // ignora cosas muy cortas

    // mantener la misma noción de sesión/target (no forzamos nueva sesión)
    // pero podrías hacer nuevaSesion(activeEl) si deseas separar flujos.

    // pedir al backend
    const response = await fetch("http://127.0.0.1:5000/analizar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto })
    });
    const data = await response.json();

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

    if (ultimoTipoDetectado && ultimoTipoDetectado !== tipo) {
      resetOmisionesAlCambiarTipo(tipo);
    }

    ultimosMatches = detectarMatches(texto, tipo);
    const { vulnerabilidad, recomendacion } = mensajesPorTipo(tipo);
    ultimoTipoDetectado = tipo;
    const titulo = `⚠ ${tipo.toUpperCase()} detectado (copiado)`;

    // Reemplazo: cerrar aunque haya hover para evitar superposición
    mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo });

  } catch (e) {
    console.warn("copy-listener error:", e);
  }
});


async function onUserInput(event) {
  const target = event.target;

  if (!state.activo || !paginaHabilitada()) return;
  if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") return;

  const texto = (target.value || "").trim();
  if (texto.length < 10) {
    if (ultimoTarget !== target) nuevaSesion(target);
    // Cierre inmediato aunque esté en hover (ya no expone)
    limpiarAviso({ respectHover: false });
    return;
  }

  if (ultimoTarget !== target) {
    nuevaSesion(target);
  }

  try {
    const response = await fetch("http://127.0.0.1:5000/analizar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto })
    });

    const data = await response.json();

    // Backend minimal: { expone: boolean, tipo: "dni"|"correo"|"nombre"|"tarjeta"|null }
    const expone = !!data?.expone;
    let tipo = data?.tipo || "";
    if (expone && (!tipo || !state.tipos?.[tipo])) {
      tipo = detectarTipoDato(texto); // fallback local
    }

    // DEBUG
    console.log("[BACKEND]", data, "| expone:", expone, "| tipo:", tipo);

    // Cierres que deben ser inmediatos (ignoran hover)
    if (!expone || !tipo || tipo === "ninguno") {
      limpiarAviso({ respectHover: false });
      return;
    }
    if (!state.tipos?.[tipo]) {
      limpiarAviso({ respectHover: false });
      return;
    }
    if (silenciadoPorOmitir(tipo, target)) {
      limpiarAviso({ respectHover: false });
      return;
    }

    if (ultimoTipoDetectado && ultimoTipoDetectado !== tipo) {
      resetOmisionesAlCambiarTipo(tipo);
    }

    ultimosMatches = detectarMatches(texto, tipo);
    const { vulnerabilidad, recomendacion } = mensajesPorTipo(tipo);
    ultimoTipoDetectado = tipo;
    const titulo = `⚠ ${tipo.toUpperCase()} detectado`;

    // Reemplazo: cerramos aunque el mouse esté encima (evita superposiciones)
    mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo });

  } catch (err) {
    console.error("Error al conectar con el backend:", err);
  }
}

// ========= Detecciones / ejemplos / enmascarado =========
function detectarTipoDato(texto) {
  texto = (texto || "").toLowerCase();
  if (/\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/.test(texto)) return "correo";
  if (/\b\d{7,9}\b/.test(texto)) return "dni";
  if (/\b(?:\d[ \-]?){13,19}\b/.test(texto)) return "tarjeta";
  if (/\b(?!.*[@\d])([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}){1,3})\b/.test(texto)) return "nombre";
  return "ninguno";
}
function detectarMatches(texto, tipo) {
  if (!texto) return [];
  let re;
  switch (tipo) {
    case "correo":  re = /\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/gi; break;
    case "dni":     re = /\b\d{7,9}\b/g; break;
    case "tarjeta": re = /\b(?:\d[ \-]?){13,19}\b/g; break; // sin Luhn aquí
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
    default:
      return { vulnerabilidad: "Dato potencialmente sensible detectado.", recomendacion: "Evita compartir información personal en espacios públicos." };
  }
}
function ejemplosEnmascarados(tipo) {
  switch (tipo) {
    case "correo":  return ["j***@correo.com", "m*****.p****@dominio.pe", "u*****+promo@ejemplo.org"];
    case "dni":     return ["******12", "*****834", "******90"];
    case "tarjeta": return ["**** **** **** 1234", "****-****-****-9876", "************4321"];
    case "nombre":  return [];
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
}

// ========= UI del aviso + historial =========
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
    try { avisoActivo.remove(); } catch {}
    avisoActivo = null;
  }
  avisoPendiente = null;
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

function mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo }) {
  // Reemplazo: cerramos aunque el mouse esté encima (evita superposiciones)
  limpiarAviso({ respectHover: false });

  const aviso = document.createElement("div");
  aviso.classList.add("aviso-proteccion");
  aviso.setAttribute("id", "aviso-proteccion");

  // Tooltip para "Vulnerabilidad"
  const tooltipIcon = `<span title="Punto débil por donde pueden robar tus datos" style="cursor:help;margin-left:6px;">🛈</span>`;

  aviso.innerHTML = `
    <strong style="font-size:16px;display:block;margin-bottom:6px;">${titulo}</strong>
    <p style="margin:0 0 8px 0"><b>Vulnerabilidad${tooltipIcon}:</b><br>${vulnerabilidad}</p>
    <p style="margin:0 0 12px 0"><b>Recomendación:</b><br>${recomendacion}</p>

    <div class="acciones-inferiores" id="acciones-inferiores" style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:8px;">
      <button id="btn-omitir" type="button">Omitir</button>
      <button id="btn-aceptar" type="button">Aceptar</button>
    </div>

    <div id="zona-extra" style="margin-top:10px;display:none;">
      <button id="btn-ver-ejemplos" type="button" style="margin-bottom:8px; width:100%;">Ver ejemplos</button>
      <div id="contenedor-ejemplos" style="display:none; font-family:monospace; font-size:13px; margin-bottom:8px;"></div>
      <div id="zona-enmascarar" style="display:none;">
        <button id="btn-enmascarar" type="button" style="width:100%;">Enmascarar detectado</button>
      </div>
    </div>
  `;

  Object.assign(aviso.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    width: "360px",
    backgroundColor: "#FFE100",
    color: "#222",
    padding: "12px 14px",
    borderRadius: "12px",
    border: "1px solid #f0e2a0",
    boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    fontSize: "14px",
    zIndex: "2147483647"
  });

  const styleBtnBase = {
    flex: "1 1 0",
    padding: "10px 12px",
    borderRadius: "30px",
    border: "1px solid #dcdcdc",
    background: "#fff",
    cursor: "pointer",
    fontWeight: "600"
  };
  const styleBtnAceptar = { ...styleBtnBase, background: "linear-gradient(to bottom, #D400FF, #2600FF)", color: "#fff" };
  const styleBtnOmitir  = { ...styleBtnBase, background: "linear-gradient(to bottom, #D400FF, #FF0004)", color: "#fff" };

  document.body.appendChild(aviso);
  avisoActivo = aviso;

  // AUTOCIERRE con pausa por hover + tope duro
  aviso.addEventListener("mouseenter", stopAutoClose);
  aviso.addEventListener("mouseleave", startAutoClose);
  startAutoClose();

  // Estado del aviso visible (para “ignorar” si se cierra solo)
  avisoPendiente = { tipo, sesion: sesionEntrada, actionTomada: false };

  // Bind de botones
  const btnOmitir = aviso.querySelector("#btn-omitir");
  const btnAceptar = aviso.querySelector("#btn-aceptar");
  const accionesInferiores = aviso.querySelector("#acciones-inferiores");
  const zonaExtra = aviso.querySelector("#zona-extra");
  const btnVerEjemplos = aviso.querySelector("#btn-ver-ejemplos");
  const contEjemplos = aviso.querySelector("#contenedor-ejemplos");
  const zonaEnmascarar = aviso.querySelector("#zona-enmascarar");
  const btnEnmascarar = aviso.querySelector("#btn-enmascarar");

  Object.assign(btnOmitir.style, styleBtnOmitir, { border: "none" });
  Object.assign(btnAceptar.style, styleBtnAceptar, { border: "none" });

  Object.assign(btnVerEjemplos.style, {
    padding: "10px 12px",
    borderRadius: "10px",
    border: "1px solid #dcdcdc",
    background: "#fff",
    cursor: "pointer",
    fontWeight: "600"
  });
  Object.assign(btnEnmascarar.style, {
    padding: "10px 12px",
    borderRadius: "10px",
    border: "1px solid #dcdcdc",
    background: "#ffe9b3",
    cursor: "pointer",
    fontWeight: "600"
  });

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

    await registrarAccionYCerrar("omitir", { forceClose: true });
  });

  // Aceptar (robusto)
  btnAceptar.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopAutoClose();

    const pend = avisoPendiente;
    if (pend && !pend.actionTomada) {
      pend.actionTomada = true;
      await guardarHistorialEntrada({ tipo, accion: "aceptar" });
    }

    zonaExtra.style.display = "block";
    if (accionesInferiores) accionesInferiores.style.display = "none";

    const puedeEnmascarar = ["correo", "dni", "tarjeta"].includes(tipo) && ultimosMatches.length > 0;
    zonaEnmascarar.style.display = puedeEnmascarar ? "block" : "none";

    // Cierre de cortesía 5s después de aceptar si no tocan nada más
    clearTimeout(postAceptarTimerId);
    postAceptarTimerId = setTimeout(() => {
      limpiarAviso({ respectHover: false });
    }, 5000);
  });

  btnVerEjemplos.addEventListener("click", () => {
    const ejemplos = ejemplosEnmascarados(tipo);
    contEjemplos.innerHTML = ejemplos.length
      ? ejemplos.map(e => `<div>• ${e}</div>`).join("")
      : "<div>No hay ejemplos para este tipo.</div>";
    contEjemplos.style.display = "block";
  });

  btnEnmascarar.addEventListener("click", () => {
    if (ultimoTarget && ultimoTipoDetectado) {
      enmascararValorEnInput(ultimoTarget, ultimoTipoDetectado);
      const ok = document.createElement("div");
      ok.textContent = "✅ Datos enmascarados en el campo.";
      Object.assign(ok.style, { marginTop: "8px", fontSize: "13px", color: "#0a7a36", fontWeight: "600" });
      aviso.appendChild(ok);
      setTimeout(() => limpiarAviso({ respectHover: false }), 2000);
    }
  });
}
