const toggle = document.getElementById("toggle");
const estadoLabel = document.getElementById("estado-label");

// Efecto Linterna interactivo
document.addEventListener("mousemove", e => {
  document.querySelectorAll(".interactive-card").forEach(card => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    card.style.setProperty("--mouse-x", `${x}px`);
    card.style.setProperty("--mouse-y", `${y}px`);
  });
});

// Helpers de Fecha
function hoyYYYYMMDD(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Lógica de contadores y gráfico
async function actualizarContadores() {
  try {
    const { historialAvisos } = await chrome.storage.local.get("historialAvisos");
    const arr = Array.isArray(historialAvisos) ? historialAvisos : [];
    
    // Preparar últimos 7 días
    const dateStrings = [];
    for(let i=6; i>=0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dateStrings.push(hoyYYYYMMDD(d));
    }
    const daysCounts = [0,0,0,0,0,0,0];
    
    let countSemanaTotal = 0;

    for (const it of arr) {
      if (!it.ts) continue;
      const tsStr = it.ts.substring(0, 10);
      const idx = dateStrings.indexOf(tsStr);
      if (idx !== -1) {
        daysCounts[idx]++;
        countSemanaTotal++;
      }
    }

    const countHoy = daysCounts[6];
    
    const statHoy = document.getElementById("statHoy");
    const statSemana = document.getElementById("statSemana");
    if (statHoy) statHoy.textContent = countHoy;
    if (statSemana) statSemana.textContent = countSemanaTotal;

    // Dibujar gráfico
    const graficoSemana = document.getElementById("graficoSemana");
    if (graficoSemana) {
      graficoSemana.innerHTML = "";
      const maxCount = Math.max(...daysCounts, 1);
      
      daysCounts.forEach((count, i) => {
        const percentage = (count / maxCount) * 100;
        const h = Math.max(8, percentage); // min height 8%
        const isToday = i === 6;
        const bar = document.createElement("div");
        bar.className = `bar-col ${isToday ? "active-bar" : ""}`;
        bar.style.height = `${h}%`;
        bar.title = `${dateStrings[i]}: ${count} avisos`;
        graficoSemana.appendChild(bar);
      });
    }

  } catch (e) {
    console.warn("Error leyendo historial para contadores:", e);
  }
}

// Ubicación Visual y Dropdown
const locSelect = document.getElementById("posicion-alerta-select");
const locAlertSim = document.getElementById("loc-alert-sim");
const locCorners = document.querySelectorAll(".loc-corner");

function setUbicacionVisual(pos) {
  if(locAlertSim) locAlertSim.setAttribute("data-pos", pos);
  if(locSelect) locSelect.value = pos;
}

if(locSelect) {
  locSelect.addEventListener("change", async () => {
    const pos = locSelect.value;
    setUbicacionVisual(pos);
    await chrome.storage.local.set({ posicionAlerta: pos });
  });
}

locCorners.forEach(corner => {
  corner.addEventListener("click", async () => {
    const pos = corner.getAttribute("data-pos");
    setUbicacionVisual(pos);
    await chrome.storage.local.set({ posicionAlerta: pos });
  });
});

// Tema Visual
const themeBtns = document.querySelectorAll(".theme-btn");

function applyTheme(theme) {
  themeBtns.forEach(b => b.classList.remove("active"));
  const btn = Array.from(themeBtns).find(b => b.getAttribute("data-theme") === theme);
  if (btn) btn.classList.add("active");

  document.body.classList.remove("theme-light");
  if (theme === "light") {
    document.body.classList.add("theme-light");
  } else if (theme === "system") {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.body.classList.add("theme-light");
    }
  }
}

themeBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const t = btn.getAttribute("data-theme");
    applyTheme(t);
    await chrome.storage.local.set({ theme: t });
  });
});

// Inicialización
document.addEventListener("DOMContentLoaded", async () => {
  const { activo, paginas, tipos, modoCompacto, posicionAlerta, theme } = await chrome.storage.local.get([
    "activo", "paginas", "tipos", "modoCompacto", "posicionAlerta", "theme"
  ]);

  const isActive = activo !== false;
  if(toggle) toggle.checked = isActive;
  if(estadoLabel) estadoLabel.textContent = isActive ? "Privacidad Activa" : "Privacidad Inactiva";
  document.body.setAttribute("data-activo", isActive);

  // Selector visual de ubicación
  setUbicacionVisual(posicionAlerta || "bottom-right");
  
  // Tema visual
  applyTheme(theme || "system");

  // Restaurar Compacto
  const chkCompacto = document.getElementById("tp-compacto");
  if (chkCompacto) {
    chkCompacto.checked = modoCompacto ?? false;
    chkCompacto.addEventListener("change", async () => {
      await chrome.storage.local.set({ modoCompacto: chkCompacto.checked });
    });
  }

  // Restaurar Checkboxes
  const mapper = {
    "pg-steam": ["paginas", "steam", true],
    "pg-roblox": ["paginas", "roblox", true],
    "pg-epic": ["paginas", "epic", true],
    "pg-discord": ["paginas", "discord", true],
    "tp-correo": ["tipos", "correo", true],
    "tp-nombre": ["tipos", "nombre", true],
    "tp-tarjeta": ["tipos", "tarjeta", true],
    "tp-dni": ["tipos", "dni", true],
    "tp-celular": ["tipos", "celular", true],
    "tp-edad": ["tipos", "edad", true],
    "tp-ubicacion": ["tipos", "ubicacion", true],
    "tp-enlace": ["tipos", "enlace_sospechoso", true]
  };

  for (const [id, [group, key, def]] of Object.entries(mapper)) {
    const el = document.getElementById(id);
    if (!el) continue;
    
    let isChecked = def;
    if (group === "paginas" && paginas && paginas[key] !== undefined) isChecked = paginas[key];
    if (group === "tipos" && tipos && tipos[key] !== undefined) isChecked = tipos[key];
    
    el.checked = isChecked;

    el.addEventListener("change", async () => {
      const data = await chrome.storage.local.get(group);
      const current = data[group] || {};
      await chrome.storage.local.set({ [group]: { ...current, [key]: el.checked } });
    });
  }

  actualizarContadores();
});

// Listener del interruptor maestro
if (toggle) {
  toggle.addEventListener("change", async () => {
    const active = toggle.checked;
    if(estadoLabel) estadoLabel.textContent = active ? "Privacidad Activa" : "Privacidad Inactiva";
    document.body.setAttribute("data-activo", active);
    await chrome.storage.local.set({ activo: active });
  });
}

// Enlaces de navegación
document.getElementById("historial")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("historial/historial.html") });
});
document.getElementById("guia")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/guia_inicial.html") });
});