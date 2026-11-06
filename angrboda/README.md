# Angrboda question-image generator

Angrboda is the standalone Python and Typst production workflow for Clash of
Prodigies Season 4: Chaotic Ascension. It does not connect to Kahoot, Clash
Relay, or Challenge Place.

## Set up

From the Jotunheim repository root:

```bash
python3 -m venv .venv
.venv/bin/pip install -r angrboda/requirements.txt
```

`angrboda/assets/logo.png` is the official logo currently used by the template.
If it is unavailable, the template renders a small text-based `COP` fallback.

## Question bank

`questions.json` is a clearly labeled sample bank. Replace or expand it for
production. Every array item must contain exactly these three nonempty strings:

```json
{
  "question": "Trusted Typst markup, including $x^2$ when needed.",
  "author": "Author name",
  "subject": "Mathematics"
}
```

The supported subjects are `Mathematics`, `Physics`, `Chemistry`, and
`Biology`. Typst markup in `question` is evaluated as trusted markup, so inline
math, roots, fractions, Greek letters, units, subscripts, integrals, and other
Typst expressions render normally. Do not put unreviewed input in the bank.

Question identities are the full SHA-256 digest of a canonical representation
of the three fields. Pool filenames use the first eight digest characters plus
a sanitized author and recognizable phrase. Changing any field changes the ID.

## Generate the pool

```bash
cd angrboda
../.venv/bin/python generate.py
```

Existing valid deterministic images are left untouched. Use `--force` only
when intentionally rerendering those pool images. A malformed question reports
its subject, author, short ID, and Typst diagnostic.

## Build a match

The bank must have at least ten valid rendered questions in every subject:

```bash
../.venv/bin/python build_match.py --match genesis-vs-styx
```

To reproduce a selection:

```bash
../.venv/bin/python build_match.py --match test-reproduction --seed 9842157
```

Without `--seed`, the builder creates a fresh 128-bit seed with
`secrets.randbits(128)`. A dedicated `random.Random(seed)` selects ten questions
from each deterministically ID-sorted subject pool and shuffles all forty.
The manifest records the decimal seed as a string, the canonical bank hash,
algorithm/template versions, and all original selected records in final order.
The same seed reproduces the order only when the bank hash and rendered
candidate set are unchanged.

Match directories are assembled in a temporary directory and moved into place
only after all 40 images and the manifest are ready. Existing match output is
never replaced unless `--overwrite` is explicitly supplied.

Seeds, manifests, and match output reveal future questions. Keep the entire
`output/` directory private until the fixture concludes.

## Tests

```bash
../.venv/bin/python -m unittest discover -s tests -v
```

Tests use synthetic questions and temporary directories. They cover validation,
stable identities, filename safety, Typst rendering, dimensions, long content,
missing-logo fallback, deterministic selection, subject quotas, manifests,
bank-change detection, and overwrite protection.

