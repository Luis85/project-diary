# Snapshot data

The collector writes JSON here after its first successful run:

- `snapshot.json`: latest successful capture.
- `snapshots/YYYY-MM-DD.json`: first successful capture for that UTC day.

There is no synthetic initial snapshot. Same-day reruns refresh the latest file
and preserve the existing daily archive. Consumers that need one observation per
day should read `snapshots/`; consumers that need the freshest state should read
`snapshot.json`.

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
