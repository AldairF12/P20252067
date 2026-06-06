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

// Referencia al select de posición
const selectPosicion = document.getElementById("posicion-alerta");

// AÑADIDO: Referencia al select de tema
const selectTheme = document.getElementById("theme-select");

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

// --- AÑADIDO: Función para aplicar el tema ---
function aplicarTema(theme) {
  let temaFinal = theme;
  if (theme === 'system') {
    // Revisa la preferencia del OS
    const prefiereOscuro = window.matchMedia('(prefers-color-scheme: dark)').matches;
    temaFinal = prefiereOscuro ? 'dark' : 'light';
  }

  if (temaFinal === 'dark') {
    document.body.classList.add('dark-theme');
    document.body.classList.remove('light-theme');
  } else {
    document.body.classList.add('light-theme');
    document.body.classList.remove('dark-theme');
  }
}

// Init UI desde storage
document.addEventListener("DOMContentLoaded", async () => {
  // MODIFICADO: Añadido "theme" y "posicionAlerta"
  const { activo, paginas, tipos, posicionAlerta, theme } = await chrome.storage.local.get([
    "activo",
    "paginas",
    "tipos",
    "posicionAlerta",
    "theme"
  ]);

  // Toggle
  const isActive = activo !== false;
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
  
  // Cargar la posición guardada
  if (selectPosicion) {
    selectPosicion.value = posicionAlerta ?? "bottom-right";
  }
  
  // AÑADIDO: Cargar y aplicar el tema guardado
  if (selectTheme) {
    const savedTheme = theme ?? "system";
    selectTheme.value = savedTheme;
    aplicarTema(savedTheme);
  }

  // Contador diario
  actualizarContadorDiario();
});

// Reactualizar contador si cambia el storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.historialAvisos) {
    actualizarContadorDiario();
  }
  // AÑADIDO: Escucha cambios de tema desde otras pestañas
  if (area === "local" && changes.theme) {
    const newTheme = changes.theme.newValue ?? "system";
    selectTheme.value = newTheme;
    aplicarTema(newTheme);
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

// Guardar la posición al cambiar
if (selectPosicion) {
  selectPosicion.addEventListener("change", async () => {
    const nuevaPosicion = selectPosicion.value;
    await chrome.storage.local.set({ posicionAlerta: nuevaPosicion });
  });
}

// AÑADIDO: Guardar y aplicar el tema al cambiar
if (selectTheme) {
  selectTheme.addEventListener("change", async () => {
    const nuevoTema = selectTheme.value;
    await chrome.storage.local.set({ theme: nuevoTema });
    aplicarTema(nuevoTema);
  });
}

// Botones de navegación
document.getElementById("guia").addEventListener("click", () => {
  const url = chrome.runtime.getURL("onboarding/guia_inicial.html");
  chrome.tabs.create({ url });
});

document.getElementById("historial").addEventListener("click", () => {
  const url = chrome.runtime.getURL("historial/historial.html");
  chrome.tabs.create({ url });
});