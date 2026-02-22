"""
Real-time logger that sends progress updates to backend WebSocket
"""

import httpx
from typing import Optional, Any
from config import settings

class RealtimeLogger:
    """Sends real-time log updates to the backend WebSocket server"""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.backend_url = f"{settings.BACKEND_URL}/api/logs/{session_id}"
        self._client = httpx.AsyncClient(timeout=5.0)

    async def log(self, step: str, message: str, log_type: str = "info", data: Optional[Any] = None):
        """Send a log entry to the backend"""
        try:
            payload = {
                "step": step,
                "message": message,
                "type": log_type,
            }
            if data is not None:
                payload["data"] = data

            await self._client.post(self.backend_url, json=payload)
        except Exception as e:
            # Don't let logging failures break the main flow
            print(f"[RealtimeLogger] Failed to send log: {e}")

    async def file_detected(self, filename: str, detected_type: str, confidence: str):
        """Log file detection"""
        await self.log(
            step="file_detection",
            message=f"Detected '{filename}' as {detected_type}",
            log_type="success" if confidence == "high" else "info",
            data={"filename": filename, "type": detected_type, "confidence": confidence}
        )

    async def analyzing_file(self, filename: str):
        """Log file analysis start"""
        await self.log(
            step="file_analysis",
            message=f"Analyzing {filename}...",
            log_type="progress"
        )

    async def parsing_content(self, content_type: str):
        """Log content parsing"""
        await self.log(
            step="parsing",
            message=f"Parsing {content_type} content...",
            log_type="progress"
        )

    async def ai_thinking(self, message: str = "Processing with AI..."):
        """Log AI processing"""
        await self.log(
            step="ai_processing",
            message=message,
            log_type="progress"
        )

    async def thinking(self, message: str):
        """Send a thinking status that replaces previous thinking messages"""
        await self.log(
            step="thinking",
            message=message,
            log_type="thinking"  # Special type for disappearing status
        )

    async def generating_output(self, filename: str):
        """Log output generation"""
        await self.log(
            step="generation",
            message=f"Generating {filename}...",
            log_type="progress"
        )

    async def complete(self, message: str = "Processing complete"):
        """Log completion"""
        await self.log(
            step="complete",
            message=message,
            log_type="success"
        )

    async def error(self, message: str):
        """Log error"""
        await self.log(
            step="error",
            message=message,
            log_type="error"
        )

    async def close(self):
        """Close the HTTP client"""
        await self._client.aclose()
