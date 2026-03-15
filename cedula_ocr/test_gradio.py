import requests
import json
import base64

def test_gradio_space():
    # Espacio de LLaVA 1.6 en HF
    space_url = "https://llava-hf-llava-v1-6-34b-hf.hf.space/api/predict"
    
    # Imagen de prueba (1x1 blanca)
    img_b64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
    
    payload = {
        "data": [
            img_b64,
            "Describe esta imagen brevemente.",
            "Visual Question Answering"
        ]
    }
    
    try:
        response = requests.post(space_url, json=payload, timeout=10)
        print(f"Status: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

test_gradio_space()
