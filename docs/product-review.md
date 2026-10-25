# Product review

Review date: **2026-10-25**. Scope: the daily public-repository collector,
versioned JSON history, Obsidian diary, TypeScript contracts, and GitHub Actions
operation on **PR #1**.

The review follows the user's main journeys: set up the project once, receive a
trustworthy daily observation, read meaningful changes in Obsidian, recover from
an unattended failure, and process the accumulated data later.

## Perspectives and findings

| Perspective | Assessment and resulting work |
| --- | --- |
| Product purpose and scope | Public owned repositories, daily state, About/website metadata, and recent activity match the requested foundation. Forks and archives remain included. Organization-owned repositories and private data are outside the stated scope. |
| Daily reading and Obsidian | Flat typed frontmatter, source links, baseline explanations, gap intervals, and personal notes are coherent. Add concise before-and-after About/website details so useful metadata changes can be read in the diary itself. |
| Chronology and data interpretation | Fix a reproducible ordering error for equivalent UTC formats with different fractional precision. Preserve the distinction between observed state, event samples, net inventory deltas, and actual activity counts. |
| Downstream processing | Keep schema version 1, stable repository/event IDs, explicit nulls, capture intervals, and runtime validation of unknown JSON. Discussion titles and review-specific links fit the existing event contract. |
| Unattended reliability | Scheduled skip/repair/capture behavior, bounded API retries, file staging, immutable daily files, writer locking, and push retries are sound. Preserve completed captures when Git publication fails. |
| Support and diagnosis | Add repository and collection-stage context to validation errors. Failure summaries must distinguish a capture failure, publication failure, and recovery-artifact failure. |
| Security and privacy | Public-scope checks, credential host restrictions, redirect refusal, safe Markdown destinations, and limited workflow permissions are retained. Recovery artifacts contain only the exact current JSON/diary bundle. |
| Developer experience | Strict native TypeScript, versioned exported interfaces, deterministic offline fixtures, a locked toolchain, and focused modules support future processing without runtime dependencies. |
| Maintenance and scale | Scheduled runs skip complete days without API access; dependency proposals and toolchain checks run weekly. Artifact retention is short and failure-only. JSON history intentionally grows over time. |
| Onboarding and documentation | Default-branch activation, manual first capture, Obsidian use, sampling limits, and existing-history preservation are documented. Add a concrete recovery procedure and explain request/storage growth. |

## Focused improvement pass

Three independent reviewers assessed diary use, data/API contracts, and
operations/security. Each then implemented improvements in a separate area;
the combined result receives strict type checking, offline regression tests,
workflow checks, and CI on the existing PR.

### Correct chronological ordering

The supported timestamp contract accepts both whole and fractional UTC seconds.
For example, `12:00:00.100Z` is later than `12:00:00Z`, but descending string
comparison can put those values in the opposite order. Sort parsed instants for
event and baseline-commit highlights, keep unknown dates last, and retain
deterministic tie-breaking. Targeted regressions cover both tables.

### Make metadata and activity changes useful to read

A label such as `Metadata: about, website` establishes that something changed
without showing the useful new information. Display bounded, escaped
before-and-after values for those two requested fields, including removal states
and safe website links. Other metadata changes remain concise, and the complete
original values remain in JSON.

The Events API already supplies discussion details and review-specific URLs.
Retain those in the existing `title` and `url` fields so a reader can open the
relevant discussion, review, or comment without adding API requests or changing
the data contract.

### Make unattended failures diagnosable and recoverable

A malformed counter previously produced a field-level error without identifying
which repository failed. Add bounded, safely rendered repository identity and
the metadata/commit/release/event stage, retaining the original error detail.
Do not include response bodies or tokens.

A capture that cannot be pushed would otherwise disappear with the hosted
runner. Stage a separate copy before Git publication, and attempt to upload only
that bundle if publication fails. Keep it for seven days and report the artifact
link or upload failure in the run summary. The original publication failure
remains visible. See the [recovery procedure](../README.md#recover-a-capture-after-a-failed-push).

## Contracts preserved

- The first daily archive and diary remain immutable, including personal notes.
- `data/snapshot.json` remains the latest successful capture.
- JSON and diary frontmatter remain schema version 1; existing properties and
  output paths retain their meaning.
- The baseline has null comparison metrics. Gaps describe the actual comparison
  interval, and absent repositories have no invented removal reason.
- Public events are bounded observations. Net star/fork/issue changes include
  changes in inventory membership.
- No dashboard, database, AI service, extra API credential, or Obsidian plugin is
  required for the core workflow.

## Verification and practical limits

Regression checks cover mixed timestamp precision, safe metadata rendering,
discussion/review event normalization, actionable validation errors, and the
existing collection, diary, persistence, and scheduled-recovery behavior.
All **62 offline tests** and strict TypeScript checking passed after integration.
Workflow verification includes YAML and shell syntax plus isolated preparation
of the exact recovery bundle with unrelated-file decoys and a missing-file case.

The workflow becomes scheduled on the default branch after merge. Effective
`GITHUB_TOKEN` publication permission and branch rules must be confirmed by the
first live default-branch run; connected-user push access does not establish
those token permissions. This review does not merge or enable the workflow.

GitHub scheduling can be delayed or skipped, and a day with no successful capture
cannot be reconstructed from current API data. A recovery artifact helps only
when collection completed and artifact upload succeeded; it expires. Persistent
validation, permission, or branch-rule failures require attention. Existing
diaries are not rewritten after renderer improvements or manual archive recovery.
Repeated recovery opportunities also cannot solve a capture whose request count
consistently exceeds its authentication budget. The operational guide documents
request growth and the current GitHub limits so this boundary is visible.

Read the [operational guidance](../README.md#unattended-operation-and-upkeep) and
[data semantics](../data/README.md) before building aggregate metrics on the
history. In particular, this repository's own automated commits appear in its
captured activity, and retained public metadata can outlive a source repository's
later visibility change.
