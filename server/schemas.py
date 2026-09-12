"""Strict boundaries for session facts and model-authored coaching."""

import re
import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Number = Annotated[float, Field(ge=0)]
Count = Annotated[int, Field(ge=0)]
ShortText = Annotated[str, Field(min_length=1, max_length=600)]
Area = Literal[
    "pace",
    "pauses",
    "fillers",
    "camera",
    "opening",
    "mainPoints",
    "transitions",
    "conclusion",
]
Status = Literal["present", "weak", "not_detected", "insufficient_evidence"]


class StrictModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, allow_inf_nan=False, frozen=True
    )


class Pace(StrictModel):
    averageWpm: Number | None
    label: str
    reliable: bool
    coverageNote: str


class Coverage(StrictModel):
    availableSeconds: Number
    totalSeconds: Number
    percent: Annotated[float, Field(ge=0, le=100)] | None
    reliability: Literal["reliable", "partial", "insufficient"]


class Pauses(StrictModel):
    count: Count | None
    longestSeconds: Number | None
    reliable: bool
    available: bool
    incomplete: bool


class Fillers(StrictModel):
    total: Count
    counts: dict[str, Count]
    observedRate: Number | None
    representativeRate: Number | None
    reliable: bool


class Camera(StrictModel):
    percent: Annotated[float, Field(ge=0, le=100)] | None
    validObservations: Count
    reliable: bool
    incomplete: bool


class Cues(StrictModel):
    PAUSE: Count
    LOOK_UP: Count
    SLOW_DOWN: Count
    total: Count


class Facts(StrictModel):
    durationSeconds: Number
    words: Count
    pace: Pace
    recognitionCoverage: Coverage
    recognitionInterrupted: bool
    pauses: Pauses
    fillers: Fillers
    cameraFacing: Camera
    cues: Cues

    @model_validator(mode="after")
    def consistent(self) -> "Facts":
        if sum(self.fillers.counts.values()) != self.fillers.total:
            raise ValueError("Inconsistent filler totals")
        if (
            self.cues.total
            != self.cues.PAUSE + self.cues.LOOK_UP + self.cues.SLOW_DOWN
        ):
            raise ValueError("Inconsistent cue totals")
        coverage = self.recognitionCoverage
        if coverage.availableSeconds > coverage.totalSeconds:
            raise ValueError("Invalid coverage durations")
        if (
            self.pace.reliable or self.fillers.reliable
        ) and coverage.reliability != "reliable":
            raise ValueError("Inconsistent recognition reliability")
        if self.pauses.reliable and (
            not self.pauses.available or self.pauses.incomplete
        ):
            raise ValueError("Inconsistent audio reliability")
        if self.cameraFacing.reliable and (
            self.cameraFacing.incomplete or self.cameraFacing.percent is None
        ):
            raise ValueError("Inconsistent camera reliability")
        return self


class ReviewRequest(StrictModel):
    schemaVersion: Literal[1]
    requestId: Annotated[str, Field(min_length=1, max_length=80)]
    transcript: Annotated[str, Field(min_length=1, max_length=40000)]
    measuredFacts: Facts
    dataQuality: Annotated[list[ShortText], Field(max_length=20)]


class StructurePart(StrictModel):
    status: Status
    feedback: ShortText
    transcriptQuote: Annotated[str, Field(max_length=400)]


class Structure(StrictModel):
    opening: StructurePart
    mainPoints: StructurePart
    transitions: StructurePart
    conclusion: StructurePart


class Strength(StrictModel):
    area: Area
    heading: Annotated[str, Field(min_length=1, max_length=60)]
    feedback: ShortText
    evidenceRefs: Annotated[list[str], Field(min_length=1, max_length=3)]


class Improvement(StrictModel):
    area: Area
    heading: Annotated[str, Field(min_length=1, max_length=60)]
    evidence: ShortText
    suggestion: ShortText
    evidenceRefs: Annotated[list[str], Field(min_length=1, max_length=3)]


class AstraDraft(StrictModel):
    coachSummary: Annotated[str, Field(min_length=1, max_length=1000)]
    strengths: Annotated[list[Strength], Field(max_length=2)]
    improvements: Annotated[list[Improvement], Field(max_length=3)]
    structure: Structure
    readableTranscript: Annotated[str, Field(min_length=1, max_length=60000)]
    limitations: Annotated[list[ShortText], Field(max_length=12)]


def spoken_words(text: str) -> list[str]:
    """Preserve word order and internal apostrophes/hyphens; ignore case."""
    return re.findall(r"\w+(?:['’\-]\w+)*", text.lower(), flags=re.UNICODE)


def validate_fidelity(original: str, readable: str) -> None:
    """Reject added, deleted, substituted, split or reordered spoken words."""
    if spoken_words(original) != spoken_words(readable):
        raise ValueError("Readable transcript changed spoken words")
    # Only punctuation, whitespace and original word characters may differ.
    if any(
        not (
            char.isalnum()
            or char.isspace()
            or char == "_"
            or unicodedata.category(char).startswith("P")
        )
        for char in readable
    ):
        raise ValueError("Readable transcript contains unsupported symbols")
