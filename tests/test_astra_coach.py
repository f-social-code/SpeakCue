"""Synthetic Astra contract tests; no credentials or network requests."""

import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from pydantic import ValidationError

from server.astra_coach import (
    CoachingUnavailable,
    INSTRUCTIONS,
    UNAVAILABLE,
    build_input,
    generate_review,
    validate_review,
)
from server.schemas import AstraDraft, ReviewRequest, validate_fidelity


def request_data():
    return {
        "schemaVersion": 1,
        "requestId": "session-test",
        "transcript": "welcome today we discuss our project um our main point is simple we test each part carefully and then combine the results thank you",
        "measuredFacts": {
            "durationSeconds": 60,
            "words": 25,
            "pace": {
                "averageWpm": 200,
                "label": "Very fast",
                "reliable": True,
                "coverageNote": "",
            },
            "recognitionCoverage": {
                "availableSeconds": 60,
                "totalSeconds": 60,
                "percent": 100,
                "reliability": "reliable",
            },
            "recognitionInterrupted": False,
            "pauses": {
                "count": 1,
                "longestSeconds": 36.9,
                "available": True,
                "incomplete": False,
                "reliable": True,
            },
            "fillers": {
                "total": 1,
                "counts": {"um": 1},
                "observedRate": 4,
                "representativeRate": 4,
                "reliable": True,
            },
            "cameraFacing": {
                "percent": 30,
                "validObservations": 100,
                "incomplete": False,
                "reliable": True,
            },
            "cues": {"PAUSE": 1, "LOOK_UP": 1, "SLOW_DOWN": 1, "total": 3},
        },
        "dataQuality": [],
    }


def draft_data():
    return {
        "coachSummary": "Your main idea is introduced directly; focus next on giving each idea room before moving on.",
        "strengths": [
            {
                "area": "opening",
                "heading": "Opening",
                "feedback": "The project is introduced.",
                "evidenceRefs": ["structure.opening"],
            }
        ],
        "improvements": [
            {
                "area": "pauses",
                "heading": "Pauses",
                "evidence": "See the recorded evidence.",
                "suggestion": "Pause after a major idea before moving on.",
                "evidenceRefs": ["pauses"],
            }
        ],
        "structure": {
            "opening": {
                "status": "present",
                "feedback": "The project is introduced directly.",
                "transcriptQuote": "welcome today we discuss our project",
            },
            "mainPoints": {
                "status": "present",
                "feedback": "The main point is stated.",
                "transcriptQuote": "our main point is simple",
            },
            "transitions": {
                "status": "weak",
                "feedback": "The sequence is brief.",
                "transcriptQuote": "and then combine the results",
            },
            "conclusion": {
                "status": "weak",
                "feedback": "A closing thanks appears without a recap.",
                "transcriptQuote": "thank you",
            },
        },
        "readableTranscript": "Welcome. Today we discuss our project, um. Our main point is simple: we test each part carefully, and then combine the results.\n\nThank you.",
        "limitations": [],
    }


