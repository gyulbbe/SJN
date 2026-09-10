from fastapi import FastAPI

app = FastAPI(title="SJN OCI deployment example")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "deployment-demo"}
