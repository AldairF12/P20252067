/* === content/detector.js: Lógica de Detección, ML y Regex === */

// ====== Capa ML (modelo ONNX en la propia extensión) ======
let mlModulePromise = null;

async function analizarTextoML(texto) {
  // Carga perezosa del módulo de inferencia
  console.log("analizar con el inference");
  if (!mlModulePromise) {
    mlModulePromise = import(chrome.runtime.getURL("ml/inference.js"));
  }
  const { analizarTextoConModelo } = await mlModulePromise;
  return analizarTextoConModelo(texto);
}

// ================= Corrección post-ML: regex como árbitro final =================
// El modelo NLP a veces confunde celular/DNI con correo u otras clases.
// Esta función aplica regex deterministas para corregir clasificaciones erróneas.
function aplicarReglaCorreoTarjeta(texto, { expone, tipo }) {
  REGEX_CORREO.lastIndex  = 0;
  REGEX_CELULAR.lastIndex = 0;
  REGEX_DNI.lastIndex     = 0;
  REGEX_TARJETA.lastIndex = 0;

  const hayCorreo  = REGEX_CORREO.test(texto);
  const hayCelular = REGEX_CELULAR.test(texto);
  // Importante: Si es un celular, NO es un DNI, incluso si contiene 8 dígitos seguidos
  const hayDni     = !hayCelular && REGEX_DNI.test(texto); 
  const hayTarjeta = REGEX_TARJETA.test(texto);

  // Reset tras test()
  REGEX_CORREO.lastIndex  = 0;
  REGEX_CELULAR.lastIndex = 0;
  REGEX_DNI.lastIndex     = 0;
  REGEX_TARJETA.lastIndex = 0;

  // PRIORIDAD 1: Si hay celular detectado por regex -> celular gana siempre.
  // Esto corrige el caso "Escribeme a mi numero 987654321" → modelo dice correo, regex dice celular.
  if (hayCelular) {
    return { expone: true, tipo: "celular", hayCorreo, hayCelular, hayDni, hayTarjeta };
  }

  // PRIORIDAD 2: Si hay DNI (8 dígitos exactos) y el modelo no lo detectó -> forzamos dni.
  if (hayDni && (!expone || tipo !== "dni")) {
    return { expone: true, tipo: "dni", hayCorreo, hayCelular, hayDni, hayTarjeta };
  }

  // PRIORIDAD 3: Si hay correo y el modelo no lo detectó -> forzamos correo.
  if (!expone && hayCorreo) {
    return { expone: true, tipo: "correo", hayCorreo, hayCelular, hayDni, hayTarjeta };
  }

  // PRIORIDAD 4: Si el modelo dice TARJETA pero no hay correo -> probable falso positivo.
  // Ajusta esto si tu modelo detecta tarjetas reales bien.
  // Si tu regex detecta tarjeta, dale prioridad.
  if (hayTarjeta && (!expone || tipo !== "tarjeta")) {
     return { expone: true, tipo: "tarjeta", hayCorreo, hayCelular, hayDni, hayTarjeta };
  }

  return { expone, tipo, hayCorreo, hayCelular, hayDni, hayTarjeta };
}


// ================= HU-12: Distancia de Levenshtein =================
function levenshtein(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const d = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= m; i++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // borrado
        d[i][j - 1] + 1,       // inserción
        d[i - 1][j - 1] + cost // sustitución
      );
    }
  }
  return d[m][n];
}

