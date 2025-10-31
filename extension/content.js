// content.js
let avisoActivo = null;
let ultimoTipoDetectado = null;
let ultimosMatches = [];
let ultimoTarget = null;

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

// Escuchar cambios desde popup/background y actualizar cache
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
  if (!key) return false; // seguridad extra
  return !!state.paginas[key];
}

// ====== Evento principal ======
document.addEventListener("input", async (event) => {
  const target = event.target;

  // Extensión desactivada o página no habilitada => no hacemos nada
  if (!state.activo || !paginaHabilitada()) return;

  // Sólo inputs y textareas
  if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") return;

  const texto = (target.value || "").trim();
  if (texto.length < 10) return;

  ultimoTarget = target;

  try {
    const response = await fetch("http://127.0.0.1:5000/analizar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto })
    });

    const data = await response.json();
    const expone = data?.prediccion
      ? data.prediccion === "Expone datos personales"
      : (data?.tipo && data.tipo !== "ninguno");

    let tipo = data?.tipo;
    if (!tipo || tipo === "otro") {
      tipo = detectarTipoDato(texto);
    }

    console.log(data);

    // Si no expone o tipo 'ninguno' => limpiar y salir
    if (!expone || tipo === "ninguno") {
      limpiarAviso();
      return;
    }

    // Si el tipo no está habilitado por el usuario => salir
    if (!state.tipos[tipo]) {
      limpiarAviso();
      return;
    }

    // Si el tipo fue omitido por el usuario => salir
    if (state.omitidos.includes(tipo)) {
      limpiarAviso();
      return;
    }

    // Construcción de aviso
    const { vulnerabilidad, recomendacion } = mensajesPorTipo(tipo);
    ultimoTipoDetectado = tipo;
    ultimosMatches = detectarMatches(texto, tipo);

    mostrarAviso("⚠ Aviso", vulnerabilidad, recomendacion, { tipo });

  } catch (err) {
    console.error("Error al conectar con el backend:", err);
  }
});

// ========= Detecciones / ejemplos / enmascarado (igual que antes) =========
function detectarTipoDato(texto) {
  texto = (texto || "").toLowerCase();
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(texto)) return "correo";
  if (/\b\d{8}\b/.test(texto)) return "dni";
  if (/\b(?:\d[ -]*?){13,16}\b/.test(texto)) return "tarjeta";
  if (/\b([a-záéíóúñ]{2,}\s){1,}[a-záéíóúñ]{2,}\b/.test(texto)) return "nombre";
  return "ninguno";
}
function detectarMatches(texto, tipo) {
  if (!texto) return [];
  let re;
  switch (tipo) {
    case "correo":  re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi; break;
    case "dni":     re = /\b\d{8}\b/g; break;
    case "tarjeta": re = /\b(?:\d[ -]*?){13,16}\b/g; break;
    case "nombre":  re = /\b([a-záéíóúñ]{2,}\s){1,}[a-záéíóúñ]{2,}\b/gi; break;
    default: return [];
  }
  return texto.match(re) || [];
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
    case "nombre":  return ["Juan P.", "M. García", "A. Rojas"];
    default: return [];
  }
}
function enmascararValorEnInput(input, tipo) {
  if (!input || !input.value) return;
  let nuevo = input.value;
  switch (tipo) {
    case "correo":
      nuevo = nuevo.replace(/[a-z0-9._%+-]+@/gi, (m) => {
        const [user] = m.split("@");
        const visible = user.slice(0, 1);
        return visible + "*".repeat(Math.max(3, user.length - 1)) + "@";
      });
      break;
    case "dni":
      nuevo = nuevo.replace(/\b(\d{6})(\d{2})\b/g, (_, a, b) => "*".repeat(a.length) + b);
      break;
    case "tarjeta":
      nuevo = nuevo.replace(/\b((?:\d[ -]*?){13,16})\b/g, (full) => {
        const digits = full.replace(/\D/g, "");
        const masked = "*".repeat(digits.length - 4) + digits.slice(-4);
        return masked.replace(/(.{4})/g, "$1 ").trim();
      });
      break;
    case "nombre":
    default:
      return;
  }
  input.value = nuevo;
}

// ========= UI del aviso (con “Omitir” usando chrome.storage) =========
function limpiarAviso() {
  if (avisoActivo) {
    avisoActivo.remove();
    avisoActivo = null;
  }
}

function mostrarAviso(titulo, vulnerabilidad, recomendacion, { tipo }) {
  limpiarAviso();

  const aviso = document.createElement("div");
  aviso.classList.add("aviso-proteccion");
  aviso.innerHTML = `
    <strong style="font-size:16px;display:block;margin-bottom:6px;">${titulo}</strong>
    <p style="margin:0 0 8px 0"><b>Vulnerabilidad:</b><br>${vulnerabilidad}</p>
    <p style="margin:0 0 12px 0"><b>Recomendación:</b><br>${recomendacion}</p>

    <div class="acciones-inferiores" style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:8px;">
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
    zIndex: "999999"
  });

  const styleBtnBase = {
    flex: "1 1 0",
    padding: "10px 12px",
    borderRadius: "10px",
    border: "1px solid #dcdcdc",
    background: "#fff",
    cursor: "pointer",
    fontWeight: "600"
  };

  document.body.appendChild(aviso);
  avisoActivo = aviso;

  const btnOmitir = aviso.querySelector("#btn-omitir");
  const btnAceptar = aviso.querySelector("#btn-aceptar");
  const zonaExtra = aviso.querySelector("#zona-extra");
  const btnVerEjemplos = aviso.querySelector("#btn-ver-ejemplos");
  const contEjemplos = aviso.querySelector("#contenedor-ejemplos");
  const zonaEnmascarar = aviso.querySelector("#zona-enmascarar");
  const btnEnmascarar = aviso.querySelector("#btn-enmascarar");

  Object.assign(btnOmitir.style, styleBtnBase, { background: "#fafafa" });
  Object.assign(btnAceptar.style, styleBtnBase, { background: "#ffef9f", borderColor: "#f2d241" });

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

  btnOmitir.addEventListener("click", async () => {
    const current = await chrome.storage.local.get("omitidos");
    const set = new Set(current.omitidos || []);
    set.add(tipo);
    await chrome.storage.local.set({ omitidos: Array.from(set) });
    limpiarAviso();
  });

  btnAceptar.addEventListener("click", () => {
    zonaExtra.style.display = "block";
    const puedeEnmascarar = ["correo", "dni", "tarjeta"].includes(tipo) && ultimosMatches.length > 0;
    zonaEnmascarar.style.display = puedeEnmascarar ? "block" : "none";
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
      setTimeout(() => limpiarAviso(), 2500);
    }
  });
}
