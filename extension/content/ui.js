/* === content/ui.js: Interfaz de Usuario y Alertas === */

(function inyectarFuentes() {
  if (document.getElementById('priv-fonts')) return;
  const style = document.createElement('style');
  style.id = 'priv-fonts';
  const urlSpace = chrome.runtime.getURL('fonts/SpaceGrotesk-VariableFont_wght.ttf');
  const urlBlackOps = chrome.runtime.getURL('fonts/BlackOpsOne-Regular.ttf');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Black+Ops+One&family=Space+Grotesk:wght@300;600;700&display=swap');
    
    @font-face {
      font-family: 'Space Grotesk';
      src: local('Space Grotesk'), url('${urlSpace}') format('truetype');
      font-weight: 300 700;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Black Ops One';
      src: local('Black Ops One'), url('${urlBlackOps}') format('truetype');
      font-weight: normal;
      font-style: normal;
      font-display: swap;
    }
  `;
  if (document.head) document.head.appendChild(style);
  else document.documentElement.appendChild(style);
})();

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

  if (avisoPendiente?.tipo === "logout") {
    try { hu23_sessionRemove("HU23_PENDING_NOTE"); } catch {}
  }

  clearTimers();

  if (avisoActivo) {
    const el = avisoActivo;
    avisoActivo = null; // liberamos para no bloquear siguientes
    el.classList.add("closing");
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
// ============ FUNCIÓN mostrarAviso UNIFICADA =============
//    (con posición + tema + historial + enmascarado)
// ==========================================================
async function mostrarAviso(titulo, vulnerabilidad, recomendacion, options = {}) {
  const tipo = options.tipo || "";
  const isFile = options.isFile || false;
  const hideButtons = options.hideButtons || false;
  const btnAceptarText = options.btnAceptarText || "Aceptar";
  const btnOmitirText = options.btnOmitirText || "Omitir";

  // Reemplazo: cerramos aunque el mouse esté encima (evita superposiciones)
  limpiarAviso({ respectHover: false });

  const aviso = document.createElement("div");
  aviso.className = "priv-alert";
  aviso.setAttribute("id", "aviso-proteccion");

  // Tooltip SVG Icon
  const tooltipIcon = `<span title="Punto débil por donde pueden robar tus datos" style="cursor:help;margin-left:4px;opacity:0.75;font-size:13px;color:var(--accent);">🔍</span>`;

  aviso.innerHTML = `
    <div class="priv-alert-compact-icon">
      <svg class="priv-alert-shield" style="animation: priv-draw-svg 3s infinite cubic-bezier(0.4, 0, 0.2, 1), priv-glow-pulse 2s infinite ease-in-out;" viewBox="0 0 24 24" fill="none" stroke="#00ffaa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="100" stroke-dashoffset="100">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <div class="priv-alert-badge">1</div>
    </div>

    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
      <strong style="font-size:16px; font-weight:normal; font-family:'Black Ops One', sans-serif !important; letter-spacing: 1px; color: var(--accent); text-shadow: 0 0 10px var(--title-glow-1), 0 0 20px var(--title-glow-2); text-transform: uppercase;">${titulo}</strong>
      <button class="priv-alert-close" id="btn-cerrar-aviso" type="button" style="background:transparent; border:none; color:inherit; opacity:0.6; font-size:24px; cursor:pointer; line-height:1; padding:0; margin-top:-4px; transition: all 0.2s;">&times;</button>
    </div>
    <p style="font-size:14px; color:var(--text-main); margin:0 0 8px 0; font-weight:600; font-family:'Space Grotesk', sans-serif;">
      Vulnerabilidad${tooltipIcon}:<br>
      <span style="font-weight:400; color:var(--text-sub); display:inline-block; margin-top:3px; line-height:1.4;">${vulnerabilidad}</span>
    </p>
    <p style="font-size:14px; color:var(--text-main); margin:0 0 16px 0; font-weight:600; font-family:'Space Grotesk', sans-serif;">
      Recomendación:<br>
      <span style="font-weight:400; color:var(--text-sub); display:inline-block; margin-top:3px; line-height:1.4;">${recomendacion}</span>
    </p>
    
    <div class="acciones-inferiores" id="acciones-inferiores" style="display:flex; gap:10px; align-items:center;">
      <button class="priv-alert-btn priv-alert-btn-omitir" id="btn-omitir" type="button">${btnOmitirText}</button>
      <button class="priv-alert-btn priv-alert-btn-aceptar" id="btn-aceptar" type="button">${btnAceptarText}</button>
    </div>
    
    <div id="zona-extra" style="margin-top:12px; display:none;">
      <button class="priv-alert-btn priv-alert-btn-neutral" id="btn-ver-ejemplos" type="button" style="width:100%; margin-bottom:10px;">Ver ejemplos</button>
      <div id="contenedor-ejemplos" style="display:none; font-family:monospace; font-size:13px; color:var(--text-main); margin-bottom:10px; padding:10px; background:rgba(255,255,255,0.05); border-radius:8px; border:1px solid rgba(255,255,255,0.1);"></div>
      <div id="zona-enmascarar" style="display:none;">
        <button class="priv-alert-btn priv-alert-btn-neutral" id="btn-enmascarar" type="button" style="width:100%; display:flex; justify-content:center; align-items:center; gap:6px;">
          <svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
          Enmascarar detectado
        </button>
      </div>
    </div>
  `;

  // --- INICIO DE LÓGICA DE TEMA Y POSICIÓN ---
  const { posicionAlerta, theme, modoCompacto } = await chrome.storage.local.get(["posicionAlerta", "theme", "modoCompacto"]);

  const posicion = posicionAlerta ?? "bottom-right";
  const estilosPosicion = {
    "bottom-right": { bottom: "24px", right: "24px", left: "auto", top: "auto" },
    "bottom-left": { bottom: "24px", left: "24px", right: "auto", top: "auto" },
    "top-right": { top: "24px", right: "24px", left: "auto", bottom: "auto" },
    "top-left": { top: "24px", left: "24px", right: "auto", bottom: "auto" }
  };

  let temaFinal = theme ?? "system";
  if (temaFinal === "system") {
    temaFinal = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  aviso.className = `priv-alert ${temaFinal === "dark" ? "priv-alert-dark" : "priv-alert-light"}`;
  
  if (modoCompacto) {
    aviso.classList.add("force-compact");
  }

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

  aviso.addEventListener("mousedown", (e) => e.preventDefault());

  if (ultimoTarget) {
    blurListenerActual = () => {
      if (ignorarEventosProgramaticos) return;
      setTimeout(() => {
        if (document.activeElement !== ultimoTarget) {
          if (!avisoPendiente?.isFile) limpiarAviso({ respectHover: false });
        }
      }, 150);
    };
    ultimoTarget.addEventListener("blur", blurListenerActual);
  }

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

  const urlDestino = options.urlDestino || null;
  avisoPendiente = { tipo, sesion: sesionEntrada, actionTomada: false, isFile, urlDestino };

  const btnCerrar = aviso.querySelector("#btn-cerrar-aviso");
  const btnOmitir = aviso.querySelector("#btn-omitir");
  const btnAceptar = aviso.querySelector("#btn-aceptar");
  const accionesInferiores = aviso.querySelector("#acciones-inferiores");
  const zonaExtra = aviso.querySelector("#zona-extra");
  const btnVerEjemplos = aviso.querySelector("#btn-ver-ejemplos");
  const contEjemplos = aviso.querySelector("#contenedor-ejemplos");
  
  if (accionesInferiores) {
    accionesInferiores.style.display = hideButtons ? "none" : "flex";
  }
  const zonaEnmascarar = aviso.querySelector("#zona-enmascarar");
  const btnEnmascarar = aviso.querySelector("#btn-enmascarar");

  btnCerrar.addEventListener("click", () => limpiarAviso({ respectHover: false }));

  function mostrarEstadoResuelto(texto = "Resuelto", estado = "success", ocultarExtra = true) {
    accionResueltaVisualmente = true;
    
    if (estado === "success") {
      aviso.classList.add("state-resolved-success");
      aviso.style.setProperty("--text-main", "var(--text-success)");
      aviso.style.setProperty("--text-sub", "var(--text-success)");
      aviso.style.setProperty("--icon-warn", "var(--text-success)");
    } else if (estado === "ignored") {
      aviso.classList.add("state-resolved-ignored");
      aviso.style.setProperty("--text-main", "var(--text-ignored)");
      aviso.style.setProperty("--text-sub", "var(--text-ignored)");
      aviso.style.setProperty("--icon-warn", "var(--text-ignored)");
    }

    if (ocultarExtra && zonaExtra) zonaExtra.style.display = "none";
    
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
      if (avisoActivo && avisoActivo.matches(':hover')) return;
      limpiarAviso({ respectHover: false });
      setTimeout(() => procesarSiguienteDeLaCola(), 350);
    }, 4500);
  }

  btnOmitir.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopAutoClose();

    omitidosRuntime.set(tipo, {
      until: Date.now() + OMIT_MS,
      sesion: sesionEntrada,
      input: ultimoTarget
    });

    await registrarAccionYCerrar("omitir", { forceClose: false });
    mostrarEstadoResuelto("Omitido", "ignored", true);
  });

  btnAceptar.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopAutoClose();

    omitidosRuntime.set(tipo, {
      until: Date.now() + OMIT_MS,
      sesion: sesionEntrada,
      input: ultimoTarget
    });

    const pend = avisoPendiente;
    if (pend && !pend.actionTomada) {
      pend.actionTomada = true;
      await guardarHistorialEntrada({ tipo, accion: "aceptar" });
    }

    if (tipo === "logout") {
      try { await chrome.runtime.sendMessage({ type: "HU23_OPEN_CLEAR_SETTINGS" }); } catch { }
      limpiarAviso({ respectHover: false });
      return;
    }

    if (pend && pend.urlDestino) {
      window.open(pend.urlDestino, '_blank');
    }

    const isFile = pend?.isFile || false;
    const puedeEnmascarar =
      !isFile &&
      ["correo", "dni", "tarjeta", "celular"].includes(tipo) &&
      ultimosMatches.length > 0 &&
      tipo !== "multiple_campos" &&
      ultimoTarget && typeof ultimoTarget.value === "string";

    const tieneEjemplos = ejemplosEnmascarados(tipo).length > 0;

    if (puedeEnmascarar || tieneEjemplos) {
      zonaExtra.style.display = "block";
      zonaExtra.style.transformOrigin = "top";
      zonaExtra.style.animation = "priv-expand 0.4s ease forwards";
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
    contEjemplos.style.transformOrigin = "top";
    contEjemplos.style.animation = "priv-expand 0.4s ease forwards";
  });

  btnEnmascarar.addEventListener("click", () => {
    if (ultimoTarget && typeof ultimoTarget.value === "string") {
      enmascararValorEnInput(ultimoTarget, tipo);
    }
    mostrarEstadoResuelto("✔ Enmascarado y Resuelto", "success", true);
  });
}