// ================= HU-12: Analizador de enlaces en texto =================
function hu12_analizarTextoParaLinks(texto) {
  // Regex general para URLs
  const urlRegex = /(https?:\/\/[^\s/$.?#].[^\s]*)/gi;
  const urls = texto.match(urlRegex);

  if (!urls) {
    return { expone: false, tipo: null };
  }

  for (const urlStr of urls) {
    try {
      const url = new URL(urlStr);
      const host = url.hostname.replace(/^www\./, "");

      // 1. Acortadores
      if (SHORTENER_DOMAINS.has(host)) {
        return { expone: true, tipo: "enlace_sospechoso" };
      }

      // 2. Typosquatting
      if (LEGITIMATE_DOMAINS.has(host)) {
        continue; // dominio legítimo exacto
      }

      // Comparamos contra todos los legítimos
      for (const legit of LEGITIMATE_DOMAINS) {
        const dist = levenshtein(host, legit);
        if (dist > 0 && dist <= TYPO_THRESHOLD) {
          return { expone: true, tipo: "enlace_sospechoso" };
        }
      }
    } catch (e) {
      // URL inválida, ignoramos
    }
  }

  return { expone: false, tipo: null };
}



// Intenta extraer texto semántico de un “campo” (input real o pseudo-input)
function textoCampoPlus(el) {
  const acc = [];

  // Caso general: label[for], label ascendente, aria/placeholder/name/id
  try {
    if (el.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) acc.push(byFor.textContent || "");
    }
    const labUp = el.closest("label");
    if (labUp) acc.push(labUp.textContent || "");
    for (const a of ["aria-label", "placeholder"]) {
      const v = el.getAttribute?.(a);
      if (v) acc.push(v);
    }
    if (el.name) acc.push(el.name);
    if (el.id) acc.push(el.id);

    // Hermanos cercanos con texto breve
    const prev = el.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.length < 200) acc.push(prev.textContent);

    // Específico para perfiles de Steam
    const steamEditRow = el.closest(".profile_edit_row");
    if (steamEditRow) {
      const title = steamEditRow.querySelector(".profile_edit_row_title");
      if (title) acc.push(title.textContent || "");
    }

    // Padre con poco texto (evita contenedores gigantes)
    const parent = el.parentElement;
    if (parent && parent.textContent && parent.textContent.length < 300) {
      const clone = parent.cloneNode(true);
      // Evitamos incluir el texto que el usuario está escribiendo (dentro de 'el')
      const index = Array.from(parent.children).indexOf(el);
      if (index !== -1 && clone.children[index]) {
        clone.removeChild(clone.children[index]);
      }
      // Por si acaso, remover también otros inputs
      const inputs = clone.querySelectorAll("input, textarea");
      for (const n of inputs) n.remove();

      acc.push(clone.textContent);
    }
  } catch { }

  // Caso Steam: label visual en .DialogLabel cerca del input/botón
  try {
    const steamLabel = el.closest("label")?.querySelector(".DialogLabel");
    if (steamLabel) acc.push(steamLabel.textContent || "");
    const steamAround = el.closest(".DialogInputLabelGroup, .DialogInput_Wrapper, ._DialogLayout");
    if (steamAround) {
      const lab = steamAround.querySelector(".DialogLabel");
      if (lab) acc.push(lab.textContent || "");
    }
  } catch { }

  // Caso Roblox: bloques con .account-settings-text-field (no hay input editable hasta hacer click)
  try {
    const robloxField = el.closest(".account-settings-text-field");
    if (robloxField) {
      const robloxLabel = robloxField.querySelector(".account-info-inline-label");
      if (robloxLabel) acc.push(robloxLabel.textContent || "");
    }
    // También hay secciones con H2
    const robloxSection = el.closest(".setting-section");
    if (robloxSection) {
      const h2 = robloxSection.querySelector(".setting-section-header");
      if (h2) acc.push(h2.textContent || "");
    }
  } catch { }

  return (acc.join(" ") || "").trim();
}

// Clasifica texto a categoría
function clasificarCategoriaPorTexto(t) {
  if (!t) return null;
  if (KW.correo.test(t)) return "correo";
  if (KW.dni.test(t)) return "dni";
  if (KW.tarjeta.test(t)) return "tarjeta";
  if (KW.nombre.test(t)) return "nombre";
  if (KW.celular.test(t)) return "celular";
  if (KW.ubicacion.test(t)) return "ubicacion";
  return null;
}


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


// ================= LIMPIEZA DE DATOS YA ENMASCARADOS =================
function limpiarDatosEnmascarados(texto) {
  if (!texto) return "";
  let t = String(texto);
  // Correo: letra/numero seguido de asteriscos y luego @ (ej. j***@correo.com)
  t = t.replace(/\b[a-z0-9]\*+@[a-z0-9.\-]+\.[a-z]{2,}\b/gi, " ");
  // DNI: asteriscos seguidos de 1 a 4 digitos finales (ej. ******12 o *****834)
  t = t.replace(/\b\*+\d{1,4}\b/g, " ");
  // Celular enmascarado
  t = t.replace(/(?:\+51|51|0051)?[\s\-]?9\*{3,}\d{2,3}/g, " ");
  // Tarjeta: bloques de asteriscos seguidos de 4 digitos finales (ej. **** **** **** 1234)
  t = t.replace(/(?:\*+[ \-]?){3,}\d{4}\b/g, " ");
  return t;
}

