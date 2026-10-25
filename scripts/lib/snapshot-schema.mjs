/** Validation shared by collection, historical comparisons, and persistence. */
export function assertOwner(owner) {
  if (typeof owner !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) {
    throw new Error('GITHUB_OWNER must be a GitHub username (1–39 letters, digits, or hyphens).');
  }
}

export function assertEventLimit(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('SNAPSHOT_EVENTS_PER_REPO must be an integer from 0 to 100.');
  }
}

function fail(field) {
  throw new Error(`Invalid snapshot field: ${field}.`);
}

function text(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string') fail(field);
}

function counter(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(field);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field);
}

export function assertDate(date, field = 'snapshot_date') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(field);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail(field);
}

function timestamp(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail(field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) fail(field);
}

function activity(value, repo, maxEvents, field) {
  object(value, field);
  if (!['available', 'unavailable'].includes(value.status)) fail(`${field}.status`);
  if (!Array.isArray(value.recent_events) || value.recent_events.length > maxEvents) fail(`${field}.recent_events`);
  if (value.status === 'unavailable' && (
    !repo.disabled || value.reason !== 'repository_disabled' || value.latest_commit !== null ||
    value.latest_release !== null || value.recent_events.length !== 0
  )) fail(`${field}.unavailable`);

  if (value.latest_commit !== null) {
    const commit = value.latest_commit;
    object(commit, `${field}.latest_commit`);
    if (typeof commit.sha !== 'string' || !commit.sha) fail(`${field}.latest_commit.sha`);
    text(commit.message, `${field}.latest_commit.message`);
    text(commit.author, `${field}.latest_commit.author`, true);
    text(commit.url, `${field}.latest_commit.url`, true);
    timestamp(commit.authored_at, `${field}.latest_commit.authored_at`, true);
    timestamp(commit.committed_at, `${field}.latest_commit.committed_at`, true);
  }
  if (value.latest_release !== null) {
    const release = value.latest_release;
    object(release, `${field}.latest_release`);
    if (!Number.isSafeInteger(release.id) || release.id < 1) fail(`${field}.latest_release.id`);
    if (typeof release.tag_name !== 'string' || !release.tag_name) fail(`${field}.latest_release.tag_name`);
    text(release.name, `${field}.latest_release.name`, true);
    text(release.url, `${field}.latest_release.url`, true);
    timestamp(release.created_at, `${field}.latest_release.created_at`, true);
    timestamp(release.published_at, `${field}.latest_release.published_at`, true);
  }
  for (const event of value.recent_events) {
    object(event, `${field}.recent_events[]`);
    if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string' || !event.type) {
      fail(`${field}.recent_events[].identity`);
    }
    timestamp(event.created_at, `${field}.recent_events[].created_at`, true);
    for (const key of ['actor', 'action', 'ref', 'ref_type', 'head', 'url', 'title']) {
      text(event[key], `${field}.recent_events[].${key}`, true);
    }
    if (event.commit_count !== null) counter(event.commit_count, `${field}.recent_events[].commit_count`);
  }
}

/** Reject malformed or incompatible history before deriving metrics or changing files. */
export function assertSnapshot(snapshot) {
  object(snapshot, 'snapshot');
  if (snapshot.schema_version !== 1) fail('schema_version');
  assertOwner(snapshot.owner);
  assertDate(snapshot.snapshot_date);
  timestamp(snapshot.captured_at, 'captured_at');
  timestamp(snapshot.completed_at, 'completed_at');
  if (snapshot.captured_at.slice(0, 10) !== snapshot.snapshot_date) fail('captured_at date');
  if (Date.parse(snapshot.completed_at) < Date.parse(snapshot.captured_at)) fail('completed_at ordering');
  counter(snapshot.repository_count, 'repository_count');
  if (!Array.isArray(snapshot.repositories) || snapshot.repository_count !== snapshot.repositories.length) fail('repositories');
  object(snapshot.source, 'source');
  if (snapshot.source.provider !== 'github' || snapshot.source.repository_scope !== 'public_owned') fail('source scope');
  assertEventLimit(snapshot.source.events_per_repository);

  const ids = new Set();
  const names = new Set();
  for (const repo of snapshot.repositories) {
    object(repo, 'repositories[]');
    const field = `repositories[${repo.id ?? '?'}]`;
    if (!Number.isSafeInteger(repo.id) || repo.id < 1 || ids.has(repo.id)) fail(`${field}.id`);
    ids.add(repo.id);
    assertOwner(repo.owner);
    if (repo.owner.toLowerCase() !== snapshot.owner.toLowerCase() || repo.visibility !== 'public') fail(`${field}.scope`);
    if (typeof repo.name !== 'string' || !repo.name || repo.name.includes('/') ||
        repo.full_name !== `${repo.owner}/${repo.name}` || names.has(repo.full_name.toLowerCase())) fail(`${field}.name`);
    names.add(repo.full_name.toLowerCase());
    if (typeof repo.url !== 'string' || !repo.url) fail(`${field}.url`);
    for (const key of ['node_id', 'about', 'website', 'language', 'default_branch']) text(repo[key], `${field}.${key}`, true);
    if (!Array.isArray(repo.topics) || repo.topics.some(topic => typeof topic !== 'string')) fail(`${field}.topics`);
    for (const key of ['fork', 'archived', 'disabled']) if (typeof repo[key] !== 'boolean') fail(`${field}.${key}`);
    for (const key of ['created_at', 'updated_at', 'pushed_at']) timestamp(repo[key], `${field}.${key}`, true);
    if (repo.size_kb !== null) counter(repo.size_kb, `${field}.size_kb`);
    if (repo.license !== null) {
      object(repo.license, `${field}.license`);
      for (const key of ['key', 'name', 'spdx_id']) text(repo.license[key], `${field}.license.${key}`);
      text(repo.license.url, `${field}.license.url`, true);
    }
    object(repo.counts, `${field}.counts`);
    for (const key of ['stars', 'forks', 'open_issues_and_pull_requests']) counter(repo.counts[key], `${field}.counts.${key}`);
    activity(repo.activity, repo, snapshot.source.events_per_repository, `${field}.activity`);
  }
}
