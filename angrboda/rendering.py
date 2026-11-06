"""Typst-backed rendering for Angrboda question images."""

from __future__ import annotations

import os
from pathlib import Path
import uuid

import typst

from question_tools import Question, require_expected_png


TEMPLATE_VERSION = "1"
PNG_PPI = 144


class QuestionRenderError(RuntimeError):
    """Raised when one question cannot be rendered safely."""


def render_question(
    question: Question,
    output_path: Path,
    *,
    template_path: Path,
    project_root: Path,
    logo_path: Path,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(
        f".{output_path.stem}.{uuid.uuid4().hex}.png"
    )
    logo_available = logo_path.is_file()
    try:
        try:
            relative_logo = logo_path.resolve().relative_to(project_root.resolve()).as_posix()
        except ValueError:
            relative_logo = "assets/logo.png"
            logo_available = False

        typst.compile(
            template_path,
            output=temporary_path,
            root=project_root,
            format="png",
            ppi=PNG_PPI,
            sys_inputs={
                "question": question.question,
                "author": question.author,
                "subject": question.subject,
                "logo_available": "true" if logo_available else "false",
                "logo_path": relative_logo,
                "template_version": TEMPLATE_VERSION,
            },
        )
        require_expected_png(temporary_path)
        os.replace(temporary_path, output_path)
    except Exception as error:
        temporary_path.unlink(missing_ok=True)
        diagnostic = getattr(error, "diagnostic", str(error))
        raise QuestionRenderError(
            f"Unable to render {question.subject} question {question.id[:8]} "
            f"by {question.author}: {diagnostic}"
        ) from error
