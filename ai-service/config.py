"""
Configuration for AI Service
"""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

class Settings:
    # OpenAI settings
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-5.2")

    # Server settings
    PORT: int = int(os.getenv("PORT", "8084"))

    # Backend URL for sending logs
    BACKEND_URL: str = os.getenv("BACKEND_URL", "http://backend:3001")

    # Output directory (PersistentVolume mount point in k8s)
    OUTPUT_DIR: Path = Path(os.getenv("OUTPUT_DIR", "/data/outputs"))

    def __init__(self):
        # Ensure output directory exists
        self.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

settings = Settings()
