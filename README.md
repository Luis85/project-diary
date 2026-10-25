# project-diary

A daily, versioned record of the public GitHub repositories owned by `Luis85`.
The collector saves repository metadata and recent activity as JSON for later
analysis, dashboards, or a project diary. It uses Node.js 24 and has no external
runtime dependencies.

## Enable daily snapshots

1. Merge the workflow and collector into the repository's default branch.
2. Open **Actions → Daily GitHub snapshot → Run workflow**, select the default
   branch, and run it once to create the first snapshot.
3. The workflow then runs daily at **04:17 UTC**: 05:17 in Berlin during winter
   and 06:17 during summer. GitHub's scheduler may start jobs later than the
   requested time.

The workflow uses GitHub's automatically provided `GITHUB_TOKEN`. No personal
access token or additional secret is needed. It requests `contents: write` only
for the snapshot job so it can commit the generated files. Actions must be enabled
and repository policies must permit those writes. If branch rules require every
change to go through a pull request, the push will fail; adapt publication to that
policy rather than bypassing it.

## What gets saved

| File | Purpose |
| --- | --- |
| `data/snapshot.json` | Latest successful capture; a stable path for consumers. |
| `data/snapshots/YYYY-MM-DD.json` | First successful capture for each UTC day; retained history. |
| `data/README.md` | JSON field meanings, examples, and interpretation notes. |

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

## Capture and history behavior

The collector follows every repository-list page, then fetches each repository's
activity. It collects successfully before replacing snapshot files. Unexpected
API failures fail the run rather than publishing a partial inventory. Temporary
errors have bounded retries; empty repositories and repositories without releases
are represented explicitly without failing collection.

Disabled repositories remain in the inventory with their metadata. Their activity
requests are skipped, with `activity.status: "unavailable"` and
`activity.reason: "repository_disabled"`; the latest commit and release are
`null`, and recent events are empty. Other repositories have
`activity.status: "available"`, which does not imply that events or releases exist.

The first successful capture of a UTC day creates its dated history file. A
same-day manual rerun updates `data/snapshot.json` while leaving that daily file
unchanged. Missing days are not backfilled with today's state. Historical files
are never automatically pruned.

Workflow runs are serialized. Manual runs selected from a non-default branch are
skipped. The job commits only snapshot paths and retries a normal push after
rebasing if another commit arrives during collection; it never force-pushes.

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

## Run locally

With Node.js 24 installed:

```bash
npm test
GITHUB_OWNER=Luis85 npm run snapshot
```

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

Local runs write files only; the workflow handles Git commits and pushes. Tests
use mocked API responses and temporary directories and require no network token.

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

## GitHub documentation

- [Repository listing and metadata](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user)
- [API pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [Public events and their limits](https://docs.github.com/en/rest/activity/events)
- [Latest default-branch commits](https://docs.github.com/en/rest/commits/commits#list-commits)
- [Latest release semantics](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [Scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Workflow token and downstream triggers](https://docs.github.com/en/actions/concepts/security/github_token)
