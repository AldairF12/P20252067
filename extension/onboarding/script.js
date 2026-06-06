// Año en footer
document.getElementById("y").textContent = new Date().getFullYear();

// Animación "reveal" al hacer scroll
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// Efecto tilt sutil en tarjetas
document.querySelectorAll('.tilt').forEach(card => {
  let rAF = null;
  const maxTilt = 6; // grados

  function handleMove(e){
    const rect = card.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rx = (py - 0.5) * -2 * maxTilt;
    const ry = (px - 0.5) *  2 * maxTilt;
    card.style.transform = `perspective(700px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
  }
  function onMove(e){
    if (rAF) cancelAnimationFrame(rAF);
    rAF = requestAnimationFrame(() => handleMove(e));
  }
  function reset(){
    card.style.transform = "translateY(-2px) rotate(-1deg)";
  }
  card.addEventListener('mousemove', onMove);
  card.addEventListener('mouseleave', reset);
});

// Smooth scroll en navegación interna
document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click', (e)=>{
    const id = a.getAttribute('href');
    const el = document.querySelector(id);
    if (el){
      e.preventDefault();
      el.scrollIntoView({behavior:'smooth', block:'start'});
    }
  });
});

// ===== Lightbox de Zoom (Arquitectura) =====
(() => {
  const overlay = document.getElementById('zoomOverlay');
  const stage   = document.getElementById('zoomStage');
  const img     = document.getElementById('zoomImg');
  const btnOpenList = document.querySelectorAll('.open-zoom');

  const btnClose = document.getElementById('zbClose');
  const btnIn    = document.getElementById('zbZoomIn');
  const btnOut   = document.getElementById('zbZoomOut');
  const btnReset = document.getElementById('zbReset');

  // Estado
  let scale = 1, minScale = 0.5, maxScale = 6, step = 0.2;
  let tx = 0, ty = 0;
  let isPanning = false;
  let startX = 0, startY = 0;
  let touchCache = [];

  function applyTransform(){
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function fitToScreen(){
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return;

    const scaleX = sw / iw;
    const scaleY = sh / ih;
    scale = Math.min(scaleX, scaleY, 1);
    tx = Math.max( (sw - iw * scale) / 2, 0);
    ty = Math.max( (sh - ih * scale) / 2, 0);
    applyTransform();
  }

  function openZoom(src){
    img.src = src;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => { fitToScreen(); stage.focus(); });
  }

  function closeZoom(){
    overlay.hidden = true;
    document.body.style.overflow = '';
    scale = 1; tx = 0; ty = 0;
    img.style.transform = '';
  }

  function zoomAt(factor, cx, cy){
    const prev = scale;
    const next = Math.min(maxScale, Math.max(minScale, prev * factor));
    if (next === prev) return;

    const rect = stage.getBoundingClientRect();
    const px = cx - rect.left - tx;
    const py = cy - rect.top  - ty;
    const k = next / prev;
    tx = cx - rect.left - px * k;
    ty = cy - rect.top  - py * k;
    scale = next;
    applyTransform();
  }

  // Abrir
  btnOpenList.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const src = btn.getAttribute('data-full') || 'assets/arquitectura.png';
      openZoom(src);
    });
  });

  // Cerrar
  btnClose.addEventListener('click', closeZoom);
  overlay.addEventListener('click', e=>{
    if (e.target === overlay) closeZoom();
  });

  // Controles
  btnIn.addEventListener('click', ()=> zoomAt(1 + step, stage.clientWidth/2, stage.clientHeight/2));
  btnOut.addEventListener('click', ()=> zoomAt(1 - step, stage.clientWidth/2, stage.clientHeight/2));
  btnReset.addEventListener('click', fitToScreen);

  // Rueda para zoom
  stage.addEventListener('wheel', e=>{
    e.preventDefault();
    const factor = e.deltaY > 0 ? (1 - step) : (1 + step);
    zoomAt(factor, e.clientX, e.clientY);
  }, { passive:false });

  // Pan con mouse
  stage.addEventListener('mousedown', e=>{
    isPanning = true; startX = e.clientX; startY = e.clientY;
  });
  window.addEventListener('mousemove', e=>{
    if(!isPanning) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    startX = e.clientX; startY = e.clientY;
    tx += dx; ty += dy;
    applyTransform();
  });
  window.addEventListener('mouseup', ()=>{ isPanning = false; });

  // Doble click: zoom in / Alt + doble click: zoom out
  stage.addEventListener('dblclick', e=>{
    if (e.altKey) zoomAt(1 - step, e.clientX, e.clientY);
    else          zoomAt(1 + step, e.clientX, e.clientY);
  });

  // Teclado
  stage.addEventListener('keydown', e=>{
    if (e.key === 'Escape') closeZoom();
    else if (e.key === '+' || e.key === '=') zoomAt(1 + step, stage.clientWidth/2, stage.clientHeight/2);
    else if (e.key === '-' || e.key === '_') zoomAt(1 - step, stage.clientWidth/2, stage.clientHeight/2);
    else if (e.key === '0') fitToScreen();
    else if (e.key === 'ArrowLeft')  { tx += 40; applyTransform(); }
    else if (e.key === 'ArrowRight') { tx -= 40; applyTransform(); }
    else if (e.key === 'ArrowUp')    { ty += 40; applyTransform(); }
    else if (e.key === 'ArrowDown')  { ty -= 40; applyTransform(); }
  });

  // Táctil: pan y pinch-to-zoom
  function dist(t1, t2){ return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY); }
  stage.addEventListener('touchstart', e=>{
    if (e.touches.length === 1){
      isPanning = true;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }
    touchCache = Array.from(e.touches);
  }, {passive:true});

  stage.addEventListener('touchmove', e=>{
    if (e.touches.length === 1 && isPanning){
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      startX = t.clientX; startY = t.clientY;
      tx += dx; ty += dy;
      applyTransform();
    } else if (e.touches.length === 2 && touchCache.length === 2){
      e.preventDefault();
      const prevDist = dist(touchCache[0], touchCache[1]);
      const currDist = dist(e.touches[0], e.touches[1]);
      const factor = currDist / prevDist;
      const cx = (e.touches[0].clientX + e.touches[1].clientX)/2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY)/2;
      zoomAt(factor, cx, cy);
      touchCache = Array.from(e.touches);
    }
  }, {passive:false});

  stage.addEventListener('touchend', ()=>{ isPanning = false; touchCache = []; });

  // Resize
  window.addEventListener('resize', ()=>{
    if (!overlay.hidden) fitToScreen();
  });

  // ESC global
  document.addEventListener('keydown', e=>{
    if (!overlay.hidden && e.key === 'Escape') closeZoom();
  });

  img.addEventListener('load', fitToScreen);
})();
/* ============ Mejora automática de <pre><code> a "ventana de código" ============ */
(function(){
  // Configuración mínima
  const SELECTOR = 'pre > code';         // qué transformar
  const WRAP_BY_DEFAULT = false;         // ajuste de línea activado por defecto?

  // Deducción simple de lenguaje por clase (language-xxx) o data-lang
  function detectLanguage(codeEl){
    const cls = codeEl.className || '';
    const m = cls.match(/language-([\w-]+)/i);
    if (m) return m[1].toLowerCase();
    const dl = codeEl.getAttribute('data-lang');
    return (dl || '').toLowerCase();
  }

  // Etiqueta a mostrar (puede ser filename con data-title o lenguaje)
  function getTitle(codeEl, langGuess){
    return codeEl.getAttribute('data-title')
        || codeEl.getAttribute('title')
        || (langGuess ? langGuess.toUpperCase() : 'CODE');
  }

  // Construye números de línea
  function buildLineNumbers(lines){
    const lnums = document.createElement('div');
    lnums.className = 'code-lnums';
    for (let i=0; i<lines.length; i++){
      const d = document.createElement('div');
      d.textContent = (i+1).toString();
      lnums.appendChild(d);
    }
    return lnums;
  }

  // Sanitiza (evitar que < y > rompan el HTML)
  function escapeHTML(s){
    return s.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
  }

  // Resaltado ultra-liviano (opcional, para .bat/.sh/.py/.json/.ini)
  function lightHighlight(s, lang){
    try{
      if (!lang) return s;
      let out = s;
      if (lang === 'json'){
        out = out
          .replace(/"(\\.|[^"])*"/g, m => `<span class="token-str">${m}</span>`)
          .replace(/\b\d+(\.\d+)?\b/g, m => `<span class="token-num">${m}</span>`);
      } else if (lang === 'python' || lang === 'py'){
        out = out
          .replace(/#.*/g, m => `<span class="token-cmt">${m}</span>`)
          .replace(/\b(def|class|import|from|return|if|else|elif|for|while|with|as|try|except|finally|pass|None|True|False)\b/g, m => `<span class="token-kw">${m}</span>`)
          .replace(/"(\\.|[^"])*"|'(\\.|[^'])*'/g, m => `<span class="token-str">${m}</span>`);
      } else if (lang === 'bat' || lang === 'cmd'){
        out = out
          .replace(/REM .*/gi, m => `<span class="token-cmt">${m}</span>`)
          .replace(/\b(set|if|exist|echo|call|start|title|cd|pushd|popd|exit|pause|for|in|do|goto)\b/gi, m => `<span class="token-kw">${m}</span>`);
      } else if (lang === 'bash' || lang === 'sh'){
        out = out
          .replace(/#.*/g, m => `<span class="token-cmt">${m}</span>`)
          .replace(/\b(if|fi|then|else|elif|for|while|do|done|case|esac|function|return|export)\b/g, m => `<span class="token-kw">${m}</span>`);
      } else if (lang === 'html'){
        out = out
          .replace(/&lt;!--[\s\S]*?--&gt;/g, m => `<span class="token-cmt">${m}</span>`)
          .replace(/&lt;\/?[\w-]+.*?&gt;/g, m => `<span class="token-key">${m}</span>`);
      }
      return out;
    }catch(_){ return s; }
  }

  // Crea la ventana de código
  function makeCodeWindow(codeEl){
    const raw = codeEl.textContent.replace(/\r\n/g, '\n');
    const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');
    const lang = detectLanguage(codeEl);
    const title = getTitle(codeEl, lang);

    // Contenedor principal
    const win = document.createElement('div');
    win.className = 'code-window';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    toolbar.innerHTML = `
      <div class="code-dots"><i class="r"></i><i class="y"></i><i class="g"></i></div>
      <div class="code-title" title="${title}">${title}</div>
      <div class="code-actions">
        <button class="code-btn btn-copy" aria-label="Copiar código">Copiar</button>
        <button class="code-btn btn-wrap" aria-label="Alternar ajuste de línea">${WRAP_BY_DEFAULT ? 'Sin ajuste' : 'Ajuste'}</button>
      </div>
    `;

    // Bloque con líneas y contenido
    const block = document.createElement('div');
    block.className = 'code-block';

    // Columna de números
    const lnums = buildLineNumbers(lines);

    // Pre + code (contenido escapado + resaltado)
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = codeEl.className; // conserva language-xxx si existía

    // Escapamos HTML, luego aplicamos resaltado simple
    const escaped = escapeHTML(raw);
    code.innerHTML = lightHighlight(escaped, lang);

    pre.appendChild(code);

    // Estructura de dos columnas
    const grid = document.createElement('div');
    grid.className = 'code-lines';
    grid.appendChild(lnums);
    grid.appendChild(pre);

    block.appendChild(grid);

    // Ajuste inicial
    if (WRAP_BY_DEFAULT){
      block.classList.add('wrap');
    }

    // Botón: Copiar
    toolbar.querySelector('.btn-copy').addEventListener('click', async ()=>{
      try{
        await navigator.clipboard.writeText(raw);
        const btn = toolbar.querySelector('.btn-copy');
        const old = btn.textContent;
        btn.textContent = '¡Copiado!';
        setTimeout(()=> btn.textContent = old, 1200);
      }catch(err){
        alert('No se pudo copiar. Permisos denegados.');
      }
    });

    // Botón: Ajuste de línea
    toolbar.querySelector('.btn-wrap').addEventListener('click', (e)=>{
      const on = block.classList.toggle('wrap');
      e.currentTarget.textContent = on ? 'Sin ajuste' : 'Ajuste';
    });

    // Reemplaza el <pre><code> original por la ventana nueva
    const preContainer = codeEl.parentElement; // <pre>
    const parent = preContainer.parentElement;
    parent.replaceChild(win, preContainer);
    win.appendChild(toolbar);
    win.appendChild(block);
  }

  // Transforma todos los <pre><code> que aún no fueron transformados
  document.querySelectorAll(SELECTOR).forEach(codeEl=>{
    // Evitar doble transformación
    if (codeEl.closest('.code-window')) return;
    makeCodeWindow(codeEl);
  });
})();
