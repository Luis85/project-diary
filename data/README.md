# Snapshot and diary data

The collector writes these files after its first successful run:

- `snapshot.json`: latest successful capture.
- `snapshots/YYYY-MM-DD.json`: first successful capture for that UTC day.
- `diary/YYYY-MM-DD.md`: Obsidian-compatible summary of that day's archived capture.

There is no synthetic initial snapshot. Same-day reruns refresh the latest file
and preserve the existing daily archive and Markdown entry, including any personal
notes. If the archive exists but its diary does not, the diary is generated from
that archive. Consumers that need one observation per day should read `snapshots/`
or `diary/`; consumers that need the freshest state should read `snapshot.json`.

## Snapshot envelope

| Field | Meaning |
| --- | --- |
| `schema_version` | Output contract version, currently `1`. |
| `snapshot_date` | UTC date derived from the capture start time. |
| `captured_at` | ISO 8601 UTC timestamp when collection started. |
| `completed_at` | ISO 8601 UTC timestamp when collection finished. |
| `owner` | GitHub user whose public owned repositories are represented. |
| `source` | API version and collection scope/options. |
| `repository_count` | Number of entries in `repositories`. |
| `repositories` | Repository records, ordered consistently by full name. |

## Repository fields

| Field | Meaning |
| --- | --- |
| `id`, `node_id` | GitHub repository identifiers; `id` is the comparison key across dates. |
| `name`, `full_name`, `owner`, `url` | Current identity and public GitHub URL. |
| `about` | GitHub About description, or `null` when absent. |
| `website` | Repository homepage/website, or `null` when absent. |
| `topics`, `language`, `license` | Public project classification and license metadata. |
| `default_branch` | Branch used for the latest-commit observation. |
| `visibility` | Always `public`; private repositories are excluded. |
| `fork`, `archived`, `disabled` | Repository status flags. |
| `created_at` | Repository creation timestamp. |
| `updated_at` | Repository object update timestamp; not necessarily a code change. |
| `pushed_at` | Most recent repository push timestamp; not limited to the default branch. |
| `size_kb` | GitHub's reported repository size in kilobytes. |
| `counts.stars` | Current stargazer count. |
| `counts.forks` | Current fork count. |
| `counts.open_issues_and_pull_requests` | GitHub's combined open issue and pull-request count. |
| `activity.status` | `available` after applicable activity reads succeed, or `unavailable` for a disabled repository. |
| `activity.reason` | Present when unavailable; currently `repository_disabled`. |
| `activity.latest_commit` | Latest default-branch commit, or `null` for an empty or disabled repository. |
| `activity.latest_release` | GitHub's latest stable published release, or `null` if there is none or the repository is disabled. |
| `activity.recent_events` | Bounded list of recent public activity summaries; deduplicate by event ID. |

Unknown or absent values remain `null` where appropriate. An empty event list
means no events were returned in the configured sample, or event collection was
disabled or unavailable; it does not prove the repository has never had activity.
Inspect `source.events_per_repository` to distinguish event collection configured
as `0`, and `activity.status` / `activity.reason` to identify disabled repositories
whose activity requests were skipped. Disabled repositories retain their metadata
and have `null` commit/release values and an empty events array.

The collector refuses to replace a latest snapshot from another owner or a newer
capture. Use a separate output directory for each account.

## Diary frontmatter

Markdown entries begin with YAML frontmatter. Metrics are flat properties with
numeric values, so they appear in Obsidian's Properties view and can be queried
without unpacking nested objects. Dates and strings are quoted, while absent
comparisons use YAML `null`. The first entry has inventory totals but no change
baseline; comparison metrics remain `null` rather than misleading zeroes.

The following is an **illustrative excerpt**, not a real capture:

```yaml
---
type: "github-diary"
schema_version: 1
date: "2026-10-26"
owner: "Luis85"
tags: ["github", "project-diary"]
captured_at: "2026-10-26T04:17:00.000Z"
completed_at: "2026-10-26T04:17:30.000Z"
comparison_date: "2026-10-25"
comparison_days: 1
repository_count: 12
total_stars: 40
stars_delta: 2
repositories_with_new_pushes: 3
newly_observed_events: 5
---
```

### Identity and comparison interval

| Property | Meaning |
| --- | --- |
| `type` | Always `github-diary`, for filtering these notes. |
| `schema_version` | Diary frontmatter contract version, currently `1`. |
| `date` | UTC date of the source daily archive. |
| `owner` | Tracked GitHub account. |
| `tags` | `github` and `project-diary`. |
| `captured_at`, `completed_at` | Collection interval of the archived source snapshot. |
| `comparison_date` | Nearest earlier archived date, or `null` for the baseline. |
| `comparison_days` | UTC calendar-day distance to that archive, or `null` for the baseline. |

