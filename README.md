# project-diary

A daily, versioned record of the public GitHub repositories owned by `Luis85`,
with JSON snapshots and an Obsidian-compatible Markdown diary. Each diary entry
summarizes the repository inventory and observed changes, with queryable metrics
in YAML frontmatter. The implementation uses strict TypeScript and runs directly
on Node.js 24.12 or later in the Node 24 line, with no external runtime dependencies
or AI service requirement.

## Enable daily snapshots

1. Merge the workflow and collector into the repository's default branch.
2. Open **Actions → Daily GitHub snapshot → Run workflow**, select the default
   branch, and run it once to create the first snapshot and diary entry.
3. The first daily attempt is **04:17 UTC**: 05:17 in Berlin during winter and
   06:17 during summer. Further scheduled opportunities at **10:17, 16:17, and
   22:17 UTC** recover an incomplete current day. GitHub may start jobs later
   than the requested time.

The workflow uses GitHub's automatically provided `GITHUB_TOKEN`. No personal
access token or additional secret is needed. It requests `contents: write` only
for the snapshot job so it can commit the generated files. Actions must be enabled
and repository policies must permit those writes. If branch rules require every
change to go through a pull request, the push will fail; adapt publication to that
policy rather than bypassing it.

Scheduled runs use `--if-needed`: they validate today's archived JSON, require
its nonempty diary and a matching current latest snapshot, then skip API calls
and writes when that daily bundle is complete. If the current day's valid archive
exists but its diary or latest JSON is missing, scheduled recovery can restore
those derived files from the archive without calling GitHub. A valid newer
same-day latest snapshot is preserved. A successful day normally needs one
capture commit. A manual run deliberately refreshes the latest snapshot while
preserving the first daily archive and diary.

These are recovery opportunities, not a guaranteed delivery time. They cannot
reconstruct a past day's state if no capture succeeded that day.

## What gets saved

| File | Purpose |
| --- | --- |
| `data/snapshot.json` | Latest successful capture; a stable path for consumers. |
| `data/snapshots/YYYY-MM-DD.json` | First successful capture for each UTC day; retained history. |
| `data/diary/YYYY-MM-DD.md` | Daily Markdown summary, frontmatter metrics, and space for personal notes. |
| `data/README.md` | JSON and diary field definitions, examples, and interpretation notes. |

Each snapshot includes all **public repositories owned by the configured user**,
including forks and archived repositories. It does not include private
repositories or repositories owned by organizations the user belongs to.

For each repository, it records:

- Stable repository ID, name, full name, and GitHub URL.
- About text (`about`), website (`website`), topics, language, and license.
- Default branch, fork/archive status, size, creation time, metadata update time,
  and last-push time.
- Current stars, forks, and combined open issue/pull-request count.
- Latest default-branch commit and GitHub's latest published stable release.
- Up to 10 recent public events, with IDs and compact activity summaries.

Use repository **IDs** when comparing captures: names and URLs can change. Use
event **IDs** to deduplicate events repeated in successive snapshots.

## Read the diary in Obsidian

Open your local clone of this repository as an Obsidian vault, or place the
repository inside an existing vault. After pulling the generated files from
GitHub, open `data/diary/YYYY-MM-DD.md`. No Obsidian plugin is required: the entries
use ordinary Markdown, relative links, and flat YAML properties with numeric
metrics. The **Personal notes** section is available for your own observations.

Each entry includes:

- Inventory totals for repositories, stars, forks, and open issues/pull requests.
- Changes against the nearest earlier archived capture, matched by repository ID.
- Added, renamed, and no-longer-listed repositories; metadata and activity changes.
- Recent activity highlights, a language breakdown, and links to the source JSON.
- Typed frontmatter values for trends, filtering, and your own processing.

The first entry establishes a baseline. Comparison metrics are `null` until an
earlier capture exists; they do not claim that every existing repository or event
is new. If captures are several days apart, the note names that interval and
records `comparison_days`. Head changes count repositories with a changed
default-branch commit, not the number of commits made during the interval.

The Markdown body limits long lists for readability. Frontmatter totals still
cover the full inventory, and the JSON archive retains the underlying records.

If you use the optional Dataview plugin, this query lists the diary metrics:

````markdown
```dataview
TABLE WITHOUT ID
  file.link AS "Day",
  repository_count AS "Repositories",
  total_stars AS "Stars",
  stars_delta AS "Star delta",
  repositories_with_new_pushes AS "Repos with pushes"
FROM "data/diary"
WHERE type = "github-diary"
SORT date DESC
```
````

Adjust the `FROM` path if this repository is nested inside another vault folder.

## Capture and history behavior

The collector follows every repository-list page, then fetches each repository's
activity. It collects successfully before replacing snapshot files. Unexpected
API failures fail the run rather than publishing a partial inventory. Temporary
errors have bounded retries; empty repositories and repositories without releases
are represented explicitly without failing collection.

