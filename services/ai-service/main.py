"""
Circini Migration Agent - FastAPI Service
Wraps the existing agent logic with a REST API
"""

import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, Dict, List, Any
from contextlib import asynccontextmanager
from dotenv import load_dotenv

from config import settings
from llm import configure_llm
from telemetry import init_telemetry
from routes.migration import router as migration_router
from routes.stt import router as stt_router

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — fail fast if service auth is not configured
    if not settings.INTERNAL_API_KEY:
        raise RuntimeError("INTERNAL_API_KEY must be set (shared secret with the backend)")
    print(f"AI Service starting on port {settings.PORT}")
    configure_llm()
    print(f"Using model: {settings.model_name} (provider={settings.LLM_PROVIDER})")
    print(f"Guardrails: {'enabled' if settings.GUARDRAILS_ENABLED else 'DISABLED'} | "
          f"PHI mode: {'B (redact)' if settings.PHI_MODE else 'A (metadata-only, block health PII)'}")
    yield
    # Shutdown
    print("AI Service shutting down")

app = FastAPI(
    title="Circini Migration Agent AI Service",
    description="AI-powered data migration assistant",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Service-to-service auth: every request (except health) must present the
# shared key — the AI service only talks to the backend. Fail-closed: an
# unconfigured key refuses requests rather than skipping auth.
@app.middleware("http")
async def internal_auth(request: Request, call_next):
    if request.url.path not in ("/", "/ai/health"):
        if not settings.INTERNAL_API_KEY:
            return JSONResponse(status_code=503, content={"detail": "Internal service auth is not configured"})
        if request.headers.get("x-internal-key") != settings.INTERNAL_API_KEY:
            return JSONResponse(status_code=401, content={"detail": "Invalid internal key"})
    return await call_next(request)

# OTEL traces/metrics (gen_ai.* semantic conventions)
init_telemetry(app)

# Include routes
app.include_router(migration_router, prefix="/ai", tags=["AI"])
app.include_router(stt_router, prefix="/ai", tags=["STT"])

@app.get("/")
async def root():
    return {"message": "Circini Migration Agent AI Service", "version": "1.0.0"}

@app.get("/ai/health")
async def health_check():
    return {
        "status": "healthy",
        "provider": settings.LLM_PROVIDER,
        "model": settings.model_name,
        "guardrails_enabled": settings.GUARDRAILS_ENABLED,
        "phi_mode": settings.PHI_MODE,
        "output_dir": str(settings.OUTPUT_DIR)
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.PORT)
