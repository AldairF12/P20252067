const toggle = document.getElementById("toggle");
const estadoLabel = document.getElementById("estado-label");

toggle.addEventListener("change", () => {
  if (toggle.checked) {
    estadoLabel.textContent = "Extensión activada";
    estadoLabel.style.color = "green";
    chrome.storage.local.set({ activo: true });
  } else {
    estadoLabel.textContent = "Extensión desactivada";
    estadoLabel.style.color = "red";
    chrome.storage.local.set({ activo: false });
  }
});

document.getElementById("guia").addEventListener("click", () => {
  alert("📘 La extensión detecta posibles exposiciones de datos personales en las páginas habilitadas.");
});

document.getElementById("historial").addEventListener("click", () => {
  alert("📜 Aquí se mostrará el historial de avisos detectados (aún en desarrollo).");
});
