import type {
  AvailableActivity, ComparisonMetrics, DiaryMetrics, DiaryResult,
  EventSummary, InventoryMetrics, RepositorySnapshot, SnapshotV1,
} from './types.ts';

const SECTION_LIMIT = 20;
const METADATA_VALUE_LIMIT = 120;
const WEBSITE_LINK_LIMIT = 2_048;
const DAY_MS = 86_400_000;
const EMPTY_COMPARISON: ComparisonMetrics = {
  comparison_date: null,
  comparison_days: null,
  repositories_added: null,
  repositories_removed: null,
  repositories_renamed: null,
  repositories_with_metadata_changes: null,
  repositories_with_new_pushes: null,
  repositories_with_changed_default_branch_head: null,
  repositories_with_changed_latest_release: null,
  newly_observed_events: null,
  stars_delta: null,
  forks_delta: null,
  open_issues_and_pull_requests_delta: null,
};
const METADATA_FIELDS = [
  'name', 'full_name', 'about', 'website', 'topics', 'language', 'default_branch',
  'fork', 'archived', 'disabled', 'license',
] as const;
type MetadataField = typeof METADATA_FIELDS[number];
type MetadataValue = string | boolean | null | readonly (string | null)[];
type RepositoryMetadata = Record<MetadataField, MetadataValue>;

