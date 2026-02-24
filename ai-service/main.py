"""
Circini Migration Agent - FastAPI Service
Wraps the existing agent logic with a REST API
"""

import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, List, Any
from contextlib import asynccontextmanager
from dotenv import load_dotenv

from config import settings
from routes.migration import router as migration_router
from routes.stt import router as stt_router

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    print(f"AI Service starting on port {settings.PORT}")
    print(f"Using model: {settings.OPENAI_MODEL}")
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
        "model": settings.OPENAI_MODEL,
        "output_dir": str(settings.OUTPUT_DIR)
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.PORT)
