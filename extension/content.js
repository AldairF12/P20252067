let avisoActivo = null; // para saber si hay un aviso visible

document.addEventListener("input", async (event) => {
  const target = event.target;

  // Solo si escribe en un campo de texto
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
    const texto = target.value.trim();

    // Evita enviar si hay muy poco texto
    if (texto.length < 10) return;

    try {
      const response = await fetch("http://127.0.0.1:5000/analizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto })
      });

      const data = await response.json();
      console.log("Resultado del modelo:", data);

      // 🚫 Si no hay exposición, quitar el aviso (si existía)
      if (data.prediccion === "No expone datos personales") {
        if (avisoActivo) {
          avisoActivo.remove();
          avisoActivo = null;
        }
        return;
      }

      // ✅ Si sí hay exposición, mostrar el aviso correspondiente
      if (data.prediccion === "Expone datos personales") {
        if (avisoActivo) {
          avisoActivo.remove();
          avisoActivo = null;
        }
        const tipo = detectarTipoDato(texto);
        let vulnerabilidad = "";
        let recomendacion = "";

        switch (tipo) {
          case "correo":
            vulnerabilidad = "Correo electrónico expuesto.";
            recomendacion = "Evita compartir tu correo en chats o foros públicos.";
            break;
          case "dni":
            vulnerabilidad = "Número de DNI detectado.";
            recomendacion = "Nunca compartas tu DNI en plataformas abiertas.";
            break;
          case "tarjeta":
            vulnerabilidad = "Posible número de tarjeta detectado.";
            recomendacion = "No escribas números de tarjeta en ningún campo de texto no seguro.";
            break;
          case "nombre":
          default:
            vulnerabilidad = "Exposición de nombre.";
            recomendacion = "Evita publicar tu nombre completo en foros o juegos públicos.";
            break;
        }

        mostrarAviso("Aviso", vulnerabilidad, recomendacion);
      }

    } catch (error) {
      console.error("Error al conectar con el backend:", error);
    }
  }
});


// 🔍 Función para detectar el tipo de dato sensible según el texto
function detectarTipoDato(texto) {
  texto = texto.toLowerCase();

  if (texto.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/)) return "correo";
  if (texto.match(/\b\d{8}\b/)) return "dni";
  if (texto.match(/\b(?:\d[ -]*?){13,16}\b/)) return "tarjeta";
  if (texto.match(/\b([a-záéíóúñ]{2,}\s){1,}[a-záéíóúñ]{2,}\b/)) return "nombre"; // nombre compuesto
  return "otro";
}


// ⚠️ Función que muestra el aviso en la esquina inferior derecha
function mostrarAviso(titulo, vulnerabilidad, recomendacion) {
  // Si ya hay uno activo, eliminarlo antes de crear uno nuevo
  if (avisoActivo) avisoActivo.remove();

  const aviso = document.createElement("div");
  aviso.classList.add("aviso-proteccion");
  aviso.innerHTML = `
    <strong style="font-size:16px;display:block;margin-bottom:4px;">${titulo}</strong>
    <p><b>Vulnerabilidad:</b><br>${vulnerabilidad}</p>
    <p><b>Recomendación:</b><br>${recomendacion}</p>
  `;

  Object.assign(aviso.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    width: "260px",
    backgroundColor: "#ffeb3b",
    color: "#000",
    padding: "12px 14px",
    borderRadius: "10px",
    boxShadow: "0 3px 8px rgba(0,0,0,0.25)",
    fontFamily: "Arial, sans-serif",
    fontSize: "14px",
    zIndex: "9999",
    transition: "opacity 0.4s ease",
  });

  document.body.appendChild(aviso);
  avisoActivo = aviso;

  // Ocultar automáticamente después de 6s
  setTimeout(() => {
    aviso.style.opacity = "0";
    setTimeout(() => {
      aviso.remove();
      avisoActivo = null;
    }, 400);
  }, 6000);
}
