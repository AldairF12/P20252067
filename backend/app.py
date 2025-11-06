from flask import Flask, request, jsonify 
from transformers import DistilBertTokenizer, DistilBertForSequenceClassification 
import torch 
from flask_cors import CORS 

# Inicializar Flask 
app = Flask(__name__) 
CORS(app) # permitir peticiones desde la extensión 

# Cargar modelo y tokenizador 
MODEL_PATH = "backend\modelo_privacidad" 
tokenizer = DistilBertTokenizer.from_pretrained(MODEL_PATH) 
model = DistilBertForSequenceClassification.from_pretrained(MODEL_PATH) 
model.eval() # modo inferencia 

@app.route("/analizar", methods=["POST"]) 
def analizar():
    try: 
        # Recibir texto desde la extensión 
        data = request.get_json() 
        texto = data.get("texto", "") 
        
        if not texto.strip(): 
            return jsonify({"error": "Texto vacío"}), 400 
        
        # Tokenizar texto 
        inputs = tokenizer(texto, return_tensors="pt", truncation=True, padding=True) 
        outputs = model(**inputs)
        
        # Obtener probabilidades 
        probabilidades = torch.softmax(outputs.logits, dim=-1).detach().numpy()
        prob_dni = probabilidades[0][0]
        prob_tarjeta = probabilidades[0][1]
        prob_nombre = probabilidades[0][2]
        prob_correo = probabilidades[0][3]
        prob_ninguno = probabilidades[0][4]

        # Determinar tipo con mayor probabilidad
        tipos = {
            "dni": prob_dni,
            "tarjeta": prob_tarjeta,
            "nombre": prob_nombre,
            "correo": prob_correo
        }

        tipo_detectado = max(tipos, key=tipos.get)
        mayor_prob = tipos[tipo_detectado]

        # Si "ninguno" es mayor a todos, no hay exposición
        if prob_ninguno > mayor_prob:
            return jsonify({
                "expone": False,
                "tipo": None
            })
        
        # Respuesta esperada por la extensión
        return jsonify({
            "expone": True,
            "tipo": tipo_detectado
        })
    except Exception as e: 
        return jsonify({"error": str(e)}), 500 
    
if __name__ == "__main__": 
    # Ejecutar servidor local 
    app.run(host="127.0.0.1", port=5000, debug=True)