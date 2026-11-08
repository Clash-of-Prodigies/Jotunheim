#!/usr/bin/env python3
"""Generate the reusable PNG pool from the Angrboda question bank."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from question_tools import (
    QuestionBankError,
    ensure_unique_pool_filenames,
    load_questions,
    require_expected_png,
)
from rendering import QuestionRenderError, render_question


BASE_DIR = Path(__file__).resolve().parent


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--bank", type=Path, default=BASE_DIR / "kahoot.json")
    command.add_argument("--pool", type=Path, default=BASE_DIR / "pool")
    command.add_argument("--template", type=Path, default=BASE_DIR / "question.typ")
    command.add_argument("--logo", type=Path, default=BASE_DIR / "assets" / "logo.png")
    command.add_argument(
        "--force",
        action="store_true",
        help="intentionally rerender and replace matching deterministic pool files",
    )
    return command


def run(arguments: argparse.Namespace) -> int:
    questions = load_questions(arguments.bank.resolve())
    ensure_unique_pool_filenames(questions)
    template = arguments.template.resolve()
    if not template.is_file():
        raise QuestionBankError(f"Typst template not found: {template}")

    pool = arguments.pool.resolve()
    pool.mkdir(parents=True, exist_ok=True)
    rendered = 0
    skipped = 0
    failures: list[str] = []

    for question in questions:
        output = pool / question.pool_filename
        if output.exists() and not arguments.force:
            try:
                require_expected_png(output)
                skipped += 1
                print(f"SKIP   {output.name}")
            except ValueError as error:
                failures.append(f"{error} Use --force to replace it intentionally.")
            continue
        try:
            render_question(
                question,
                output,
                template_path=template,
                project_root=BASE_DIR,
                logo_path=arguments.logo.resolve(),
            )
            rendered += 1
            print(f"OK     {output.name}")
        except QuestionRenderError as error:
            failures.append(str(error))
            print(f"FAILED {question.id[:8]} ({question.subject}, {question.author})", file=sys.stderr)

    print(f"\nQuestion bank: {len(questions)}")
    print(f"Rendered: {rendered}")
    print(f"Already valid: {skipped}")
    print(f"Failed: {len(failures)}")
    print(f"Pool: {pool}")
    if failures:
        print("\nRender failures:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    try:
        return run(parser().parse_args())
    except (QuestionBankError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