The nearest earlier archive may be several days old. Entries describe that full
comparison interval instead of assuming that every scheduled run succeeded.
Comparisons use daily archives and repository IDs, so same-day manual refreshes
and repository renames do not corrupt the comparison baseline.

### Inventory metrics

| Property | Meaning |
| --- | --- |
| `repository_count` | All public owned repositories in this capture. |
| `original_repository_count` | Repositories whose `fork` flag is false. |
| `fork_repository_count` | Repositories whose `fork` flag is true. |
| `archived_repository_count` | Repositories marked archived. |
| `disabled_repository_count` | Repositories marked disabled. |
| `repositories_with_website` | Repositories with a nonempty website value. |
| `repositories_with_about` | Repositories with a nonempty About description. |
| `total_stars` | Sum of repository stargazer counts. |
| `total_forks` | Sum of repository fork counts. |
| `total_open_issues_and_pull_requests` | Sum of GitHub's combined open issue/PR counts. |
| `sampled_events` | Distinct public event IDs present in the current sample. |

Status counts can overlap: a fork can also be archived. `fork_repository_count`
counts owned projects that are forks; `total_forks` counts forks of the tracked
projects. The summary's language breakdown counts repository primary languages,
not lines of code or language percentages within a repository.

### Comparison metrics

Every value in this table is `null` when no earlier archive exists.

| Property | Meaning |
| --- | --- |
| `repositories_added` | IDs present now but absent from the comparison archive. |
| `repositories_removed` | IDs absent now but present in the comparison archive; reason unknown. |
| `repositories_renamed` | Shared IDs whose `full_name` changed. |
| `repositories_with_metadata_changes` | Shared repositories with changed names, About/website, topics, language, default branch, status flags, or license metadata. |
| `repositories_with_new_pushes` | Shared repositories whose `pushed_at` timestamp advanced. |
| `repositories_with_changed_default_branch_head` | Shared repositories with a changed latest default-branch commit observation and comparable activity. |
| `repositories_with_changed_latest_release` | Shared repositories with a changed latest stable-release observation and comparable activity. |
| `newly_observed_events` | Event IDs absent from the previous sample; these events may have occurred earlier. |
| `stars_delta` | Current `total_stars` minus the previous total. |
| `forks_delta` | Current `total_forks` minus the previous total. |
| `open_issues_and_pull_requests_delta` | Current combined open issue/PR total minus the previous total. |

Inventory deltas include the effect of repositories entering or leaving the
inventory. A positive `stars_delta` is not necessarily the number of stars awarded
during the interval. Head-change counts are numbers of repositories, not commit
counts. Head/release comparisons require activity to be available in both
captures; unavailable observations do not imply a commit or release disappeared.

The Events API is sampled and delayed. An event's first appearance in a diary can
be later than its `created_at`, and repeated event IDs are deduplicated across the
inventory. Newly listed repositories can contribute previously unseen events.
The diary does not claim that newly observed events all happened on the note's
date. Changing the sample size can change observed-event counts too; the note
identifies that change when comparing captures.

## Diary content and personal notes

Entries contain an inventory summary, observed repository changes, activity
highlights, a primary-language breakdown, and relative links to their source JSON
and comparison snapshot. A link to the earlier diary is included when that file
exists. Long tables show a bounded selection with an omitted-item
count; frontmatter totals still cover the full dataset.

The **Personal notes** section can be edited in Obsidian. Existing entries are
preserved byte for byte by later captures, so neither annotations nor an edited
frontmatter property are overwritten automatically. This also means editing a
generated metric changes that note's value; use its linked JSON archive when you
need the original measured data.

An existing entry is not automatically regenerated when the diary renderer
changes. The latest JSON may be newer than the diary after a same-day rerun; the
diary's capture timestamps always refer to the frozen daily archive.

## Processing examples

Read the latest repository inventory with Node.js:

```javascript
import { readFile } from 'node:fs/promises';

const snapshot = JSON.parse(await readFile('data/snapshot.json', 'utf8'));
for (const repo of snapshot.repositories) {
  console.log(repo.full_name, repo.url, repo.website, repo.pushed_at);
}
```

Compare star counts between two daily captures without breaking on a rename:

```javascript
import { readFile } from 'node:fs/promises';

async function load(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const before = await load('data/snapshots/2026-10-25.json');
const after = await load('data/snapshots/2026-10-26.json');
const previousById = new Map(before.repositories.map(repo => [repo.id, repo]));

for (const repo of after.repositories) {
  const previous = previousById.get(repo.id);
  if (previous) {
    console.log(repo.full_name, repo.counts.stars - previous.counts.stars);
  }
}
```

The example dates above are illustrative: use dates that actually exist in your
history. There is no attempt to infer unavailable historical state or reconstruct
every commit, issue, pull request, or event from these samples.

For collection limits, scheduling, authentication, and interpretation caveats,
see the [project README](../README.md).