Malformed pagination headers and invalid metadata fail explicitly. Incoming and
saved snapshots are validated for unique repository identities, public ownership,
numeric counters, UTC timestamps, and activity structure before diary comparisons.
Missing counters are not interpreted as zero.

TypeScript checks the implementation and its consumers during development and
CI. GitHub responses and loaded JSON still enter as `unknown` and pass runtime
validation before use; static types do not make external data trustworthy.

Disabled repositories remain in the inventory with their metadata. Their activity
requests are skipped, with `activity.status: "unavailable"` and
`activity.reason: "repository_disabled"`; the latest commit and release are
`null`, and recent events are empty. Other repositories have
`activity.status: "available"`, which does not imply that events or releases exist.

The first successful capture of a UTC day creates its dated JSON archive and
Markdown diary together. A same-day manual rerun refreshes `data/snapshot.json`
while preserving the archive and existing diary byte for byte, including personal
notes. If that day's archive exists but its diary is missing, the diary is created
from the preserved archive, so the note and its source JSON stay aligned.
Scheduled recovery can likewise restore a missing latest JSON from that archive.
Existing corrupt JSON, an orphaned diary, or an empty/whitespace-only diary is
reported rather than overwritten automatically. Such failures occur before API
collection in scheduled recovery mode.

The diary compares against the nearest earlier daily archive after validating it,
never against the mutable latest snapshot. A corrupt comparison archive stops the
run instead of being silently skipped. Missing days are not backfilled with today's state.
Historical files are never automatically pruned. Existing diary entries are not
automatically regenerated when the renderer changes.

The writer stages all intended content before publishing files and replaces the
latest JSON last. Ordinary publication failures roll back newly created files.
A local writer lock prevents concurrent processes from publishing to the same
data directory. If a process is killed, it may leave `data/.snapshot.lock` behind;
remove that directory only after confirming no snapshot process is still running.
An existing diary without its matching JSON archive is preserved and reported as
an error instead of being paired with a different capture.

Workflow runs are serialized. Manual runs selected from a non-default branch are
skipped. The job stages exactly the latest JSON and the current date's archive and
diary, then retries a normal push after rebasing if another commit arrives during
collection; it never force-pushes. Snapshot collection, diary comparison/rendering,
and file persistence are separate modules so each concern can be verified in
isolation.

| Module | Responsibility |
| --- | --- |
| `scripts/snapshot-github.ts` | Collection, scheduled recovery decisions, and CLI orchestration. |
| `scripts/lib/github-client.ts` | API requests, pagination, timeouts, and retries. |
| `scripts/lib/github-data.ts` | Runtime validation and normalization of raw GitHub responses. |
| `scripts/lib/snapshot-schema.ts` | Validation shared by collection and saved history. |
| `scripts/lib/diary.ts` | Pure metric comparisons and Markdown rendering. |
| `scripts/lib/snapshot-store.ts` | Archived baselines, preservation, locking, and file publication. |
| `scripts/lib/types.ts` | Exported `SnapshotV1`, repository/activity, and diary metric contracts. |
| `scripts/lib/errors.ts` | Safe inspection of caught errors without assuming their type. |

The TypeScript migration preserves the existing **`schema_version: 1`** JSON
layout, frontmatter properties, and file paths. Consumers can continue reading
the same data; TypeScript consumers can also import the public contracts.

## Configuration

