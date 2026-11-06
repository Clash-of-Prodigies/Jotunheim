"""Shared validation, identity, naming, and PNG helpers for Angrboda."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import struct
import unicodedata
from typing import Any, Iterable


SUBJECTS = ("Mathematics", "Physics", "Chemistry", "Biology")
SUBJECT_ABBREVIATIONS = {
    "Mathematics": "MATH",
    "Physics": "PHYS",
    "Chemistry": "CHEM",
    "Biology": "BIO",
}
REQUIRED_FIELDS = frozenset(("question", "author", "subject"))
EXPECTED_IMAGE_SIZE = (1920, 1080)
MAX_QUESTION_CHARACTERS = 1_200
FILENAME_HASH_LENGTH = 8


class QuestionBankError(ValueError):
    """Raised when the question bank cannot be validated."""


@dataclass(frozen=True, slots=True)
class Question:
    question: str
    author: str
    subject: str
    id: str

    def record(self) -> dict[str, str]:
        return {
            "question": self.question,
            "author": self.author,
            "subject": self.subject,
        }

    @property
    def pool_filename(self) -> str:
        return make_pool_filename(self)


def canonical_record(record: dict[str, str]) -> str:
    """Return the deterministic representation used for question identities."""
    return json.dumps(
        {
            "author": record["author"],
            "question": record["question"],
            "subject": record["subject"],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def question_identifier(record: dict[str, str]) -> str:
    return hashlib.sha256(canonical_record(record).encode("utf-8")).hexdigest()


def validate_records(raw: Any) -> list[Question]:
    if not isinstance(raw, list):
        raise QuestionBankError("Question bank must be a JSON array.")

    questions: list[Question] = []
    seen_records: dict[str, int] = {}
    errors: list[str] = []

    for index, item in enumerate(raw, start=1):
        label = f"Record {index}"
        if not isinstance(item, dict):
            errors.append(f"{label}: expected an object, got {type(item).__name__}.")
            continue

        keys = frozenset(item)
        if keys != REQUIRED_FIELDS:
            missing = sorted(REQUIRED_FIELDS - keys)
            extra = sorted(keys - REQUIRED_FIELDS)
            details: list[str] = []
            if missing:
                details.append(f"missing {', '.join(missing)}")
            if extra:
                details.append(f"unexpected {', '.join(extra)}")
            errors.append(f"{label}: fields must be exactly question, author, subject ({'; '.join(details)}).")
            continue

        invalid_fields = [
            field for field in REQUIRED_FIELDS
            if not isinstance(item[field], str) or not item[field].strip()
        ]
        if invalid_fields:
            errors.append(f"{label}: nonempty strings required for {', '.join(sorted(invalid_fields))}.")
            continue

        subject = item["subject"]
        if subject not in SUBJECTS:
            errors.append(
                f"{label}: unsupported subject {subject!r}; expected one of {', '.join(SUBJECTS)}."
            )
            continue
        if len(item["question"]) > MAX_QUESTION_CHARACTERS:
            errors.append(
                f"{label}: question is {len(item['question'])} characters; "
                f"maximum supported length is {MAX_QUESTION_CHARACTERS}."
            )
            continue

        record = {
            "question": item["question"],
            "author": item["author"],
            "subject": subject,
        }
        canonical = canonical_record(record)
        earlier = seen_records.get(canonical)
        if earlier is not None:
            errors.append(f"{label}: exact duplicate of record {earlier}.")
            continue
        seen_records[canonical] = index
        questions.append(Question(**record, id=question_identifier(record)))

    if errors:
        raise QuestionBankError("Invalid question bank:\n- " + "\n- ".join(errors))
    return questions


def load_questions(path: Path) -> list[Question]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise QuestionBankError(f"Question bank not found: {path}") from error
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as error:
        raise QuestionBankError(
            f"Invalid JSON in {path} at line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error
    return validate_records(raw)


def question_bank_hash(questions: Iterable[Question]) -> str:
    canonical_questions = sorted(canonical_record(question.record()) for question in questions)
    canonical_bank = "[" + ",".join(canonical_questions) + "]"
    return hashlib.sha256(canonical_bank.encode("utf-8")).hexdigest()


def _ascii_slug(value: str, fallback: str, maximum: int) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9]+", "-", ascii_value).strip("-")
    slug = re.sub(r"-+", "-", slug)
    if not slug:
        slug = fallback
    return slug[:maximum].rstrip("-") or fallback


def make_pool_filename(question: Question) -> str:
    author = _ascii_slug(question.author, "Author", 32)
    phrase_words = re.findall(r"[A-Za-z0-9]+", unicodedata.normalize("NFKD", question.question))
    phrase = _ascii_slug(" ".join(phrase_words[:6]), "Question", 52)
    abbreviation = SUBJECT_ABBREVIATIONS[question.subject]
    return f"{abbreviation}_{author}_{phrase}_{question.id[:FILENAME_HASH_LENGTH]}.png"


def ensure_unique_pool_filenames(questions: Iterable[Question]) -> None:
    filenames: dict[str, str] = {}
    for question in questions:
        filename = question.pool_filename
        existing = filenames.get(filename)
        if existing is not None and existing != question.id:
            raise QuestionBankError(
                f"Generated filename collision for {filename}; increase the hash length or revise the records."
            )
        filenames[filename] = question.id


def png_dimensions(path: Path) -> tuple[int, int]:
    try:
        header = path.read_bytes()[:24]
    except FileNotFoundError as error:
        raise ValueError(f"PNG not found: {path}") from error
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Not a valid PNG header: {path}")
    return struct.unpack(">II", header[16:24])


def require_expected_png(path: Path) -> None:
    dimensions = png_dimensions(path)
    if dimensions != EXPECTED_IMAGE_SIZE:
        raise ValueError(
            f"Unexpected image dimensions for {path}: {dimensions[0]}x{dimensions[1]}; "
            f"expected {EXPECTED_IMAGE_SIZE[0]}x{EXPECTED_IMAGE_SIZE[1]}."
        )

