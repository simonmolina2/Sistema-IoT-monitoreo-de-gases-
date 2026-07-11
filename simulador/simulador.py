import requests
import time
import random

while True:
    data = {
        "gas_metano": random.randint(300, 1200),
        "temperatura": random.randint(18, 35),
        "humo": random.randint(0, 100)
    }

    requests.post("http://localhost:8000/data", json=data)

    print("Enviado:", data)
    time.sleep(3)