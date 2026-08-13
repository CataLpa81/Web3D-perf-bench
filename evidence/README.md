# Reference benchmark evidence

Run `npm run collect:reference` on a controlled target machine to create a
provenance-complete `*.raw-results.json` file in this directory.

Reference result files are intended to be committed or attached to a release.
Every published conclusion must name the exact evidence file used.

Committed evidence:

- `full-current-2026-08-13.raw-results.json`: complete schema-v2 data for the
  630-run matrix cited by the conclusion documents.
- `full-current-2026-08-13.report.html`: generated report for the same batch.

The raw artifact records its own commit, dirty-worktree flag, benchmark source
hashes, component batches, browser flags, and environment. A clean-worktree
reference run remains the preferred artifact for subsequent publications.
