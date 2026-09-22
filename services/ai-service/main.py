"""
Circini Migration Agent - FastAPI Service
Serves the LangGraph agent runtime over a REST API for the backend.
"""

import os
# Checkpoints are deserialised against an allow-list. LangGraph reads this at
# import time, so it is set before anything imports langgraph.
os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

import json
import secrets
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from llm import configure_llm, security_status
from routes import migration
from routes.file_search import router as file_search_router
from routes.stt import router as stt_router
from telemetry import init_telemetry
from workflow.assembly import build_runtime

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — fail fast if service auth or the provider boundary is not configured
    if not settings.INTERNAL_API_KEY:
        raise RuntimeError("INTERNAL_API_KEY must be set (shared secret with the backend)")
    print(f"AI Service starting on port {settings.PORT}")
    configure_llm()
    runtime = build_runtime()
    migration.install_runtime(runtime)
    print(json.dumps({"event": "security.configuration", **security_status()}, sort_keys=True))
    print(f"Using model: {settings.model_name} (provider={settings.LLM_PROVIDER}, "
          f"checkpoints={settings.CHECKPOINT_BACKEND})")
    print(f"Guardrails: {'enabled' if settings.GUARDRAILS_ENABLED else 'DISABLED'} | "
          f"PHI mode: {'B (redact)' if settings.PHI_MODE else 'A (metadata-only, block health PII)'}")
    yield
    migration.install_runtime(None)
    runtime.tracer.flush()
    print("AI Service shutting down")

app = FastAPI(
    title="Circini Migration Agent AI Service",
    description="AI-powered data migration assistant",
    version="2.0.0",
    lifespan=lifespan
)

# CORS. This service is only ever called server-to-server by the backend, so
# there is no browser origin to allow. A wildcard combined with
# allow_credentials is invalid per the CORS spec anyway, and browsers reject
# it — it only ever looked permissive. CORS_ALLOW_ORIGINS can name explicit
# origins if a browser ever needs direct access.
_cors_origins = [
    o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()
]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type", "x-internal-key"],
    )

# Service-to-service auth: every request (except health) must present the
# shared key — the AI service only talks to the backend. Fail-closed: an
# unconfigured key refuses requests rather than skipping auth.
@app.middleware("http")
async def internal_auth(request: Request, call_next):
    if request.url.path not in ("/", "/ai/health"):
        if not settings.INTERNAL_API_KEY:
            return JSONResponse(status_code=503, content={"detail": "Internal service auth is not configured"})
        if not secrets.compare_digest(request.headers.get("x-internal-key", ""), settings.INTERNAL_API_KEY):
            return JSONResponse(status_code=401, content={"detail": "Invalid internal key"})
    return await call_next(request)

# OTEL traces/metrics (gen_ai.* semantic conventions)
init_telemetry(app)

# Include routes
app.include_router(migration.router, prefix="/ai", tags=["AI"])
app.include_router(stt_router, prefix="/ai", tags=["STT"])
app.include_router(file_search_router, prefix="/ai", tags=["Files"])

@app.get("/")
async def root():
    return {"message": "Circini Migration Agent AI Service", "version": "2.0.0"}

@app.get("/ai/health")
async def health_check():
    return {
        "status": "healthy",
        "provider": settings.LLM_PROVIDER,
        "model": settings.model_name,
        "agent_framework": "langgraph",
        "guardrails_enabled": settings.GUARDRAILS_ENABLED,
        "phi_mode": settings.PHI_MODE,
        "output_dir": str(settings.OUTPUT_DIR)
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.PORT)