Optional repository variables under **Settings → Secrets and variables → Actions
→ Variables**:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SNAPSHOT_OWNER` | Repository owner (`Luis85`) | GitHub user whose public owned repositories are collected. |
| `SNAPSHOT_EVENTS_PER_REPO` | `10` | Recent public event samples per repository, from `0` to `100`; `0` disables event requests. |

Set the owner before the first capture. If `data/snapshot.json` already belongs
to another owner, the collector fails rather than mixing account histories. Keep
different accounts in separate repositories or output directories.

## Run locally and develop

Use **Node.js 24.12 or later within Node 24**. `.node-version` selects the Node 24
line, and the package engine range documents the supported runtime. Native Node
execution strips erasable TypeScript syntax; there is no generated `dist/`
directory or build step for a capture.

Captures and offline tests do not require an npm dependency installation:

```bash
npm test
GITHUB_OWNER=Luis85 npm run snapshot
```

Use the same idempotent mode as the scheduled workflow when appropriate:

```bash
GITHUB_OWNER=Luis85 npm run snapshot -- --if-needed
```

For development and strict verification, install the pinned compiler and Node
type definitions from the committed lockfile:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`npm run check` runs `tsc --noEmit` and the tests. You can run `npm run typecheck`
or `npm test` separately. The compiler enables `strict`, unchecked-index checks,
exact optional properties, unknown catch values, and `erasableSyntaxOnly`.
Node's native execution does not type-check and ignores `tsconfig.json`, so the
CI check is part of the change-validation process.

Public API reads work without a token, but unauthenticated rate limits are low.
For an authenticated local run, use an existing GitHub CLI login:

```bash
GITHUB_TOKEN="$(gh auth token)" GITHUB_OWNER=Luis85 npm run snapshot
```

The script also accepts `SNAPSHOT_EVENTS_PER_REPO` and `SNAPSHOT_DATA_DIR`
(default `data`). For example, inspect a capture outside the tracked data folder:

```bash
GITHUB_TOKEN="$(gh auth token)" SNAPSHOT_DATA_DIR=/tmp/project-diary-data npm run snapshot
```

Local runs write the JSON files and daily Markdown entry; the workflow handles
Git commits and pushes. Tests use mocked API responses and temporary directories
and require no network token.

## Unattended operation and upkeep

| Mechanism | Behavior |
| --- | --- |
| Daily capture and recovery slots | Check the current UTC day at 04:17, 10:17, 16:17, and 22:17; skip complete days or repair missing derived files from their valid daily archive before API calls. |
| Request retries | Retry temporary failures within bounded limits; later scheduled runs provide another opportunity when a run fails. |
| Runtime independence | Daily collection and tests use Node built-ins and checked-in TypeScript, without fetching compiler packages from npm. |
| Change verification | Relevant pull requests and pushes to `main` run locked installation, strict type checking, and offline tests. |
| Periodic verification | The same read-only CI check runs Mondays at 08:37 UTC and can be started manually to detect toolchain drift. |
| Dependency proposals | Dependabot checks weekly for grouped npm development-dependency and GitHub Actions updates; updates remain reviewable pull requests. |
| Failure visibility | A failed capture retains its failed Actions status and adds a stage/outcome table with a link to the run logs. |

GitHub Actions use pinned commit references. The runner OS is fixed to
`ubuntu-24.04`, and Node remains on the supported 24 line while receiving that
line's updates. Node type-definition major upgrades are excluded from automatic
Dependabot proposals so runtime and types can be upgraded together deliberately.

The failure summary distinguishes checkout, runtime setup, tests, collection,
publication, and summary generation. A publishing step can succeed before a later
summary step fails; check the listed outcome before rerunning manually. Persistent
validation failures, permission changes, or branch-rule conflicts require a fix;
recovery scheduling does not bypass those protections. GitHub's own scheduled-run
and inactivity limits still apply.

## Interpreting the data

- `updated_at`, `pushed_at`, the latest default-branch commit, and public events
  describe different kinds of activity. They are kept separate.
- Recent events are a **sample**, not a complete activity log. GitHub's Events API
  retains at most 300 events from the last 30 days and can lag by up to six hours.
  This collector deliberately takes only the configured recent sample per repo.
  Busy repositories may have activities that never appear in a daily capture.
- API requests happen over a capture interval, not at one atomic instant. The
  snapshot records its start and completion timestamps.
- A repository disappearing from a later snapshot can mean it became private,
  was transferred, or was deleted; absence alone does not identify the reason.
- Diary star/fork/issue deltas are net changes across the full tracked inventory.
  Adding or losing a repository changes those totals too. They are not counts of
  individual starring, forking, or issue events.
- `newly_observed_events` counts event IDs missing from the previous sample. A
  delayed event can be newly observed even when its timestamp is older than the
  comparison interval. Head/release comparisons require available activity on
  both dates; push timestamps are repository metadata and remain comparable.
- Historical snapshots retain metadata that was public when captured, even if
  the source repository later becomes private or is deleted.
- This diary snapshots itself too. Its automated snapshot commits create daily
  activity; account for that when measuring project activity.
- GitHub may delay or drop scheduled jobs and disables scheduled workflows in
  public repositories after 60 days without repository activity. Review failed
  runs under Actions; a missing date is a visible gap, not a fabricated capture.
- Commits pushed with `GITHUB_TOKEN` do not trigger ordinary `push` workflows or
  GitHub Pages builds. A future dashboard deployment should be explicitly invoked
  from the snapshot workflow or another appropriate trigger.

## Reference documentation

- [Node.js 24 native TypeScript execution](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
- [TypeScript erasable syntax checks](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)
- [Dependabot schedules and grouped updates](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Obsidian properties and supported types](https://help.obsidian.md/properties)
- [Optional Dataview table queries](https://blacksmithgu.github.io/obsidian-dataview/queries/query-types/#table)
- [Repository listing and metadata](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user)
- [API pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [Public events and their limits](https://docs.github.com/en/rest/activity/events)
- [Latest default-branch commits](https://docs.github.com/en/rest/commits/commits#list-commits)
- [Latest release semantics](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [Scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Workflow token and downstream triggers](https://docs.github.com/en/actions/concepts/security/github_token)
