"""
Speech-to-Text route using OpenAI Whisper
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from openai import OpenAI
from config import settings

router = APIRouter()

client = OpenAI(api_key=settings.OPENAI_API_KEY)

STT_MODEL = "gpt-4o-transcribe"


@router.post("/stt")
async def speech_to_text(audio: UploadFile = File(...)):
    """Transcribe audio to text using OpenAI Whisper"""
    if not audio.content_type or not audio.content_type.startswith("audio/"):
        # Also accept application/octet-stream from MediaRecorder blobs
        if audio.content_type != "application/octet-stream":
            raise HTTPException(status_code=400, detail="File must be an audio file")

    try:
        audio_bytes = await audio.read()

        # Determine file extension from content type
        ext_map = {
            "audio/webm": "webm",
            "audio/ogg": "ogg",
            "audio/wav": "wav",
            "audio/mp4": "mp4",
            "audio/mpeg": "mp3",
            "application/octet-stream": "webm",  # MediaRecorder default
        }
        ext = ext_map.get(audio.content_type, "webm")
        filename = f"recording.{ext}"

        transcript = client.audio.transcriptions.create(
            model=STT_MODEL,
            file=(filename, audio_bytes),
        )

        return {"text": transcript.text}
    except Exception as e:
        print(f"[STT] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
