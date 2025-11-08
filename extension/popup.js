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

// Contador
const contadorEl = document.querySelector(".contador");

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
    const hoy = hoyYYYYMMDD();
    // contar todo lo de hoy (aceptar/omitir/ignorar), sin filtrar por tipo
    const count = arr.filter(e => {
      if (!e || !e.ts) return false;
      const d = new Date(e.ts);
      if (isNaN(d)) return false;
      const ds = hoyYYYYMMDD(d);
      return ds === hoy;
    }).length;

    if (contadorEl) {
      contadorEl.textContent = `${count} ${plural(count, "aviso", "avisos")} hoy`;
    }
  } catch (e) {
    if (contadorEl) contadorEl.textContent = "0 avisos hoy";
  }
}

// Init UI desde storage
document.addEventListener("DOMContentLoaded", async () => {
  const { activo, paginas, tipos } = await chrome.storage.local.get(["activo","paginas","tipos"]);

  // Toggle
  const isActive = activo !== false; // por defecto true
  toggle.checked = isActive;
  estadoLabel.textContent = isActive ? "Extensión activada" : "Extensión desactivada";
  estadoLabel.style.color = isActive ? "green" : "red";

  // Páginas
  chkSteam.checked   = paginas?.steam   ?? true;
  chkRoblox.checked  = paginas?.roblox  ?? true;
  chkEpic.checked    = paginas?.epic    ?? true;
  chkDiscord.checked = paginas?.discord ?? true;

  // Tipos
  chkCorreo.checked  = tipos?.correo  ?? true;
  chkNombre.checked  = tipos?.nombre  ?? true;
  chkTarjeta.checked = tipos?.tarjeta ?? true;
  chkDni.checked     = tipos?.dni     ?? true;

  // Contador diario
  actualizarContadorDiario();
});

// Reactualizar contador si cambia el storage mientras el popup está abierto
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.historialAvisos) {
    actualizarContadorDiario();
  }
});

// Toggle activo
toggle.addEventListener("change", async () => {
  const active = toggle.checked;
  estadoLabel.textContent = active ? "Extensión activada" : "Extensión desactivada";
  estadoLabel.style.color = active ? "green" : "red";
  await chrome.storage.local.set({ activo: active });
});

// Guardar páginas
for (const [el, key] of [
  [chkSteam, "steam"],
  [chkRoblox, "roblox"],
  [chkEpic, "epic"],
  [chkDiscord, "discord"],
]) {
  el.addEventListener("change", async () => {
    const { paginas } = await chrome.storage.local.get("paginas");
    await chrome.storage.local.set({
      paginas: { steam: true, roblox: true, epic: true, discord: true, ...paginas, [key]: el.checked }
    });
  });
}

// Guardar tipos
for (const [el, key] of [
  [chkCorreo, "correo"],
  [chkNombre, "nombre"],
  [chkTarjeta, "tarjeta"],
  [chkDni, "dni"],
]) {
  el.addEventListener("change", async () => {
    const { tipos } = await chrome.storage.local.get("tipos");
    await chrome.storage.local.set({
      tipos: { correo: true, nombre: true, tarjeta: true, dni: true, ...tipos, [key]: el.checked }
    });
  });
}

document.getElementById("guia").addEventListener("click", () => {
  alert("📘 La extensión detecta posibles exposiciones de datos personales en las páginas habilitadas.");
});

// Botón historial (abre la página de historial)
  if (btnHistorial) {
    btnHistorial.addEventListener("click", () => {
      const url = chrome.runtime.getURL("historial/index.html");
      chrome.tabs.create({ url });
    });
  }