// ========= Detecciones / ejemplos / enmascarado =========

// Detecta el PRIMER tipo (para fallback y operaciones simples)
function detectarTipoDato(texto) {
  const t = (texto || "");
  if (REGEX_CORREO.test(t))  { REGEX_CORREO.lastIndex = 0;  return "correo"; }
  // Celular ANTES que DNI: 9 dígitos empezando en 9
  if (REGEX_CELULAR.test(t)) { REGEX_CELULAR.lastIndex = 0; return "celular"; }
  // DNI: exactamente 8 dígitos
  if (REGEX_DNI.test(t))     { REGEX_DNI.lastIndex = 0;     return "dni"; }
  if (REGEX_TARJETA.test(t)) { REGEX_TARJETA.lastIndex = 0; return "tarjeta"; }
  // "nombre" solo lo detecta el modelo (evitar falsos positivos con regex)
  return "ninguno";
}

// Detecta TODOS los tipos presentes en el texto (para la cola de avisos)
function detectarTiposDato(texto) {
  const tipos = [];
  const t = (texto || "");
  REGEX_CORREO.lastIndex  = 0;
  REGEX_CELULAR.lastIndex = 0;
  REGEX_DNI.lastIndex     = 0;
  REGEX_TARJETA.lastIndex = 0;
    if (REGEX_CORREO.test(t))  tipos.push("correo");
  // Celular ANTES que DNI para evitar que un 9xxxxxxxx se clasifique como dni
  if (REGEX_CELULAR.test(t)) tipos.push("celular");
  // Si no hay celular, revisamos si hay DNI
  if (!REGEX_CELULAR.test(t) && REGEX_DNI.test(t)) tipos.push("dni");
  if (REGEX_TARJETA.test(t)) tipos.push("tarjeta");
  // Reset de lastIndex por si se reutilizan los regex luego
  REGEX_CORREO.lastIndex  = 0;
  REGEX_CELULAR.lastIndex = 0;
  REGEX_DNI.lastIndex     = 0;
  REGEX_TARJETA.lastIndex = 0;
  return tipos;
}

// Muestra el siguiente aviso de la cola (se llama tras Omitir o tras cerrar post-Aceptar)
function procesarSiguienteDeLaCola() {
  while (colaDetecciones.length) {
    const item = colaDetecciones.shift();
    if (!state.tipos?.[item.tipo]) continue;              // tipo desactivado en ajustes
    if (silenciadoPorOmitir(item.tipo, colaTarget)) continue; // ya omitido
    ultimosMatches = item.matches;
    ultimoTipoDetectado = item.tipo;
    mostrarAviso(
      `⚠ ${item.tipo.toUpperCase()} detectado${item.isAutofill ? ' (autocompletado)' : ''}`,
      item.vulnerabilidad,
      item.recomendacion,
      { tipo: item.tipo }
    );
    return;
  }
  // Cola vacía — no hay más tipos pendientes
}

function detectarMatches(texto, tipo) {
  if (!texto) return [];
  let re;
  switch (tipo) {
    case "correo":  re = /\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/gi; break;
    // Celular peruano: 9 dígitos empezando en 9, con/sin prefijo +51
    case "celular": re = /(?<!\d)(?:\+51[\s\-]?|51[\s\-]?|0051[\s\-]?)?9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}(?!\d)/g; break;
    // DNI: exactamente 8 dígitos
    case "dni":     re = /(?<!\d)\d{8}(?!\d)/g; break;
    case "tarjeta": re = /\b(?:\d[ \-]?){13,19}\b/g; break;
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
    case "celular":
      return { vulnerabilidad: "Número de celular detectado.", recomendacion: "Nunca compartas tu número de teléfono en chats públicos o con desconocidos." };
    case "dni":
      return { vulnerabilidad: "Número de DNI detectado.", recomendacion: "Nunca compartas tu DNI en plataformas abiertas." };
    case "tarjeta":
      return { vulnerabilidad: "Posible número de tarjeta detectado.", recomendacion: "No escribas números de tarjeta en ningún campo de texto no seguro." };
    case "nombre":
      return { vulnerabilidad: "Exposición de nombre real.", recomendacion: "Evita publicar tu nombre completo en foros o juegos públicos." };
    case "edad":
      return { vulnerabilidad: "Edad detectada.", recomendacion: "No reveles tu edad a desconocidos." };
    case "ubicacion":
      return { vulnerabilidad: "Ubicación detectada.", recomendacion: "No compartas tu ubicación exacta en juegos en línea." };
    case "enlace_sospechoso":
      return { vulnerabilidad: "Enlace potencialmente peligroso.", recomendacion: "Ten cuidado con enlaces acortados o sitios que imitan plataformas reales." };
    case "multiple_campos":
      return { vulnerabilidad: "Este formulario solicita múltiples datos sensibles.", recomendacion: "Revisa la política del sitio y comparte solo lo necesario." };
    default:
      return { vulnerabilidad: "Dato potencialmente sensible detectado.", recomendacion: "Evita compartir información personal en espacios públicos." };
  }
}

