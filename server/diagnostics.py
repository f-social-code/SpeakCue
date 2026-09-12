"""Allowlisted diagnostics: never format provider exceptions or session data."""

import logging
import re

import openai
from pydantic import ValidationError

UNAVAILABLE = (
    "Astra coaching is unavailable. Your measured Speaker Profile is still available."
)
CATEGORIES = frozenset(
    {
        "missing_api_key",
        "invalid_api_key",
        "quota_problem",
        "rate_limited",
        "model_access_denied",
        "model_not_found",
        "model_unavailable",
        "access_denied",
        "malformed_request",
        "schema_validation_failure",
        "timeout",
        "network_failure",
        "other_api_error",
    }
)
LOGGER = logging.getLogger("speakcue.astra")


class CoachingUnavailable(Exception):
    """Carry only an allowlisted category and optional HTTP status."""

    def __init__(self, category: str = "other_api_error", status: int | None = None):
        super().__init__(UNAVAILABLE)
        self.category = category if category in CATEGORIES else "other_api_error"
        self.status = status if type(status) is int and 100 <= status <= 599 else None


def classify_error(error: Exception) -> CoachingUnavailable:
    """Classify SDK errors without returning their message or body."""
    if isinstance(error, CoachingUnavailable):
        return error
    status = getattr(error, "status_code", None)
    body = getattr(error, "body", None)
    body = body if isinstance(body, dict) else {}
    body = body.get("error", body)
    body = body if isinstance(body, dict) else {}
    code = body.get("code")
    code = code if isinstance(code, str) else None
    if isinstance(error, (openai.APITimeoutError, TimeoutError)):
        category = "timeout"
    elif isinstance(error, openai.APIConnectionError):
        category = "network_failure"
    elif status == 401:
        category = "invalid_api_key"
    elif code in {
        "insufficient_quota",
        "billing_hard_limit_reached",
        "billing_not_active",
    }:
        category = "quota_problem"
    elif code in {"model_access_denied", "model_permission_denied"}:
        category = "model_access_denied"
    elif code == "model_not_found":
        # Providers may use this code for both an absent model and lack of access.
        message = body.get("message", "")
        ambiguous = isinstance(message, str) and "access" in message.lower()
        category = "model_unavailable" if ambiguous else "model_not_found"
    elif status == 403:
        category = "access_denied"
    elif status == 429:
        category = "rate_limited"
    elif status in {400, 422}:
        category = "malformed_request"
    elif isinstance(
        error, (ValidationError, ValueError, openai.APIResponseValidationError)
    ):
        category = "schema_validation_failure"
    else:
        category = "other_api_error"
    return CoachingUnavailable(category, status)


def safe_model(model: str) -> str:
    """Only a model identifier can enter diagnostic output."""
    return (
        model
        if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,80}", model) and not model.startswith("sk-")
        else "invalid_model_configuration"
    )


def log_failure(error: Exception) -> CoachingUnavailable:
    failure = classify_error(error)
    LOGGER.info("error category=%s http_status=%s", failure.category, failure.status)
    return failure


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    LOGGER.setLevel(logging.INFO)
    # Filter descendants too: disabling a parent alone does not stop propagation.
    for handler in logging.getLogger().handlers:
        handler.addFilter(lambda record: record.name == "speakcue.astra")
    # SDK debug logging can contain request bodies. Never enable it here.
    for name in ("openai", "httpx", "httpcore", "httpx2"):
        logging.getLogger(name).disabled = True
