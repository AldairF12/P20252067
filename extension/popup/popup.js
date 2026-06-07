const toggle = document.getElementById("toggle");
const estadoLabel = document.getElementById("estado-label");

// Páginas
const chkSteam   = document.getElementById("pg-steam");
const chkRoblox  = document.getElementById("pg-roblox");
const chkEpic    = document.getElementById("pg-epic");
const chkDiscord = document.getElementById("pg-discord");

// Tipos
const chkCorreo  = document.getElementById("tp-correo");
const chkNombre  = document.getElementById("tp-nombre");
const chkTarjeta = document.getElementById("tp-tarjeta");
const chkDni     = document.getElementById("tp-dni");
const chkEdad    = document.getElementById("tp-edad");
const chkUbicacion = document.getElementById("tp-ubicacion");
const chkEnlace  = document.getElementById("tp-enlace");

const selectPosicion = document.getElementById("posicion-alerta");
const selectTheme    = document.getElementById("theme-select");
const contadorEl     = document.querySelector(".stat-num"); // Cambiado para hacer match con el rediseño

function hoyYYYYMMDD(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function plural(n, s, p) { return n === 1 ? s : p; }

async function actualizarContadorDiario() {
  try {
    const { historialAvisos } = await chrome.storage.local.get("historialAvisos");
    const arr = Array.isArray(historialAvisos) ? historialAvisos : [];
    const hoyStr = hoyYYYYMMDD();
    const countHoy = arr.filter(it => it.ts && it.ts.startsWith(hoyStr)).length;
    if (contadorEl) {
      contadorEl.textContent = countHoy;
    }
  } catch (e) {
    console.warn(e);
  }
}

function aplicarTema(tema) {
  if (tema === "dark") {
    document.body.classList.add("dark-theme");
  } else if (tema === "light") {
    document.body.classList.remove("dark-theme");
  } else {
    const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
    if (mqDark.matches) {
      document.body.classList.add("dark-theme");
    } else {
      document.body.classList.remove("dark-theme");
    }
  }
}

// Inicialización de la interfaz
document.addEventListener("DOMContentLoaded", async () => {
  const { activo, paginas, tipos, posicionAlerta, theme } = await chrome.storage.local.get([
    "activo", "paginas", "tipos", "posicionAlerta", "theme"
  ]);

  const isActive = activo !== false;
  toggle.checked = isActive;
  estadoLabel.textContent = isActive ? "Privacidad activa" : "Privacidad inactiva";
  
  // Sincronización instantánea del estado de color para el CSS
  document.body.setAttribute("data-activo", isActive);

  if (chkSteam) chkSteam.checked = paginas?.steam ?? true;
  if (chkRoblox) chkRoblox.checked = paginas?.roblox ?? true;
  if (chkEpic) chkEpic.checked = paginas?.epic ?? true;
  if (chkDiscord) chkDiscord.checked = paginas?.discord ?? true;

  if (chkCorreo) chkCorreo.checked = tipos?.correo ?? true;
  if (chkNombre) chkNombre.checked = tipos?.nombre ?? true;
  if (chkTarjeta) chkTarjeta.checked = tipos?.tarjeta ?? true;
  if (chkDni) chkDni.checked = tipos?.dni ?? true;
  if (chkEdad) chkEdad.checked = tipos?.edad ?? true;
  if (chkUbicacion) chkUbicacion.checked = tipos?.ubicacion ?? true;
  if (chkEnlace) chkEnlace.checked = tipos?.enlace_sospechoso ?? true;

  if (selectPosicion) selectPosicion.value = posicionAlerta ?? "bottom-right";

  if (selectTheme) {
    const t = theme ?? "system";
    selectTheme.value = t;
    aplicarTema(t);
  }

  actualizarContadorDiario();
});

// Listener del interruptor maestro
toggle.addEventListener("change", async () => {
  const active = toggle.checked;
  estadoLabel.textContent = active ? "Privacidad activa" : "Privacidad inactiva";
  
  // Cambia el color por CSS en 0 segundos
  document.body.setAttribute("data-activo", active);
  
  await chrome.storage.local.set({ activo: active });
});

// Guardar páginas autorizadas
for (const [el, key] of [
  [chkSteam, "steam"],
  [chkRoblox, "roblox"],
  [chkEpic, "epic"],
  [chkDiscord, "discord"],
]) {
  if (el) {
    el.addEventListener("change", async () => {
      const { paginas } = await chrome.storage.local.get("paginas");
      await chrome.storage.local.set({
        paginas: { steam: true, roblox: true, epic: true, discord: true, ...paginas, [key]: el.checked }
      });
    });
  }
}

// Guardar tipos de PII a interceptar
for (const [el, key] of [
  [chkCorreo, "correo"],
  [chkNombre, "nombre"],
  [chkTarjeta, "tarjeta"],
  [chkDni, "dni"],
  [chkEdad, "edad"],
  [chkUbicacion, "ubicacion"],
  [chkEnlace, "enlace_sospechoso"],
]) {
  if (el) {
    el.addEventListener("change", async () => {
      const { tipos } = await chrome.storage.local.get("tipos");
      await chrome.storage.local.set({
        tipos: {
          correo: true, nombre: true, tarjeta: true, dni: true,
          edad: true, ubicacion: true, enlace_sospechoso: true,
          ...tipos, [key]: el.checked
        }
      });
    });
  }
}

if (selectPosicion) {
  selectPosicion.addEventListener("change", async () => {
    await chrome.storage.local.set({ posicionAlerta: selectPosicion.value });
  });
}

if (selectTheme) {
  selectTheme.addEventListener("change", async () => {
    const nuevoTema = selectTheme.value;
    await chrome.storage.local.set({ theme: nuevoTema });
    aplicarTema(nuevoTema);
  });
}

// Enlaces de navegación
document.getElementById("historial").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("historial/historial.html") });
});

document.getElementById("guia").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/guia_inicial.html") });
});