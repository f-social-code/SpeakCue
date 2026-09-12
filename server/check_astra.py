"""Explicit, single-request connectivity check. No presentation data is sent."""

import os
from typing import Literal

import openai
from openai import OpenAI

from .astra_coach import MODEL, TIMEOUT_SECONDS
from .diagnostics import (
    CoachingUnavailable,
    LOGGER,
    configure_logging,
    log_failure,
    safe_model,
)
from .schemas import StrictModel


class ConnectivityReply(StrictModel):
    result: Literal["ok"]


def check_connection(*, client_factory=OpenAI, environ=None) -> str:
    """Make at most one tiny structured request with automatic retries disabled."""
    env = os.environ if environ is None else environ
    model = env.get("OPENAI_MODEL", MODEL).strip()
    key = env.get("OPENAI_API_KEY", "").strip()
    LOGGER.info("request received")
    LOGGER.info("model=%s transcript_words=0", safe_model(model))
    try:
        if not key:
            raise CoachingUnavailable("missing_api_key")
        if not model:
            raise CoachingUnavailable("malformed_request")
        LOGGER.info("request start")
        with client_factory(
            api_key=key, timeout=TIMEOUT_SECONDS, max_retries=0
        ) as client:
            response = client.responses.parse(
                model=model,
                input='Return the structured result "ok".',
                text_format=ConnectivityReply,
                store=False,
                reasoning={"effort": "low"},
                max_output_tokens=256,
            )
        LOGGER.info("API response received")
        if response.status != "completed" or response.output_parsed is None:
            raise ValueError("Incomplete structured response")
        ConnectivityReply.model_validate(response.output_parsed.model_dump())
        LOGGER.info("response validation result=passed")
        return model
    except Exception as error:
        failure = log_failure(error)
        if failure.category == "schema_validation_failure":
            LOGGER.info("response validation result=failed")
        raise failure from None


def main() -> int:
    configure_logging()
    print(
        "OPENAI_API_KEY present:",
        "yes" if os.environ.get("OPENAI_API_KEY", "").strip() else "no",
        flush=True,
    )
    print(
        "OPENAI_MODEL:",
        safe_model(os.environ.get("OPENAI_MODEL", MODEL).strip()),
        flush=True,
    )
    print("OpenAI SDK:", openai.__version__, flush=True)
    try:
        model = check_connection()
    except CoachingUnavailable as error:
        print(f"Connectivity failed: {error.category}; HTTP status: {error.status}")
        return 1
    print(
        f"Connectivity OK: {safe_model(model)}; key accepted; structured response validated."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
