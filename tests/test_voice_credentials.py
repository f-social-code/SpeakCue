"""Synthetic credential and local HTTP tests; no OpenAI requests are made."""

import gzip
import http.client
import io
import json
import threading
import time
import unittest
from email.message import Message
from types import SimpleNamespace
from unittest.mock import Mock

from server.__main__ import APP_ROOT, Handler, SpeakCueServer
from server.voice_credentials import (
    VOICE_MODEL,
    VOICE_UNAVAILABLE,
    create_voice_credential,
)


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.factory = Mock()
        self.factory.return_value.__enter__ = Mock(return_value=self.client)
        self.factory.return_value.__exit__ = Mock(return_value=False)
        self.create_secret = self.client.realtime.client_secrets.create
        self.create_secret.return_value = SimpleNamespace(
            value="ek_synthetic", expires_at=int(time.time()) + 60
        )

    def test_fixed_output_session_and_short_lived_credential(self):
        result = create_voice_credential(
            client_factory=self.factory,
            environ={"OPENAI_API_KEY": "private-test-key"},
        )
        self.assertEqual(set(result), {"value", "expires_at"})
        self.assertEqual(result["value"], "ek_synthetic")
        self.assertNotIn("private-test-key", json.dumps(result))
        self.factory.assert_called_once_with(
            api_key="private-test-key", timeout=10, max_retries=0
        )
        kwargs = self.client.realtime.client_secrets.create.call_args.kwargs
        self.assertEqual(kwargs["expires_after"]["seconds"], 60)
        session = kwargs["session"]
        self.assertEqual(session["model"], VOICE_MODEL)
        self.assertEqual(session["output_modalities"], ["audio"])
        self.assertEqual(session["audio"]["output"]["voice"], "marin")
        self.assertIsNone(session["audio"]["input"]["turn_detection"])
        self.assertIsNone(session["audio"]["input"]["transcription"])
        self.assertIsNone(session["tracing"])
        self.assertEqual(session["tools"], [])
        self.assertEqual(session["tool_choice"], "none")

    def test_missing_key_does_not_create_client(self):
        with self.assertRaises(ValueError):
            create_voice_credential(client_factory=self.factory, environ={})
        self.factory.assert_not_called()

    def test_astra_model_setting_does_not_change_voice_model(self):
        create_voice_credential(
            client_factory=self.factory,
            environ={"OPENAI_API_KEY": "key", "OPENAI_MODEL": "gpt-6-astra"},
        )
        kwargs = self.client.realtime.client_secrets.create.call_args.kwargs
        self.assertEqual(kwargs["session"]["model"], VOICE_MODEL)

    def test_invalid_or_expired_credentials_are_rejected(self):
        for value, expiry in [
            ("permanent-key", time.time() + 60),
            ("ek_expired", time.time() - 1),
            ("ek_long", time.time() + 10000),
            (None, time.time() + 60),
        ]:
            self.client.realtime.client_secrets.create.return_value = (
                SimpleNamespace(value=value, expires_at=expiry)
            )
            with self.assertRaises(ValueError):
                create_voice_credential(
                    client_factory=self.factory,
                    environ={"OPENAI_API_KEY": "key"},
                )


