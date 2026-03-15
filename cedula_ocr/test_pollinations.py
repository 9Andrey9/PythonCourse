import requests
import base64

def test_pollinations_vision():
    # URL de Pollinations (GPT-4o proxy gratuito)
    url = "https://text.pollinations.ai/openai"
    
    # Imagen de prueba (una simple blanca de 1x1 base64)
    img_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
    
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe esta imagen brevemente."},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{img_b64}"}
                    }
                ]
            }
        ],
        "model": "openai"
    }
    
    try:
        response = requests.post(url, json=payload)
        print(f"Status: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

test_pollinations_vision()
