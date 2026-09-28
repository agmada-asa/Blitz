# Generation evals

Evals run real course files through the source pipeline and score what
survives, so changes to extraction, sectioning and generation can be compared
against a recorded baseline instead of judged by eye.

## Ingestion eval

`npm run eval:ingestion` runs each file through `prepareStoredSource`'s two
stages, the same ones desktop uploads use, and reports:

- **Outcome**: whether the file reaches generation with sections, or where it
  stops: an extraction limit such as the PDF page cap, an unreadable file, the
  500 KB persistence bound, or the section limit. The upload route saves every
  stopped file without text or sections, so generation has no coverage check
  for it.
- **Page density**: page count, pages with fewer than 150 characters of text,
  and median characters per page. Low-text pages are usually diagrams,
  equations or figures, where text extraction alone loses teaching content.
- **Section quality**: section count and sizes, the share of section ends that
  cut through a sentence, the share of text repeated by overlap, and the share
  of sections with a structural title.

It sends nothing to a model and writes nothing to Convex. It takes seconds.
Pass `--suite <id>` to run one suite, or `--manifest <path>` to use another
manifest.

## Suites

Suites live in `evals/suites.local.json`, which is gitignored because it names
personal files. Copy `evals/suites.example.json` to start. Each suite lists
files or directories relative to `root`, optional `exclude` file names, and
optional `reference` file names for supporting material such as a textbook
that should add evidence and depth without setting what is taught.

## Reports

Each run writes a JSON report to the gitignored `.eval/` directory. Reports
contain file names, counts and ratios, never source text. Keep the baseline
report from before a change to compare against the run after it.
