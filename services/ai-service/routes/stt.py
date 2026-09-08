"""Audio cannot be screened before external transcription; fail closed."""
from fastapi import APIRouter, HTTPException
router = APIRouter()

@router.post("/stt")
async def speech_to_text():
    raise HTTPException(status_code=403, detail="Voice input is unavailable until an approved transcription boundary is configured. Please type your message.")