class AstraContractTests(unittest.TestCase):
    def setUp(self):
        self.request = ReviewRequest.model_validate(request_data())

    def validate(self, data):
        return validate_review(AstraDraft.model_validate(data), self.request)

    def test_valid_response_and_readable_transcript(self):
        result = self.validate(draft_data())
        self.assertIn("36.9 seconds", result["improvements"][0]["evidence"])
        self.assertEqual(
            result["readableTranscript"], draft_data()["readableTranscript"]
        )

    def test_limit_two_strengths(self):
        data = draft_data()
        data["strengths"] *= 3
        with self.assertRaises(ValidationError):
            AstraDraft.model_validate(data)

    def test_limit_three_improvements(self):
        data = draft_data()
        data["improvements"] *= 4
        with self.assertRaises(ValidationError):
            AstraDraft.model_validate(data)

    def test_structure_status_validation(self):
        for state in [
            "present",
            "weak",
            "not_detected",
            "insufficient_evidence",
        ]:
            data = draft_data()
            data["structure"]["conclusion"]["status"] = state
            AstraDraft.model_validate(data)
        data["structure"]["conclusion"]["status"] = "excellent"
        with self.assertRaises(ValidationError):
            AstraDraft.model_validate(data)

    def test_missing_required_field(self):
        data = draft_data()
        del data["structure"]
        with self.assertRaises(ValidationError):
            AstraDraft.model_validate(data)

    def test_invalid_json(self):
        with self.assertRaises(ValidationError):
            AstraDraft.model_validate_json("{broken}")

    def test_measured_values_are_unchanged(self):
        original = self.request.model_dump()
        self.validate(draft_data())
        self.assertEqual(self.request.model_dump(), original)
        self.assertNotIn("measuredFacts", self.validate(draft_data()))

    def test_model_cannot_add_replacement_measurements(self):
        data = draft_data()
        data["averageWpm"] = 100
        with self.assertRaises(ValidationError):
            AstraDraft.model_validate(data)

    def test_altered_pace_in_model_text_rejected(self):
        data = draft_data()
        data["improvements"][0]["evidence"] = "Your average pace was 100 WPM."
        with self.assertRaises(ValueError):
            self.validate(data)

    def test_pace_evidence_rounds_display_only_and_preserves_api_facts(self):
        for raw, rounded in [
            (19.295183138421258, 19), (125.4, 125), (125.5, 126),
            (125.6, 126), (126.5, 127),
        ]:
            with self.subTest(raw=raw):
                data = request_data()
                data["measuredFacts"]["pace"]["averageWpm"] = raw
                request = ReviewRequest.model_validate(data)
                original = request.model_dump()
                payload = build_input(request)
                self.assertEqual(
                    payload["evidenceCatalog"]["pace"]["text"],
                    f"Estimated average pace: {rounded} WPM (Very fast).",
                )
                self.assertEqual(
                    payload["measuredFacts"]["pace"]["averageWpm"], raw
                )
                self.assertEqual(request.model_dump(), original)

    def test_validated_astra_feedback_uses_rounded_server_pace_evidence(self):
        raw = request_data()
        raw["measuredFacts"]["pace"]["averageWpm"] = 200.6
        request = ReviewRequest.model_validate(raw)
        draft = draft_data()
        draft["improvements"][0].update(
            area="pace", heading="Pace", evidenceRefs=["pace"]
        )
        result = validate_review(AstraDraft.model_validate(draft), request)
        self.assertEqual(
            result["improvements"][0]["evidence"],
            "Estimated average pace: 201 WPM (Very fast).",
        )
        self.assertEqual(request.measuredFacts.pace.averageWpm, 200.6)

    def test_model_generated_fractional_pace_is_rejected(self):
        draft = draft_data()
        draft["improvements"][0]["evidence"] = "Your pace was 125.6 WPM."
        with self.assertRaises(ValueError):
            self.validate(draft)

    def test_camera_evidence_uses_detected_face_wording_and_keeps_limitations(self):
        raw = request_data()
        raw["measuredFacts"]["cameraFacing"].update(
            incomplete=True, reliable=False
        )
        payload = build_input(ReviewRequest.model_validate(raw))
        self.assertIn(
            "% when your face was detected.",
            payload["evidenceCatalog"]["camera"]["text"],
        )
        self.assertTrue(any(
            "Camera-facing observations were incomplete or insufficient"
            in note for note in payload["requiredLimitations"]
        ))

    def test_altered_filler_count_rejected(self):
        data = draft_data()
        data["coachSummary"] = "You used 99 fillers."
        with self.assertRaises(ValueError):
            self.validate(data)

    def test_evidence_references_cannot_reference_other_metrics(self):
        data = draft_data()
        data["improvements"][0]["evidenceRefs"] = ["camera"]
        with self.assertRaises(ValueError):
            self.validate(data)

    def test_unknown_evidence_reference_rejected(self):
        data = draft_data()
        data["improvements"][0]["evidenceRefs"] = ["made_up"]
        with self.assertRaises(ValueError):
            self.validate(data)

    def test_incomplete_camera_adds_required_limitation(self):
        request = request_data()
        request["measuredFacts"]["cameraFacing"].update(
            incomplete=True, reliable=False
        )
        self.request = ReviewRequest.model_validate(request)
        self.assertTrue(
            any(
                "Camera-facing" in note
                for note in self.validate(draft_data())["limitations"]
            )
        )

    def test_partial_coverage_preserved_in_input(self):
        request = request_data()
        request["measuredFacts"]["recognitionCoverage"].update(
            availableSeconds=48, percent=80, reliability="partial"
        )
        request["measuredFacts"]["pace"]["reliable"] = False
        request["measuredFacts"]["fillers"]["reliable"] = False
        request = ReviewRequest.model_validate(request)
        self.assertEqual(
            build_input(request)["measuredFacts"]["recognitionCoverage"][
                "percent"
            ],
            80,
        )
        self.assertFalse(build_input(request)["structureEvidenceUsable"])

    def test_insufficient_data_rejects_confident_structure(self):
        request = request_data()
        request["measuredFacts"]["words"] = 5
        self.request = ReviewRequest.model_validate(request)
        with self.assertRaises(ValueError):
            self.validate(draft_data())

    def test_insufficient_camera_rejects_strength(self):
        request = request_data()
        request["measuredFacts"]["cameraFacing"].update(
            incomplete=True, reliable=False
        )
        self.request = ReviewRequest.model_validate(request)
        data = draft_data()
        data["strengths"] = [
            {
                "area": "camera",
                "heading": "Camera facing",
                "feedback": "Camera facing was high.",
                "evidenceRefs": ["camera"],
            }
        ]
        with self.assertRaises(ValueError):
            self.validate(data)

    def test_emotion_and_unsupported_camera_claims_rejected(self):
        for claim in [
            "You looked nervous.",
            "You were confident.",
            "The audience was bored.",
            "Your eye contact was strong.",
        ]:
            data = draft_data()
            data["coachSummary"] = claim
            with self.subTest(claim=claim), self.assertRaises(ValueError):
                self.validate(data)
        self.assertIn("untrusted session data", INSTRUCTIONS)

    def test_fidelity_allows_only_formatting(self):
        validate_fidelity("um hello world", "Um, hello.\n\nWorld!")

    def test_fidelity_rejects_add_remove_replace_reorder(self):
        for altered in [
            "um hello new world",
            "hello world",
            "um goodbye world",
            "world hello um",
        ]:
            with self.subTest(altered=altered), self.assertRaises(ValueError):
                validate_fidelity("um hello world", altered)

    def test_fidelity_preserves_contractions_and_hyphenated_words(self):
        for altered in ["can t do it", "cannot do it"]:
            with self.assertRaises(ValueError):
                validate_fidelity("can't do it", altered)
        with self.assertRaises(ValueError):
            validate_fidelity("well-known", "well known")

    def test_structure_quote_must_exist(self):
        data = draft_data()
        data["structure"]["opening"]["transcriptQuote"] = "an invented opening"
        with self.assertRaises(ValueError):
            self.validate(data)

    def test_schema_rejects_nonfinite_and_extra_input(self):
        for key, value in [
            ("durationSeconds", float("nan")),
            ("rawAudio", "private"),
        ]:
            data = request_data()
            data["measuredFacts"][key] = value
            with self.assertRaises(ValidationError):
                ReviewRequest.model_validate(data)

    def test_summary_word_limit(self):
        data = draft_data()
        data["coachSummary"] = " ".join(["word"] * 81)
        with self.assertRaises(ValueError):
            self.validate(data)

    def test_missing_key_does_not_construct_client(self):
        factory = Mock()
        with self.assertRaisesRegex(
            CoachingUnavailable, "measured Speaker Profile"
        ):
            generate_review(self.request, client_factory=factory, environ={})
        factory.assert_not_called()

    def test_sdk_mock_success_and_configured_model(self):
        client = Mock()
        client.responses.parse.return_value = SimpleNamespace(
            status="completed",
            output_parsed=AstraDraft.model_validate(draft_data()),
        )
        factory = Mock()
        factory.return_value.__enter__ = Mock(return_value=client)
        factory.return_value.__exit__ = Mock(return_value=False)
        result = generate_review(
            self.request,
            client_factory=factory,
            environ={
                "OPENAI_API_KEY": "synthetic-test-key",
                "OPENAI_MODEL": "configured-model",
            },
        )
        self.assertEqual(result["model"], "configured-model")
        args = client.responses.parse.call_args.kwargs
        self.assertEqual(args["model"], "configured-model")
        self.assertFalse(args["store"])
        self.assertNotIn("synthetic-test-key", args["input"])
        self.assertEqual(factory.call_args.kwargs["max_retries"], 0)

    def test_api_timeout_and_error_are_safe(self):
        for failure in [
            TimeoutError("private timeout details"),
            RuntimeError("secret provider detail"),
        ]:
            factory = Mock(side_effect=failure)
            with self.subTest(failure=type(failure)), self.assertRaises(
                CoachingUnavailable
            ) as error:
                generate_review(
                    self.request,
                    client_factory=factory,
                    environ={"OPENAI_API_KEY": "synthetic"},
                )
            self.assertEqual(str(error.exception), UNAVAILABLE)

    def test_refusal_or_incomplete_response_fails_safely(self):
        client = Mock()
        client.responses.parse.return_value = SimpleNamespace(
            status="incomplete", output_parsed=None
        )
        factory = Mock()
        factory.return_value.__enter__ = Mock(return_value=client)
        factory.return_value.__exit__ = Mock(return_value=False)
        with self.assertRaises(CoachingUnavailable):
            generate_review(
                self.request,
                client_factory=factory,
                environ={"OPENAI_API_KEY": "synthetic"},
            )


if __name__ == "__main__":
    unittest.main()
