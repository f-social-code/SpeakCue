"""Serve SpeakCue and its review endpoint on loopback only."""

import gzip
import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from pydantic import ValidationError

from .astra_coach import UNAVAILABLE, generate_review
from .schemas import ReviewRequest
from .voice_credentials import (
    TOKEN_INTERVAL_SECONDS,
    VOICE_UNAVAILABLE,
    create_voice_credential,
)
from .diagnostics import (
    CoachingUnavailable,
    LOGGER,
    configure_logging,
    log_failure,
    safe_model,
)

APP_ROOT = Path(__file__).resolve().parent.parent / "app"
MAX_REQUEST_BYTES = 500_000


class SpeakCueServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        coach=generate_review,
        development=False,
        voice_credentials=create_voice_credential,
    ):
        if address[0] != "127.0.0.1":
            raise ValueError("SpeakCue must bind to loopback")
        self.development = development
        self.coach = coach
        self.review_lock = threading.Lock()
        self.voice_credentials = voice_credentials
        self.voice_lock = threading.Lock()
        self.last_voice_token_at = float("-inf")
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "SpeakCue"

    def log_message(self, format: str, *args) -> None:
        """Avoid logging URLs, transcripts, SDK failures or credentials."""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def local_request(self, require_origin: bool = False) -> bool:
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return (
            host in hosts
            and (not require_origin or origin == f"http://{host}")
            and (origin is None or origin == f"http://{host}")
        )

    def reply(
        self, status: int, body: bytes, content_type: str,
        content_encoding: str | None = None,
        keep_alive: bool = False,
    ) -> None:
        if keep_alive:
            self.protocol_version = "HTTP/1.1"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if content_encoding:
            self.send_header("Content-Encoding", content_encoding)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Connection", "keep-alive" if keep_alive else "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = not keep_alive

    def json_reply(self, status: int, value: dict) -> None:
        self.reply(
            status,
            json.dumps(value, allow_nan=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def do_GET(self) -> None:
        if not self.local_request():
            self.json_reply(403, {"error": "Local requests only."})
            return
        path = unquote(urlsplit(self.path).path)
        relative = path.lstrip("/") or "index.html"
        file = (APP_ROOT / relative).resolve()
        if (
            not file.is_relative_to(APP_ROOT)
            or not file.is_file()
            or any(part.startswith(".") for part in Path(relative).parts)
        ):
            self.json_reply(404, {"error": "Not found."})
            return
        content_type = {
            ".mjs": "text/javascript",
            ".js": "text/javascript",
            ".wasm": "application/wasm",
        }.get(file.suffix)
        content_type = (
            content_type
            or mimetypes.guess_type(file.name)[0]
            or "application/octet-stream"
        )
        body = file.read_bytes()
        encodings = self.headers.get("Accept-Encoding", "").split(",")
        if (
            file == APP_ROOT / "vendor" / "spoken-cues-sdk.mjs"
            and "gzip" in {value.strip() for value in encodings}
        ):
            # Leave this larger transfer open until Chrome has read it. Other
            # responses retain the existing connection-close behaviour.
            self.reply(200, gzip.compress(body), content_type, "gzip", True)
            return
        self.reply(200, body, content_type)

    def failure_reply(self, status: int, error: Exception) -> None:
        failure = log_failure(error)
        value = {"error": UNAVAILABLE}
        if self.server.development:
            value.update(development=True, category=failure.category)
        self.json_reply(status, value)

    def do_POST(self) -> None:
        if self.path == "/api/voice-token":
            self.voice_token()
            return
        LOGGER.info("request received")
        if not self.local_request(require_origin=True):
            self.json_reply(403, {"error": UNAVAILABLE})
            return
        if self.path != "/api/astra-review":
            self.json_reply(404, {"error": UNAVAILABLE})
            return
        if self.headers.get_content_type() != "application/json" or self.headers.get(
            "Transfer-Encoding"
        ):
            self.json_reply(415, {"error": UNAVAILABLE})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_REQUEST_BYTES:
                self.json_reply(413, {"error": UNAVAILABLE})
                return
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("Incomplete body")
            request = ReviewRequest.model_validate_json(body)
        except (ValueError, ValidationError, OSError):
            self.failure_reply(400, CoachingUnavailable("malformed_request"))
            return
        if not self.server.review_lock.acquire(blocking=False):
            self.json_reply(429, {"error": UNAVAILABLE})
            return
        try:
            self.json_reply(200, self.server.coach(request))
        except Exception as error:
            self.failure_reply(503, error)
        finally:
            self.server.review_lock.release()

    def voice_token(self) -> None:
        """Accept only an empty object from this local page, never audio/text."""
        if not self.local_request(require_origin=True):
            self.json_reply(403, {"error": VOICE_UNAVAILABLE})
            return
        if self.headers.get_content_type() != "application/json" or self.headers.get(
            "Transfer-Encoding"
        ):
            self.json_reply(415, {"error": VOICE_UNAVAILABLE})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 32:
                self.json_reply(413, {"error": VOICE_UNAVAILABLE})
                return
            body = self.rfile.read(size)
            if len(body) != size or json.loads(body) != {}:
                raise ValueError("Expected an empty object")
        except (ValueError, OSError):
            self.json_reply(400, {"error": VOICE_UNAVAILABLE})
            return
        if not self.server.voice_lock.acquire(blocking=False):
            self.json_reply(429, {"error": VOICE_UNAVAILABLE})
            return
        try:
            now = time.monotonic()
            if now - self.server.last_voice_token_at < TOKEN_INTERVAL_SECONDS:
                self.json_reply(429, {"error": VOICE_UNAVAILABLE})
                return
            self.server.last_voice_token_at = now
            self.json_reply(200, self.server.voice_credentials())
        except Exception:
            self.json_reply(503, {"error": VOICE_UNAVAILABLE})
        finally:
            self.server.voice_lock.release()


def main() -> None:
    configure_logging()
    print(
        "OPENAI_API_KEY present:",
        "yes" if os.environ.get("OPENAI_API_KEY", "").strip() else "no",
        flush=True,
    )
    print(
        "OPENAI_MODEL:",
        safe_model(os.environ.get("OPENAI_MODEL", "gpt-6-astra").strip()),
        flush=True,
    )
    try:
        server = SpeakCueServer(
            ("127.0.0.1", 8000),
            development=os.environ.get("SPEAKCUE_DEVELOPMENT") == "1",
        )
    except OSError:
        print("Port 8000 is unavailable. Stop the previous local server and try again.")
        return
    print("SpeakCue: http://127.0.0.1:8000 — open in Chrome. Ctrl+C stops the server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
