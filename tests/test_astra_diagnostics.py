"""Safe classification, logging and single-request connectivity tests."""

import unittest
import logging
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock

import openai
from pydantic import ValidationError

from server.astra_coach import generate_review
from server.check_astra import ConnectivityReply, check_connection
from server.diagnostics import (
    CoachingUnavailable,
    classify_error,
    log_failure,
    configure_logging,
)
from server.schemas import ReviewRequest
from test_astra_coach import request_data


def api_error(status, code, message="private transcript and sk-secret"):
    response = SimpleNamespace(
        status_code=status, headers={}, request=SimpleNamespace()
    )
    return openai.APIStatusError(
        message, response=response, body={"code": code, "message": message}
    )


def factory_for(response):
    client = Mock()
    client.responses.parse.return_value = response
    factory = Mock()
    factory.return_value.__enter__ = Mock(return_value=client)
    factory.return_value.__exit__ = Mock(return_value=False)
    return factory, client


class DiagnosticsTests(unittest.TestCase):
    def test_missing_key_classification_and_no_request(self):
        factory = Mock()
        with self.assertRaises(CoachingUnavailable) as caught:
            generate_review(
                ReviewRequest.model_validate(request_data()),
                client_factory=factory,
                environ={},
            )
        self.assertEqual(caught.exception.category, "missing_api_key")
        factory.assert_not_called()

    def test_provider_categories(self):
        cases = [
            (401, "invalid_api_key", "invalid_api_key"),
            (403, "model_access_denied", "model_access_denied"),
            (429, "insufficient_quota", "quota_problem"),
            (400, "billing_not_active", "quota_problem"),
            (429, "rate_limit_exceeded", "rate_limited"),
            (404, "model_not_found", "model_not_found"),
            (403, "permission_denied", "access_denied"),
            (400, "invalid_json_schema", "malformed_request"),
            (500, "server_error", "other_api_error"),
        ]
        for status, code, expected in cases:
            with self.subTest(category=expected):
                error = classify_error(api_error(status, code))
                self.assertEqual(error.category, expected)
                self.assertEqual(error.status, status)
                self.assertNotIn("sk-secret", str(error))

    def test_ambiguous_model_error_is_not_reported_as_certain(self):
        error = api_error(
            404, "model_not_found", "Model does not exist or you do not have access"
        )
        self.assertEqual(classify_error(error).category, "model_unavailable")

    def test_timeout_and_network_categories(self):
        request = SimpleNamespace()
        self.assertEqual(
            classify_error(openai.APITimeoutError(request=request)).category, "timeout"
        )
        self.assertEqual(
            classify_error(openai.APIConnectionError(request=request)).category,
            "network_failure",
        )

    def test_schema_failure_category(self):
        try:
            ConnectivityReply.model_validate({"result": "wrong"})
        except ValidationError as error:
            self.assertEqual(
                classify_error(error).category, "schema_validation_failure"
            )

    def test_logs_contain_no_secret_provider_text_or_transcript(self):
        request = ReviewRequest.model_validate(request_data())
        factory = Mock(side_effect=api_error(401, "invalid_api_key"))
        with self.assertLogs("speakcue.astra", level="INFO") as logs:
            with self.assertRaises(CoachingUnavailable):
                generate_review(
                    request,
                    client_factory=factory,
                    environ={"OPENAI_API_KEY": "sk-secret"},
                )
            log_failure(ValueError("private transcript and sk-secret"))
        output = "\n".join(logs.output)
        for forbidden in (
            "sk-secret",
            "private transcript",
            request.transcript,
            "measuredFacts",
        ):
            self.assertNotIn(forbidden, output)
        self.assertIn("invalid_api_key", output)
        self.assertIn("transcript_words=", output)

    def test_minimal_connectivity_success_has_one_request_and_no_transcript(self):
        factory, client = factory_for(
            SimpleNamespace(
                status="completed", output_parsed=ConnectivityReply(result="ok")
            )
        )
        self.assertEqual(
            check_connection(
                client_factory=factory, environ={"OPENAI_API_KEY": "synthetic"}
            ),
            "gpt-6-astra",
        )
        client.responses.parse.assert_called_once()
        args = client.responses.parse.call_args.kwargs
        self.assertEqual(args["model"], "gpt-6-astra")
        self.assertEqual(args["max_output_tokens"], 256)
        self.assertFalse(args["store"])
        self.assertEqual(factory.call_args.kwargs["max_retries"], 0)
        self.assertNotIn("transcript", args["input"])

    def test_connectivity_failure_does_not_retry_or_fallback(self):
        factory = Mock(side_effect=api_error(403, "model_access_denied"))
        with self.assertRaises(CoachingUnavailable):
            check_connection(
                client_factory=factory, environ={"OPENAI_API_KEY": "synthetic"}
            )
        factory.assert_called_once()

    def test_connectivity_missing_key_does_not_construct_client(self):
        factory = Mock()
        with self.assertRaises(CoachingUnavailable) as caught:
            check_connection(client_factory=factory, environ={})
        self.assertEqual(caught.exception.category, "missing_api_key")
        factory.assert_not_called()

    def test_malformed_connectivity_response(self):
        factory, client = factory_for(
            SimpleNamespace(status="incomplete", output_parsed=None)
        )
        with self.assertRaises(CoachingUnavailable) as caught:
            check_connection(
                client_factory=factory, environ={"OPENAI_API_KEY": "synthetic"}
            )
        self.assertEqual(caught.exception.category, "schema_validation_failure")
        client.responses.parse.assert_called_once()

    def test_sdk_child_logging_is_suppressed(self):
        output = StringIO()
        handler = logging.StreamHandler(output)
        root = logging.getLogger()
        old_handlers = root.handlers[:]
        old_level = root.level
        child = logging.getLogger("openai.synthetic_test")
        old_child_level = child.level
        root.handlers = [handler]
        try:
            configure_logging()
            child.setLevel(logging.DEBUG)
            child.debug("sk-secret private transcript")
            logging.getLogger("speakcue.astra").info("request start")
            self.assertEqual(output.getvalue().strip(), "request start")
        finally:
            root.handlers = old_handlers
            root.setLevel(old_level)
            child.setLevel(old_child_level)
