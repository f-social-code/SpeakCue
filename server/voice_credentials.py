"""Issue Realtime credentials without accepting presentation data."""

import os
import time
from typing import Callable

from openai import OpenAI

VOICE_MODEL = "gpt-realtime-2.1"
VOICE = "marin"
TOKEN_LIFETIME_SECONDS = 60
TOKEN_INTERVAL_SECONDS = 10
VOICE_UNAVAILABLE = "Spoken cues unavailable. Text coaching continues."


def create_voice_credential(
    *, client_factory: Callable = OpenAI, environ: dict | None = None
) -> dict:
    """Keep the permanent key private; never log credentials or errors."""
    env = os.environ if environ is None else environ
    key = env.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("Voice credentials unavailable")
    with client_factory(api_key=key, timeout=10, max_retries=0) as client:
        secret = client.realtime.client_secrets.create(
            expires_after={
                "anchor": "created_at", "seconds": TOKEN_LIFETIME_SECONDS,
            },
            session={
                "type": "realtime",
                "model": VOICE_MODEL,
                "instructions": (
                    "Say only 'Look up.' when explicitly requested. "
                    "No greetings or conversation."
                ),
                "output_modalities": ["audio"],
                "tools": [],
                "tool_choice": "none",
                "tracing": None,
                "audio": {
                    "input": {"turn_detection": None, "transcription": None},
                    "output": {
                        "voice": VOICE,
                        "format": {"type": "audio/pcm", "rate": 24000},
                    },
                },
            },
        )
    if (
        not isinstance(secret.value, str)
        or not secret.value.startswith("ek_")
        or not isinstance(secret.expires_at, (int, float))
        or not time.time() < secret.expires_at <= time.time() + 90
    ):
        raise ValueError("Invalid voice credential")
    return {"value": secret.value, "expires_at": secret.expires_at}