interface EventSample { repo: RepositorySnapshot; event: EventSummary }
interface RepositoryChange {
  repo: RepositorySnapshot;
  previous: RepositorySnapshot;
  metadata: MetadataField[];
  renamed: boolean;
  pushed: boolean;
  headChanged: boolean;
  releaseChanged: boolean;
  starsDelta: number;
  forksDelta: number;
  issuesDelta: number;
}
interface Comparison {
  metrics: ComparisonMetrics;
  added: RepositorySnapshot[];
  removed: RepositorySnapshot[];
  changes: RepositoryChange[];
  newEvents: EventSample[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTimestamp(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return Date.parse(a) - Date.parse(b);
}

function singleLine(value: unknown, maximum = 180): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
  const characters = [...text];
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : text;
}

/** Keep all repository-provided text inline, even inside Markdown tables. */
function escapeText(value: unknown, maximum = 180): string {
  return singleLine(value, maximum)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#|!~]/g, '\\$&');
}

function inlineCode(value: string): string {
  // Keep table separators outside code spans, where the Markdown escape is effective.
  return value.split('|').map(part => {
    if (!part) return '';
    const longestFence = Math.max(0, ...(part.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longestFence + 1);
    return `${fence} ${part} ${fence}`;
  }).join('\\|');
}

function externalLink(label: unknown, target: unknown, { codeFallback = false }: { codeFallback?: boolean } = {}): string {
  const safeLabel = escapeText(label);
  const fallback = codeFallback ? inlineCode(singleLine(label)) : safeLabel;
  if (typeof target !== 'string' || /[\u0000-\u0020\u007f<>]/.test(target)) return fallback;
  try {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fallback;
    // A valid URL can still contain Markdown delimiters and table separators.
    const destination = url.href.replace(/[()\[\]\\|]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `[${safeLabel}](${destination})`;
  } catch {
    return fallback;
  }
}

function repoLink(repo: RepositorySnapshot): string {
  return externalLink(repo.full_name, repo.url);
}

function aboutValue(value: string | null): string {
  return escapeText(value, METADATA_VALUE_LIMIT) || '_empty_';
}

function websiteValue(value: string | null): string {
  const label = singleLine(value, METADATA_VALUE_LIMIT);
  if (!label) return '_empty_';
  // Keep even unusually long website values bounded in the note; JSON retains them in full.
  return externalLink(label, value !== null && value.length <= WEBSITE_LINK_LIMIT ? value : null, { codeFallback: true });
}

function number(value: number): string {
  return String(value);
}

function delta(value: number | null): string {
  return value === null ? '—' : value > 0 ? `+${value}` : number(value);
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ];
}

function boundedTable<T>(headers: readonly string[], items: readonly T[], toRow: (item: T) => readonly string[]): string[] {
  const lines = table(headers, items.slice(0, SECTION_LIMIT).map(toRow));
  if (items.length > SECTION_LIMIT) {
    lines.push('', `${items.length - SECTION_LIMIT} more entries omitted from this table; totals include all entries. See the snapshot JSON for the complete data.`);
  }
  return lines;
}

function available(repo: RepositorySnapshot): repo is RepositorySnapshot & { activity: AvailableActivity } {
  return repo.activity?.status === 'available';
}

function countTotal(repositories: readonly RepositorySnapshot[], key: keyof RepositorySnapshot['counts']): number {
  const value = repositories.reduce((total, repo) => total + repo.counts[key], 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid diary metric: ${key}.`);
  return value;
}

function eventSamples(repositories: readonly RepositorySnapshot[]): EventSample[] {
  const unique = new Map<string, EventSample>();
  for (const repo of repositories) {
    if (!available(repo)) continue;
    for (const event of repo.activity.recent_events) {
      const key = String(event.id);
      if (!unique.has(key)) unique.set(key, { repo, event });
    }
  }
  return [...unique.values()].sort((a, b) => (
    compareTimestamp(b.event.created_at, a.event.created_at) || compareText(String(a.event.id), String(b.event.id))
  ));
}

function inventoryMetrics(repositories: readonly RepositorySnapshot[], events: readonly EventSample[]): InventoryMetrics {
  return {
    repository_count: repositories.length,
    original_repository_count: repositories.filter(repo => !repo.fork).length,
    fork_repository_count: repositories.filter(repo => repo.fork).length,
    archived_repository_count: repositories.filter(repo => repo.archived).length,
    disabled_repository_count: repositories.filter(repo => repo.disabled).length,
    repositories_with_website: repositories.filter(repo => Boolean(repo.website?.trim())).length,
    repositories_with_about: repositories.filter(repo => Boolean(repo.about?.trim())).length,
    total_stars: countTotal(repositories, 'stars'),
    total_forks: countTotal(repositories, 'forks'),
    total_open_issues_and_pull_requests: countTotal(repositories, 'open_issues_and_pull_requests'),
    sampled_events: events.length,
  };
}

function metadataFields(repo: RepositorySnapshot): RepositoryMetadata {
  return {
    name: repo.name,
    full_name: repo.full_name,
    about: repo.about,
    website: repo.website,
    topics: [...new Set(repo.topics ?? [])].sort(),
    language: repo.language,
    default_branch: repo.default_branch,
    fork: repo.fork,
    archived: repo.archived,
    disabled: repo.disabled,
    license: repo.license ? [repo.license.key, repo.license.name, repo.license.spdx_id, repo.license.url] : null,
  };
}

function compareRepository(repo: RepositorySnapshot, previous: RepositorySnapshot): RepositoryChange {
  const before = metadataFields(previous);
  const after = metadataFields(repo);
  const metadata = METADATA_FIELDS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const activityComparable = available(repo) && available(previous);
  const pushedAt = Date.parse(repo.pushed_at ?? '');
  const previouslyPushedAt = Date.parse(previous.pushed_at ?? '');
  return {
    repo,
    previous,
    metadata,
    renamed: repo.full_name !== previous.full_name,
    pushed: Number.isFinite(pushedAt) && (!Number.isFinite(previouslyPushedAt) || pushedAt > previouslyPushedAt),
    headChanged: activityComparable && (repo.activity.latest_commit?.sha ?? null) !== (previous.activity.latest_commit?.sha ?? null),
    releaseChanged: activityComparable && (repo.activity.latest_release?.id ?? null) !== (previous.activity.latest_release?.id ?? null),
    starsDelta: repo.counts.stars - previous.counts.stars,
    forksDelta: repo.counts.forks - previous.counts.forks,
    issuesDelta: repo.counts.open_issues_and_pull_requests - previous.counts.open_issues_and_pull_requests,
  };
}

function comparison(
  snapshot: SnapshotV1, previousSnapshot: SnapshotV1 | null, repositories: readonly RepositorySnapshot[],
  events: readonly EventSample[], totals: InventoryMetrics,
): Comparison {
  if (!previousSnapshot) {
    return {
      metrics: { ...EMPTY_COMPARISON },
      added: [], removed: [], changes: [], newEvents: [],
    };
  }
  if (snapshot.owner.toLowerCase() !== previousSnapshot.owner.toLowerCase()) {
    throw new Error('Cannot compare diary snapshots from different owners.');
  }
  if (previousSnapshot.snapshot_date >= snapshot.snapshot_date ||
      Date.parse(previousSnapshot.captured_at) >= Date.parse(snapshot.captured_at)) {
    throw new Error('The diary comparison must come from an earlier capture date.');
  }
  const previousRepos = [...previousSnapshot.repositories].sort((a, b) => compareText(a.full_name, b.full_name));
  const previousById = new Map(previousRepos.map(repo => [repo.id, repo]));
  const currentById = new Map(repositories.map(repo => [repo.id, repo]));
  const previousEvents = eventSamples(previousRepos);
  const previousIds = new Set(previousEvents.map(({ event }) => String(event.id)));
  const previousTotals = inventoryMetrics(previousRepos, previousEvents);
  const added = repositories.filter(repo => !previousById.has(repo.id));
  const removed = previousRepos.filter(repo => !currentById.has(repo.id));
  const changes: RepositoryChange[] = [];
  for (const repo of repositories) {
    const previous = previousById.get(repo.id);
    if (previous) changes.push(compareRepository(repo, previous));
  }
  const newEvents = events.filter(({ event }) => !previousIds.has(String(event.id)));
  return {
    metrics: {
      comparison_date: previousSnapshot.snapshot_date,
      comparison_days: (Date.parse(`${snapshot.snapshot_date}T00:00:00Z`) - Date.parse(`${previousSnapshot.snapshot_date}T00:00:00Z`)) / DAY_MS,
      repositories_added: added.length,
      repositories_removed: removed.length,
      repositories_renamed: changes.filter(change => change.renamed).length,
      repositories_with_metadata_changes: changes.filter(change => change.metadata.length > 0).length,
      repositories_with_new_pushes: changes.filter(change => change.pushed).length,
      repositories_with_changed_default_branch_head: changes.filter(change => change.headChanged).length,
      repositories_with_changed_latest_release: changes.filter(change => change.releaseChanged).length,
      newly_observed_events: newEvents.length,
      stars_delta: totals.total_stars - previousTotals.total_stars,
      forks_delta: totals.total_forks - previousTotals.total_forks,
      open_issues_and_pull_requests_delta: totals.total_open_issues_and_pull_requests - previousTotals.total_open_issues_and_pull_requests,
    },
    added, removed, changes, newEvents,
  };
}

function frontmatter(snapshot: SnapshotV1, metrics: DiaryMetrics): string[] {
  const values: Record<string, string | number | null> = {
    type: 'github-diary', schema_version: 1, date: snapshot.snapshot_date,
    owner: snapshot.owner, captured_at: snapshot.captured_at, completed_at: snapshot.completed_at,
    ...metrics,
  };
  return [
    '---',
    ...Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}`),
    'tags: [github, project-diary]',
    '---',
  ];
}

function updateDescription(change: RepositoryChange): string {
  const reasons = [];
  if (change.renamed) reasons.push(`Renamed from ${escapeText(change.previous.full_name)}`);
  if (change.pushed) reasons.push('Push timestamp advanced');
  if (change.headChanged) {
    const commit = change.repo.activity.latest_commit;
    reasons.push(commit ? `Default-branch head changed: ${externalLink(singleLine(commit.message.split(/\r?\n/)[0], 120), commit.url)}` : 'Default-branch head is now empty');
  }
  if (change.releaseChanged) {
    const release = change.repo.activity.latest_release;
    reasons.push(release ? `Latest release changed to ${externalLink(release.tag_name, release.url)}` : 'No latest stable release is now available');
  }
  if (change.metadata.includes('about')) reasons.push(`About: ${aboutValue(change.previous.about)} → ${aboutValue(change.repo.about)}`);
  if (change.metadata.includes('website')) reasons.push(`Website: ${websiteValue(change.previous.website)} → ${websiteValue(change.repo.website)}`);
  const fields = change.metadata.filter(field => !['about', 'website'].includes(field) && (!change.renamed || !['name', 'full_name'].includes(field)));
  if (fields.length) reasons.push(`Metadata: ${fields.map(field => escapeText(field)).join(', ')}`);
  if (!reasons.length) reasons.push('Counter changes');
  return reasons.join('; ');
}

function eventDescription(event: EventSummary): string {
  const details = [event.type, event.action, event.title || event.ref].filter(Boolean).join(' · ');
  return externalLink(details, event.url);
}

/** Build a deterministic, Obsidian-compatible note from validated daily captures. */
export function buildDiary(
  snapshot: SnapshotV1,
  previousSnapshot: SnapshotV1 | null = null,
  { previousDiaryExists = false }: { previousDiaryExists?: boolean } = {},
): DiaryResult {
  const repositories = [...snapshot.repositories].sort((a, b) => compareText(a.full_name, b.full_name));
  const events = eventSamples(repositories);
  const totals = inventoryMetrics(repositories, events);
  const diff = comparison(snapshot, previousSnapshot, repositories, events, totals);
  const metrics: DiaryMetrics = { ...totals, ...diff.metrics };
  const lines = [
    ...frontmatter(snapshot, metrics), '',
    `# GitHub diary — ${snapshot.snapshot_date}`, '',
    `**${escapeText(snapshot.owner)}** · ${metrics.repository_count} public repositories · Captured ${escapeText(snapshot.captured_at)}.`, '',
    `[Snapshot JSON](../snapshots/${snapshot.snapshot_date}.json)${previousSnapshot ? ` · [Previous snapshot JSON](../snapshots/${previousSnapshot.snapshot_date}.json)` : ''}${previousSnapshot && previousDiaryExists ? ` · [Previous diary](${previousSnapshot.snapshot_date}.md)` : ''}`, '',
    '## Overview', '',
    ...table(['Metric', 'Current', 'Change'], [
      ['Public repositories', number(metrics.repository_count), delta(metrics.repositories_added === null || metrics.repositories_removed === null ? null : metrics.repositories_added - metrics.repositories_removed)],
      ['Original repositories / forks', `${metrics.original_repository_count} / ${metrics.fork_repository_count}`, '—'],
      ['Archived / disabled repositories', `${metrics.archived_repository_count} / ${metrics.disabled_repository_count}`, '—'],
      ['Stars', number(metrics.total_stars), delta(metrics.stars_delta)],
      ['Forks of tracked repositories', number(metrics.total_forks), delta(metrics.forks_delta)],
      ['Open issues and pull requests', number(metrics.total_open_issues_and_pull_requests), delta(metrics.open_issues_and_pull_requests_delta)],
      ['Repositories with About / website', `${metrics.repositories_with_about} / ${metrics.repositories_with_website}`, '—'],
      ['Distinct sampled events', number(metrics.sampled_events), '—'],
    ]), '',
  ];

  if (!previousSnapshot) {
    lines.push('This is the first available daily capture: a baseline for future comparisons. Change metrics are `null` until an earlier daily snapshot exists.', '');
  } else {
    lines.push(
      `## Changes since ${previousSnapshot.snapshot_date}`, '',
      `Comparison interval: **${escapeText(previousSnapshot.captured_at)} → ${escapeText(snapshot.captured_at)}**, spanning ${metrics.comparison_days} UTC calendar day${metrics.comparison_days === 1 ? '' : 's'}.`, '',
      `${metrics.repositories_added} newly listed; ${metrics.repositories_removed} no longer listed; ${metrics.repositories_renamed} renamed. ${metrics.repositories_with_new_pushes} repositories have an advanced push timestamp; ${metrics.repositories_with_changed_default_branch_head} have a changed default-branch head; ${metrics.repositories_with_changed_latest_release} have a changed latest stable release.`, '',
      'Counter changes are net inventory totals; repositories entering or leaving the inventory affect them. Changed heads and release observations are not counts of commits or releases made during the interval.', '',
    );
    if (metrics.comparison_days !== null && metrics.comparison_days > 1) lines.push('There are gaps between these daily captures. The comparison covers the full interval; missing days are not reconstructed.', '');
    if (snapshot.source.events_per_repository !== previousSnapshot.source.events_per_repository) {
      lines.push('The event sample limit changed between captures, so newly observed event counts also reflect the changed coverage.', '');
    }
    if (diff.added.length) {
      lines.push('### Newly listed repositories', '', ...boundedTable(['Repository', 'About', 'Website'], diff.added, repo => [repoLink(repo), escapeText(repo.about) || '—', repo.website ? externalLink('Website', repo.website) : '—']), '');
    }
    if (diff.removed.length) {
      lines.push('### No longer listed under this account', '', 'These repositories may have become private, moved to another owner, or been deleted. The snapshots do not identify which occurred.', '', ...boundedTable(['Last observed repository', 'Last observed About'], diff.removed, repo => [repoLink(repo), escapeText(repo.about) || '—']), '');
    }
    const changed = diff.changes.filter(change => change.metadata.length || change.pushed || change.headChanged || change.releaseChanged || change.starsDelta || change.forksDelta || change.issuesDelta);
    lines.push('### Repository updates', '');
    if (changed.length) {
      lines.push(...boundedTable(['Repository', 'Observed changes', 'Stars Δ', 'Forks Δ', 'Open items Δ'], changed, change => [repoLink(change.repo), updateDescription(change), delta(change.starsDelta), delta(change.forksDelta), delta(change.issuesDelta)]), '');
    } else {
      lines.push('No comparable repository metadata, counter, push, default-branch head, or latest-release changes were observed.', '');
    }
  }

  const activity = previousSnapshot ? diff.newEvents : events;
  lines.push(previousSnapshot ? '## Newly observed activity' : '## Recent activity sample', '');
  if (activity.length) {
    lines.push(`${activity.length} distinct event${activity.length === 1 ? '' : 's'} ${previousSnapshot ? 'absent from the previous sample' : 'in the captured sample'}.`, '',
      ...boundedTable(['Event time (UTC)', 'Repository', 'Activity', 'Actor'], activity, ({ repo, event }) => [escapeText(event.created_at) || '—', repoLink(repo), eventDescription(event), escapeText(event.actor) || '—']), '');
  } else {
    lines.push(snapshot.source.events_per_repository === 0 ? 'Event collection is disabled for this capture.' : previousSnapshot ? 'No additional event IDs were observed compared with the previous sample.' : 'No public events were returned in this sample.', '');
  }
  lines.push('Event samples are bounded and can arrive late. “Newly observed” does not mean “happened today,” and an empty sample does not prove inactivity.', '');

  if (!previousSnapshot) {
    const commits = repositories.flatMap(repo => {
      const commit = available(repo) ? repo.activity.latest_commit : null;
      return commit ? [{ repo, commit }] : [];
    }).sort((a, b) => compareTimestamp(b.commit.committed_at, a.commit.committed_at) || compareText(a.repo.full_name, b.repo.full_name));
    if (commits.length) {
      lines.push('## Latest default-branch commits', '', ...boundedTable(['Repository', 'Commit time (UTC)', 'Latest commit'], commits, ({ repo, commit }) => [repoLink(repo), escapeText(commit.committed_at) || '—', externalLink(singleLine(commit.message.split(/\r?\n/)[0], 120), commit.url)]), '');
    }
  }

  const languages = new Map<string, number>();
  for (const repo of repositories) languages.set(repo.language || 'Not specified', (languages.get(repo.language || 'Not specified') ?? 0) + 1);
  const languageRows = [...languages.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
  lines.push('## Main languages', '');
  if (languageRows.length) lines.push(...boundedTable(['Language', 'Repositories'], languageRows, ([language, count]) => [escapeText(language), number(count)]), '');
  else lines.push('No public repositories were listed in this capture.', '');
  if (metrics.disabled_repository_count) lines.push(`${metrics.disabled_repository_count} disabled ${metrics.disabled_repository_count === 1 ? 'repository has' : 'repositories have'} unavailable activity. Metadata remains included; unavailable commit/release observations are excluded from those change counts.`, '');
  lines.push('## Personal notes', '', '');
  return { markdown: lines.join('\n'), metrics };
}
