// ml/inference.js
// Capa de inferencia: usa transformers.js + ONNX Runtime Web (ORT)
// para analizar texto con un modelo DistilBERT en formato ONNX,
// sin backend, directamente en el navegador.

import { env, AutoTokenizer } from "../libs/transformers.min.js";
import { LABELS } from "./labels.js";

// Rutas dentro de la extensión
const ORT_WASM_DIR = chrome.runtime.getURL("assets/ort-wasm/");
const MODEL_PATH   = chrome.runtime.getURL("assets/modelo_privacidad.onnx");
const TOKENIZER_ID = "assets/tokenizer"; // carpeta con tokenizer.json + tokenizer_config.json

// Configuración de transformers.js
env.allowRemoteModels = false;                      // no bajar nada del Hub
env.localModelPath    = chrome.runtime.getURL("");  // p.ej. "chrome-extension://<id>/"
env.useBrowserCache   = false;                      // evitar warnings con scheme chrome-extension://

// Cache
let tokenizerPromise = null;
let sessionPromise   = null;
let ortInstance      = null;

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(TOKENIZER_ID, {
      local_files_only: true
    });
  }
  return tokenizerPromise;
}

async function getSession() {
  if (!sessionPromise) {
    const ortGlobal = globalThis.ort;
    if (!ortGlobal) {
      throw new Error("ONNX Runtime (ort) no está cargado. ¿Está 'libs/onnxruntime-web.min.js' en content_scripts?");
    }

    ortInstance = ortGlobal;

    if (ortInstance.env && ortInstance.env.wasm) {
      ortInstance.env.wasm.wasmPaths = ORT_WASM_DIR;
    }

    sessionPromise = ortInstance.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
  }
  return sessionPromise;
}

// Softmax
function softmax(arr) {
  const max = Math.max(...arr);
  const exp = arr.map(x => Math.exp(x - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(x => x / sum);
}

// 🔥 API pública: la que llamas desde content.js
export async function analizarTextoConModelo(texto) {
  const textoLimpio = (texto || "").trim();
  if (!textoLimpio) {
    return { expone: false, tipo: null, probs: {} };
  }

  const [tokenizer, session] = await Promise.all([
    getTokenizer(),
    getSession()
  ]);

  if (!ortInstance) {
    throw new Error("ORT no inicializado correctamente.");
  }

  // 1) Tokenización
  const encoded = await tokenizer(textoLimpio, {
    truncation: true,
    padding: true,
    max_length: 128,
    return_tensor: false
  });

  const ids  = encoded.input_ids;
  let mask   = encoded.attention_mask;

  if (!ids || ids.length === 0) {
    return { expone: false, tipo: null, probs: {} };
  }

  if (!mask || mask.length !== ids.length) {
    mask = new Array(ids.length).fill(1);
  }

  // 2) Construcción de tensores
  // Muchos modelos BERT en ONNX esperan int64
  const inputIdsArr = BigInt64Array.from(ids.map(BigInt));
  const attMaskArr  = BigInt64Array.from(mask.map(BigInt));

  const input_ids = new ortInstance.Tensor("int64", inputIdsArr, [1, inputIdsArr.length]);
  const attention_mask = new ortInstance.Tensor("int64", attMaskArr, [1, attMaskArr.length]);

  const feeds = {};
  const inputNames = session.inputNames || [];

  if (inputNames.includes("input_ids")) {
    feeds.input_ids = input_ids;
  } else if (inputNames.length > 0) {
    feeds[inputNames[0]] = input_ids;
  }

  if (inputNames.includes("attention_mask")) {
    feeds.attention_mask = attention_mask;
  }

  // 3) Inferencia ONNX
  const out = await session.run(feeds);

  const raw = out.output || out.logits;
  if (!raw || !raw.data) {
    throw new Error("No se encontraron logits en la salida del modelo ONNX");
  }

  const logits = Array.from(raw.data);
  const probs = softmax(logits);

  // 4) Mapear dinámicamente probs -> etiquetas usando LABELS
  const probsMap = Object.fromEntries(
    LABELS.map((label, idx) => [label, probs[idx] ?? 0])
  );

  // 5) Seleccionar la etiqueta ganadora (excepto "ninguno")
  let mejorLabel = null;
  let mejorProb  = 0;

  for (const label of LABELS) {
    if (label.toLowerCase() === "ninguno") continue; // saltamos clase neutra
    const p = probsMap[label] ?? 0;
    if (p > mejorProb) {
      mejorProb = p;
      mejorLabel = label;
    }
  }

  const probNinguno = probsMap["ninguno"] ?? probsMap["Ninguno"] ?? 0;

  // 6) Decidir si expone datos o no
  if (!mejorLabel || probNinguno >= mejorProb) {
    return {
      expone: false,
      tipo: null,
      probs: probsMap
    };
  }

  return {
    expone: true,
    tipo: mejorLabel,
    probs: probsMap
  };
}
