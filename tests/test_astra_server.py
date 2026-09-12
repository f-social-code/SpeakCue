"""Loopback HTTP tests with an injected coach, never the OpenAI service."""

import http.client
import json
import threading
import unittest
from unittest.mock import Mock

from server.__main__ import SpeakCueServer
from server.astra_coach import UNAVAILABLE
from server.diagnostics import CoachingUnavailable
from test_astra_coach import request_data


class LocalServerTests(unittest.TestCase):
    def setUp(self):
        self.coach = Mock(
            return_value={
                "requestId": "session-test",
                "model": "gpt-6-astra",
                "review": {},
            }
        )
        self.server = SpeakCueServer(("127.0.0.1", 0), coach=self.coach)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f"127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, method="POST", path="/api/astra-review", body=None, headers=None):
        conn = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=5
        )
        payload = json.dumps(request_data()) if body is None else body
        base = {
            "Content-Type": "application/json",
            "Origin": f"http://{self.host}",
        }
        base.update(headers or {})
        conn.request(
            method,
            path,
            body=payload if method == "POST" else None,
            headers=base,
        )
        response = conn.getresponse()
        data = response.read()
        status = response.status
        conn.close()
        return status, data

    def test_valid_request_reaches_coach(self):
        status, data = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["requestId"], "session-test")
        self.coach.assert_called_once()

    def test_foreign_origin_is_rejected(self):
        self.assertEqual(self.call(headers={"Origin": "https://example.com"})[0], 403)
        self.coach.assert_not_called()

    def test_host_header_is_checked(self):
        self.assertEqual(self.call(headers={"Host": "example.com"})[0], 403)

    def test_invalid_json_and_missing_fields(self):
        for body in ["not JSON", "{}"]:
            self.assertEqual(self.call(body=body)[0], 400)
        self.coach.assert_not_called()

    def test_large_body_rejected(self):
        self.assertEqual(
            self.call(body="", headers={"Content-Length": "500001"})[0], 413
        )

    def test_content_type_rejected(self):
        self.assertEqual(self.call(headers={"Content-Type": "text/plain"})[0], 415)

    def test_provider_error_is_safe(self):
        self.coach.side_effect = RuntimeError("private key and transcript")
        status, data = self.call()
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(data), {"error": UNAVAILABLE})
        self.assertNotIn(b"private key", data)

    def test_development_returns_only_safe_category(self):
        self.server.development = True
        self.coach.side_effect = CoachingUnavailable("model_access_denied", 403)
        status, data = self.call()
        self.assertEqual(status, 503)
        self.assertEqual(
            json.loads(data),
            {
                "error": UNAVAILABLE,
                "development": True,
                "category": "model_access_denied",
            },
        )

    def test_production_hides_category(self):
        self.coach.side_effect = CoachingUnavailable("invalid_api_key", 401)
        self.assertEqual(json.loads(self.call()[1]), {"error": UNAVAILABLE})

    def test_invalid_request_has_safe_development_category(self):
        self.server.development = True
        status, data = self.call(body="private invalid request")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(data)["category"], "malformed_request")
        self.assertNotIn(b"private", data)

    def test_only_app_files_are_served(self):
        self.assertEqual(self.call("GET", "/")[0], 200)
        self.assertEqual(self.call("GET", "/astra-review.mjs")[0], 200)
        for path in [
            "/../server/schemas.py",
            "/%2e%2e/AGENTS.md",
            "/.env",
            "/server/schemas.py",
        ]:
            self.assertEqual(self.call("GET", path)[0], 404)

    def test_busy_request_does_not_duplicate_api_call(self):
        self.server.review_lock.acquire()
        try:
            self.assertEqual(self.call()[0], 429)
            self.coach.assert_not_called()
        finally:
            self.server.review_lock.release()

    def test_nonlocal_bind_rejected(self):
        with self.assertRaises(ValueError):
            SpeakCueServer(("0.0.0.0", 8000))


if __name__ == "__main__":
    unittest.main()
