const HIST_KEY = "historialAvisos";

/* Mensajes por tipo */
function mensajesPorTipo(tipo){
  switch (tipo){
    case "correo":  return { aviso:"Correo expuesto",          vuln:"Exposición de datos personales (correo).",  reco:"Enmascara o evita publicar tu correo en espacios públicos." };
    case "dni":     return { aviso:"DNI detectado",             vuln:"Número de DNI expuesto.",                  reco:"No compartas tu DNI en foros o chats." };
    case "tarjeta": return { aviso:"Posible número de tarjeta", vuln:"Patrón de tarjeta detectado.",             reco:"Nunca escribas números de tarjeta en campos no seguros." };
    case "nombre":  return { aviso:"Nombre real detectado",     vuln:"Exposición de nombre.",                    reco:"Evita publicar tu nombre completo en contextos públicos." };
    default:        return { aviso:"Dato sensible detectado",   vuln:"Dato potencialmente sensible.",            reco:"Evita compartir información personal en público." };
  }
}

/* Agrupador Hoy/Ayer/Fecha */
function etiquetaGrupo(iso){
  const d = new Date(iso);
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const ay  = new Date(hoy); ay.setDate(hoy.getDate()-1);
  const f0  = new Date(d);   f0.setHours(0,0,0,0);
  if (f0.getTime() === hoy.getTime()) return "Hoy";
  if (f0.getTime() === ay.getTime())  return "Ayer";
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}
function hostDe(url){ try{ return new URL(url).hostname; }catch{ return "sitio"; } }

/* Estado → clase / texto */
function claseEstado(accion){
  if (accion === "aceptar") return "estado-verde";
  if (accion === "omitir")  return "estado-amarillo";
  return "estado-blanco";
}
function textoEstado(accion){
  if (accion === "aceptar") return "Resuelto";
  if (accion === "omitir")  return "Omitido";
  return "Sin respuesta";
}

/* Render principal */
function render(){
  chrome.storage.local.get(HIST_KEY, (obj)=>{
    const arr = Array.isArray(obj[HIST_KEY]) ? obj[HIST_KEY] : [];
    arr.sort((a,b)=> new Date(b.ts) - new Date(a.ts));

    const grupos = new Map();
    for (const it of arr){
      const g = etiquetaGrupo(it.ts || new Date().toISOString());
      if(!grupos.has(g)) grupos.set(g, []);
      grupos.get(g).push(it);
    }

    const wrap = document.getElementById("groups");
    wrap.innerHTML = "";
    const tplG = document.getElementById("tpl-group");
    const tplC = document.getElementById("tpl-card");

    for (const [titulo, items] of grupos.entries()){
      const nodeG = tplG.content.cloneNode(true);
      nodeG.querySelector(".group-title").textContent = titulo;
      const cards = nodeG.querySelector(".cards");

      for (const it of items){
        const nodeC = tplC.content.cloneNode(true);
        const card  = nodeC.querySelector(".card");

        card.classList.remove("estado-verde","estado-amarillo","estado-blanco");
        card.classList.add(claseEstado(it.accion));

        nodeC.querySelector(".pill-action").textContent = textoEstado(it.accion);
        nodeC.querySelector(".pill-type").textContent   = (it.tipo || "TIPO").toUpperCase();

        const msg = mensajesPorTipo(it.tipo);
        const host = it.host || hostDe(it.url || "");
        nodeC.querySelector(".aviso").textContent = `${msg.aviso} en ${host}`;
        nodeC.querySelector(".vuln").textContent  = msg.vuln;
        nodeC.querySelector(".recom").textContent = msg.reco;

        nodeC.querySelector(".estado-text").textContent = textoEstado(it.accion);

        const a = nodeC.querySelector(".link");
        a.href = it.url || "about:blank";
        a.textContent = `Ir al sitio web: ${host}`;

        cards.appendChild(nodeC);
      }

      wrap.appendChild(nodeG);
    }

    if (!arr.length){
      const empty = document.createElement("div");
      empty.className = "group";
      empty.innerHTML = `<p style="margin:6px;color:#444">Aún no hay detecciones. Cuando aceptes, omitas o ignores un aviso, aparecerá aquí.</p>`;
      wrap.appendChild(empty);
    }
  });
}

/* Modal de privacidad */
function openPrivacy(){
  document.getElementById("privacy-overlay").hidden = false;
  document.getElementById("privacy-modal").hidden = false;
  document.body.style.overflow = "hidden";
}
function closePrivacy(){
  document.getElementById("privacy-overlay").hidden = true;
  document.getElementById("privacy-modal").hidden = true;
  document.body.style.overflow = "";
}

document.addEventListener("DOMContentLoaded", ()=>{
  render();

  // Botones
  document.getElementById("btn-privacidad").addEventListener("click", openPrivacy);
  document.getElementById("btn-priv-aceptar").addEventListener("click", closePrivacy);
  document.getElementById("privacy-overlay").addEventListener("click", closePrivacy);

  document.getElementById("btn-acerca").addEventListener("click", ()=>{
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  });
  document.getElementById("btn-reset").addEventListener("click", ()=>{
    if (!confirm("¿Borrar todo el historial de detecciones?")) return;
    chrome.storage.local.set({ [HIST_KEY]: [] }, render);
  });
});
