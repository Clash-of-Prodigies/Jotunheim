#!/usr/bin/env python3
"""Build a reproducible, randomized 40-question Clash of Prodigies match."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import re
import secrets
import shutil
import sys
import tempfile
from typing import Iterable

from question_tools import (
    Question,
    QuestionBankError,
    SUBJECTS,
    ensure_unique_pool_filenames,
    load_questions,
    question_bank_hash,
    require_expected_png,
)
from rendering import TEMPLATE_VERSION


BASE_DIR = Path(__file__).resolve().parent
GENERATOR_VERSION = "1.0.0"
SELECTION_ALGORITHM_VERSION = "1"
QUESTIONS_PER_SUBJECT = 10
TOTAL_QUESTIONS = QUESTIONS_PER_SUBJECT * len(SUBJECTS)
MATCH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


class MatchBuildError(RuntimeError):
    """Raised when a complete match cannot be built safely."""


def generate_seed() -> int:
    return secrets.randbits(128)


def parse_seed(value: str) -> int:
    try:
        seed = int(value, 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError("seed must be a decimal integer") from error
    if seed < 0 or seed >= 2**128:
        raise argparse.ArgumentTypeError("seed must be between 0 and 2^128 - 1")
    return seed


def validate_match_identifier(match: str) -> str:
    if not MATCH_PATTERN.fullmatch(match) or match in {".", ".."}:
        raise MatchBuildError(
            "Match identifier must start with a letter or number and contain only "
            "letters, numbers, dots, underscores, or hyphens (maximum 80 characters)."
        )
    return match


def available_questions(
    questions: Iterable[Question], pool_dir: Path
) -> tuple[dict[str, list[Question]], list[str]]:
    grouped = {subject: [] for subject in SUBJECTS}
    warnings: list[str] = []
    for question in questions:
        image = pool_dir / question.pool_filename
        try:
            require_expected_png(image)
        except ValueError as error:
            warnings.append(str(error))
            continue
        grouped[question.subject].append(question)
    for subject in SUBJECTS:
        grouped[subject].sort(key=lambda question: question.id)
    return grouped, warnings


def select_questions(
    questions: Iterable[Question], pool_dir: Path, seed: int
) -> tuple[list[Question], list[str]]:
    grouped, warnings = available_questions(questions, pool_dir)
    shortages = [
        f"{subject}: {len(grouped[subject])} available, {QUESTIONS_PER_SUBJECT} required"
        for subject in SUBJECTS
        if len(grouped[subject]) < QUESTIONS_PER_SUBJECT
    ]
    if shortages:
        detail = "\n- ".join(shortages)
        raise MatchBuildError(f"Insufficient rendered questions:\n- {detail}")

    rng = random.Random(seed)
    selected: list[Question] = []
    for subject in SUBJECTS:
        selected.extend(rng.sample(grouped[subject], QUESTIONS_PER_SUBJECT))
    rng.shuffle(selected)
    return selected, warnings


def _manifest(
    match: str,
    seed: int,
    questions: list[Question],
    bank_hash: str,
) -> dict[str, object]:
    subject_counts = Counter(question.subject for question in questions)
    ordered: list[dict[str, object]] = []
    for position, question in enumerate(questions, start=1):
        output_filename = f"{position:02d}_{question.pool_filename}"
        ordered.append(
            {
                "position": position,
                "id": question.id,
                "subject": question.subject,
                "author": question.author,
                "question": question.question,
                "pool_filename": question.pool_filename,
                "output_filename": output_filename,
            }
        )
    return {
        "match": match,
        "seed": str(seed),
        "question_bank_hash": bank_hash,
        "generator_version": GENERATOR_VERSION,
        "selection_algorithm_version": SELECTION_ALGORITHM_VERSION,
        "template_version": TEMPLATE_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "total_questions": len(questions),
        "subject_counts": {subject: subject_counts[subject] for subject in SUBJECTS},
        "questions": ordered,
    }


def build_match(
    *,
    match: str,
    seed: int,
    bank_path: Path,
    pool_dir: Path,
    output_root: Path,
    overwrite: bool = False,
) -> tuple[Path, dict[str, object], list[str]]:
    validate_match_identifier(match)
    questions = load_questions(bank_path)
    ensure_unique_pool_filenames(questions)
    selected, warnings = select_questions(questions, pool_dir, seed)
    if len(selected) != TOTAL_QUESTIONS:
        raise MatchBuildError(f"Internal selection error: expected {TOTAL_QUESTIONS} questions.")

    target = output_root / match
    if target.exists() and not overwrite:
        raise MatchBuildError(
            f"Match output already exists: {target}. Choose another match identifier or use --overwrite."
        )
    output_root.mkdir(parents=True, exist_ok=True)
    manifest = _manifest(match, seed, selected, question_bank_hash(questions))
    temporary = Path(tempfile.mkdtemp(prefix=f".{match}.", dir=output_root))
    try:
        for entry, question in zip(manifest["questions"], selected, strict=True):
            if not isinstance(entry, dict):
                raise MatchBuildError("Internal manifest construction error.")
            source = pool_dir / question.pool_filename
            destination = temporary / str(entry["output_filename"])
            shutil.copy2(source, destination)
        (temporary / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        if target.exists():
            shutil.rmtree(target)
        temporary.replace(target)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return target, manifest, warnings


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--match", required=True, help="private fixture/output identifier")
    command.add_argument("--seed", type=parse_seed, help="128-bit decimal seed for reproduction")
    command.add_argument("--bank", type=Path, default=BASE_DIR / "questions.json")
    command.add_argument("--pool", type=Path, default=BASE_DIR / "pool")
    command.add_argument("--output", type=Path, default=BASE_DIR / "output")
    command.add_argument(
        "--overwrite",
        action="store_true",
        help="intentionally replace an existing output directory for this match",
    )
    return command


def run(arguments: argparse.Namespace) -> int:
    seed = arguments.seed if arguments.seed is not None else generate_seed()
    target, manifest, warnings = build_match(
        match=arguments.match,
        seed=seed,
        bank_path=arguments.bank.resolve(),
        pool_dir=arguments.pool.resolve(),
        output_root=arguments.output.resolve(),
        overwrite=arguments.overwrite,
    )
    print(f"Match: {manifest['match']}")
    print(f"Seed: {manifest['seed']}")
    print(f"Questions: {manifest['total_questions']}")
    print("Subjects: " + ", ".join(
        f"{subject}={manifest['subject_counts'][subject]}" for subject in SUBJECTS
    ))
    print(f"Output: {target}")
    print(f"Manifest: {target / 'manifest.json'}")
    if warnings:
        print(f"Warnings: {len(warnings)} unavailable pool image(s) were excluded.")
        for warning in warnings:
            print(f"- {warning}")
    return 0


def main() -> int:
    try:
        return run(parser().parse_args())
    except (QuestionBankError, MatchBuildError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

