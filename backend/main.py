from fastapi import FastAPI

app = FastAPI()

datos = []

@app.get("/")
def home():
    return {"status": "backend activo"}

@app.post("/data")
def recibir_datos(payload: dict):
    datos.append(payload)
    return {"ok": True}

@app.get("/data")
def obtener_datos():
    return datos