class VoiceRouteTests(unittest.TestCase):
    """Exercise real route logic without replacing any existing HTTP tests."""

    def setUp(self):
        self.provider = Mock(
            return_value={"value": "ek_test", "expires_at": 42}
        )
        self.server = SimpleNamespace(
            server_port=8000,
            voice_credentials=self.provider,
            voice_lock=threading.Lock(),
            last_voice_token_at=float("-inf"),
        )

    def call(self, body=b"{}", headers=None):
        handler = object.__new__(Handler)
        handler.server = self.server
        handler.path = "/api/voice-token"
        handler.headers = Message()
        values = {
            "Host": "127.0.0.1:8000",
            "Origin": "http://127.0.0.1:8000",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        }
        values.update(headers or {})
        for name, value in values.items():
            if value is not None:
                handler.headers[name] = value
        handler.rfile = io.BytesIO(body)
        handler.json_reply = Mock()
        handler.do_POST()
        return handler.json_reply.call_args.args

    def test_valid_request_returns_only_credential(self):
        status, result = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(set(result), {"value", "expires_at"})
        self.provider.assert_called_once_with()

    def test_host_and_origin_are_required_and_checked(self):
        for headers in [
            {"Host": "example.com"},
            {"Origin": "https://example.com"},
            {"Origin": None},
        ]:
            self.assertEqual(self.call(headers=headers)[0], 403)
        self.provider.assert_not_called()

    def test_transcript_audio_model_override_and_invalid_body_rejected(self):
        for body in [
            b'{"audio":"private"}',
            b'{"transcript":"private"}',
            b'{"model":"other"}',
            b"[]",
            b"null",
            b"not json",
        ]:
            self.assertEqual(self.call(body)[0], 400)
        self.provider.assert_not_called()

    def test_large_body_and_transfer_encoding_rejected(self):
        self.assertEqual(self.call(b"x" * 33)[0], 413)
        for headers in [
            {"Transfer-Encoding": "chunked"}, {"Content-Type": "audio/pcm"},
        ]:
            self.assertEqual(self.call(headers=headers)[0], 415)
        self.provider.assert_not_called()

    def test_errors_do_not_disclose_key_or_provider_exception(self):
        self.provider.side_effect = RuntimeError("private-test-key")
        self.assertEqual(self.call(), (503, {"error": VOICE_UNAVAILABLE}))

    def test_repeated_token_request_is_throttled(self):
        self.assertEqual(self.call()[0], 200)
        self.assertEqual(self.call()[0], 429)
        self.provider.assert_called_once()

    def test_concurrent_request_does_not_issue_another_token(self):
        self.server.voice_lock.acquire()
        try:
            self.assertEqual(self.call()[0], 429)
            self.provider.assert_not_called()
        finally:
            self.server.voice_lock.release()

    def test_lock_released_after_failure(self):
        self.provider.side_effect = RuntimeError("failure")
        self.call()
        self.assertFalse(self.server.voice_lock.locked())

    def test_http_no_store_and_independent_astra_lock(self):
        server = SpeakCueServer(
            ("127.0.0.1", 0), voice_credentials=self.provider
        )
        thread = threading.Thread(
            target=lambda: server.serve_forever(poll_interval=0.05),
            daemon=True,
        )
        thread.start()
        connection = http.client.HTTPConnection(
            "127.0.0.1", server.server_port, timeout=5
        )
        server.review_lock.acquire()
        try:
            connection.request(
                "POST", "/api/voice-token", body="{}",
                headers={
                    "Origin": f"http://127.0.0.1:{server.server_port}",
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertEqual(json.loads(response.read())["value"], "ek_test")
        finally:
            server.review_lock.release()
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_browser_bundle_gzip_transfer_is_complete_and_unchanged(self):
        server = SpeakCueServer(("127.0.0.1", 0))
        thread = threading.Thread(
            target=lambda: server.serve_forever(poll_interval=0.05),
            daemon=True,
        )
        thread.start()
        connection = http.client.HTTPConnection(
            "127.0.0.1", server.server_port, timeout=5
        )
        try:
            connection.request(
                "GET", "/vendor/spoken-cues-sdk.mjs",
                headers={"Accept-Encoding": "gzip, deflate"},
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Encoding"), "gzip")
            self.assertEqual(response.getheader("Connection"), "keep-alive")
            self.assertEqual(
                response.getheader("Content-Type"), "text/javascript"
            )
            body = response.read()
            self.assertEqual(
                len(body), int(response.getheader("Content-Length"))
            )
            self.assertEqual(
                gzip.decompress(body),
                (APP_ROOT / "vendor" / "spoken-cues-sdk.mjs").read_bytes(),
            )
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