// Mensajes para detección por CONTEXTO del campo (configuración/perfil)
// Se usa cuando el campo mismo indica el tipo (label, placeholder, etc.)
// pero el valor aún no forma un patrón reconocible.
function mensajesPorContextoCampo(tipo, sitio) {
  const en = sitio ? ` en <b>${escapeHTML(sitio)}</b>` : "";
  switch (tipo) {
    case "correo":
      return {
        vulnerabilidad: `Estás ingresando tu <b>correo electrónico</b>${en}. Este dato quedará guardado en los servidores del sitio.`,
        recomendacion: "Asegúrate de estar en el sitio correcto y que la URL comience con <b>https</b>."
      };
    case "nombre":
      return {
        vulnerabilidad: `Estás ingresando tu <b>nombre real</b>${en}. Este dato puede ser visible para otros usuarios.`,
        recomendacion: "Considera si el sitio realmente necesita tu nombre real o si puedes usar un alias."
      };
    case "celular":
        return {
          vulnerabilidad: `Estás ingresando tu <b>número de celular</b>${en}.`,
          recomendacion: "Asegúrate de que tu número de teléfono permanezca privado en la configuración de tu cuenta."
        };
    case "dni":
      return {
        vulnerabilidad: `Este campo parece solicitar tu <b>número de identidad</b>${en}.`,
        recomendacion: "Comparte tu DNI/cédula solo en sitios de confianza que lo requieran legalmente."
      };
    case "tarjeta":
      return {
        vulnerabilidad: `Este campo parece solicitar datos de <b>tarjeta de pago</b>${en}.`,
        recomendacion: "Verifica que el sitio tenga certificado SSL y sea una plataforma de pago legítima."
      };
    default:
      return {
        vulnerabilidad: `Estás ingresando datos potencialmente sensibles en este campo${en}.`,
        recomendacion: "Asegúrate de confiar en este sitio antes de compartir información personal."
      };
  }
}
function ejemplosEnmascarados(tipo) {
  switch (tipo) {
    case "correo": return ["j***@correo.com", "m*****.p****@dominio.pe", "u*****+promo@ejemplo.org"];
    case "celular": return ["987***321", "9** *** 123", "+51 9******00"];
    case "dni": return ["******12", "*****834", "******90"];
    case "tarjeta": return ["**** **** **** 1234", "****-****-****-9876", "************4321"];
    case "nombre": return [];
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
    case "celular":
      // Enmascara los números del medio, deja los 3 últimos y el primer 9
      nuevo = nuevo.replace(/(?<!\d)((?:\+51[\s\-]?|51[\s\-]?|0051[\s\-]?)?)9(\d{2}[\s\-]?\d{3}[\s\-]?)(\d{3})(?!\d)/g, (full, p1, p2, p3) => {
        return p1 + "9" + "*".repeat(p2.replace(/\s|-/g, "").length) + p3;
      });
      break;
    case "dni":
      // Enmascara los primeros 6 dígitos, deja 2 finales visibles
      nuevo = nuevo.replace(/(?<!\d)(\d{6})(\d{2})(?!\d)/g, (_, a, b) => "*".repeat(a.length) + b);
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

  // Disparamos eventos para que la página web sepa que el texto cambió, 
  // pero marcamos que nosotros lo hicimos para no desatar análisis infinitos ni resetear la cola.
  ignorarEventosProgramaticos = true;
  const eventos = ['input', 'change', 'blur'];
  eventos.forEach(tipoEvento => {
    input.dispatchEvent(new Event(tipoEvento, { bubbles: true }));
  });

  // Liberamos la bandera después de un margen de tiempo para que los listeners de la página terminen
  setTimeout(() => {
    ignorarEventosProgramaticos = false;
  }, 200);
}

