import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiary } from '../scripts/lib/diary.mjs';

function repository(id = 1, overrides = {}) {
  const name = `project-${String(id).padStart(3, '0')}`;
  return {
    id, node_id: `R_${id}`, name, full_name: `Luis85/${name}`, owner: 'Luis85',
    url: `https://github.com/Luis85/${name}`, about: 'A useful project',
    website: null, topics: ['tool', 'typescript'], language: 'TypeScript',
    default_branch: 'main', visibility: 'public', fork: false, archived: false, disabled: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-23T00:00:00Z',
    pushed_at: '2026-10-23T00:00:00Z', size_kb: 12, license: null,
    counts: { stars: 10, forks: 3, open_issues_and_pull_requests: 2 },
    activity: { status: 'available', latest_commit: null, latest_release: null, recent_events: [] },
    ...overrides,
  };
}

function snapshot(date = '2026-10-25', repositories = [repository()], overrides = {}) {
  return {
    schema_version: 1, snapshot_date: date, captured_at: `${date}T04:17:00.000Z`,
    completed_at: `${date}T04:18:00.000Z`, owner: 'Luis85', repository_count: repositories.length,
    source: { events_per_repository: 10, events_are_complete_history: false },
    repositories,
    ...overrides,
  };
}

function event(id = '1', overrides = {}) {
  return {
    id, type: 'PushEvent', actor: 'Luis85', created_at: '2026-10-24T12:00:00Z',
    action: null, ref: 'refs/heads/main', ref_type: null, head: 'sha-1',
    commit_count: null, url: 'https://github.com/Luis85/project-001', title: null,
    ...overrides,
  };
}

function activeRepository(id, events, overrides = {}) {
  return repository(id, { activity: { status: 'available', latest_commit: null, latest_release: null, recent_events: events }, ...overrides });
}

function frontmatter(markdown) {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(block, 'YAML frontmatter must be the first content');
  return Object.fromEntries(block[1].split('\n').filter(line => !line.startsWith('tags:')).map(line => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1).trim())];
  }));
}

const comparisons = [
  'repositories_added', 'repositories_removed', 'repositories_renamed',
  'repositories_with_metadata_changes', 'repositories_with_new_pushes',
  'repositories_with_changed_default_branch_head', 'repositories_with_changed_latest_release',
  'newly_observed_events', 'stars_delta', 'forks_delta', 'open_issues_and_pull_requests_delta',
];

test('first diary creates typed flat frontmatter and explicitly null comparison metrics', () => {
  const current = snapshot('2026-10-25', [repository(1), repository(2, { fork: true, archived: true, website: 'https://example.com' })]);
  const { markdown, metrics } = buildDiary(current);
  const properties = frontmatter(markdown);

  assert.equal(properties.type, 'github-diary');
  assert.equal(properties.date, '2026-10-25');
  assert.equal(properties.owner, 'Luis85');
  assert.equal(properties.repository_count, 2);
  assert.equal(properties.original_repository_count, 1);
  assert.equal(properties.fork_repository_count, 1);
  assert.equal(properties.archived_repository_count, 1);
  assert.equal(properties.repositories_with_website, 1);
  assert.equal(properties.total_stars, 20);
  assert.equal(properties.comparison_date, null);
  assert.equal(properties.comparison_days, null);
  for (const name of comparisons) {
    assert.equal(properties[name], null, name);
    assert.equal(metrics[name], null, name);
  }
  assert.match(markdown, /tags: \[github, project-diary\]/);
  assert.match(markdown, /baseline for future comparisons/);
  assert.match(markdown, /\[Snapshot JSON\]\(\.\.\/snapshots\/2026-10-25\.json\)/);
  assert.ok(markdown.endsWith('## Personal notes\n\n'));
});

test('repository IDs keep a rename separate from additions and removals', () => {
  const previous = snapshot('2026-10-24', [repository(1), repository(2)]);
  const current = snapshot('2026-10-25', [
    repository(1, { name: 'renamed', full_name: 'Luis85/renamed', url: 'https://github.com/Luis85/renamed' }),
    repository(3, { counts: { stars: 1, forks: 0, open_issues_and_pull_requests: 0 } }),
  ]);
  const { markdown, metrics } = buildDiary(current, previous);

  assert.equal(metrics.repositories_added, 1);
  assert.equal(metrics.repositories_removed, 1);
  assert.equal(metrics.repositories_renamed, 1);
  assert.equal(metrics.repositories_with_metadata_changes, 1);
  assert.equal(metrics.stars_delta, -9);
  assert.equal(metrics.forks_delta, -3);
  assert.equal(metrics.open_issues_and_pull_requests_delta, -2);
  assert.match(markdown, /Renamed from Luis85\/project-001/);
  assert.match(markdown, /No longer listed under this account/);
  assert.match(markdown, /may have become private, moved to another owner, or been deleted/);
  assert.match(markdown, /net inventory totals/);
});

test('head, release, push and metadata changes are measured as repository observations', () => {
  const before = repository(1);
  const after = repository(1, {
    about: 'A changed description', pushed_at: '2026-10-24T16:00:00Z',
    counts: { stars: 12, forks: 2, open_issues_and_pull_requests: 1 },
    activity: {
      status: 'available',
      latest_commit: { sha: 'new', message: 'New work\n\nDetails stay in JSON', url: 'https://github.com/Luis85/project-001/commit/new', committed_at: '2026-10-24T16:00:00Z' },
      latest_release: { id: 4, tag_name: 'v1.0', url: 'https://github.com/Luis85/project-001/releases/tag/v1.0' },
      recent_events: [],
    },
  });
  const { markdown, metrics } = buildDiary(snapshot('2026-10-25', [after]), snapshot('2026-10-24', [before]));

  assert.equal(metrics.repositories_with_new_pushes, 1);
  assert.equal(metrics.repositories_with_changed_default_branch_head, 1);
  assert.equal(metrics.repositories_with_changed_latest_release, 1);
  assert.equal(metrics.repositories_with_metadata_changes, 1);
  assert.equal(metrics.stars_delta, 2);
  assert.equal(metrics.forks_delta, -1);
  assert.equal(metrics.open_issues_and_pull_requests_delta, -1);
  assert.match(markdown, /Default-branch head changed/);
  assert.match(markdown, /Latest release changed to/);
  assert.doesNotMatch(markdown, /Details stay in JSON/);
});

test('comparison reports the actual interval and links a previous diary only when it exists', () => {
  const { markdown, metrics } = buildDiary(snapshot('2026-10-27'), snapshot('2026-10-24'));

  assert.equal(metrics.comparison_date, '2026-10-24');
  assert.equal(metrics.comparison_days, 3);
  assert.match(markdown, /2026-10-24T04:17:00.000Z/);
  assert.match(markdown, /spanning 3 UTC calendar days/);
  assert.match(markdown, /missing days are not reconstructed/);
  assert.match(markdown, /\[Previous snapshot JSON\]\(\.\.\/snapshots\/2026-10-24\.json\)/);
  assert.doesNotMatch(markdown, /\[Previous diary\]/);
  const withDiary = buildDiary(snapshot('2026-10-27'), snapshot('2026-10-24'), { previousDiaryExists: true }).markdown;
  assert.match(withDiary, /\[Previous diary\]\(2026-10-24\.md\)/);
  assert.doesNotMatch(markdown, /yesterday/i);
});

test('unchanged snapshots give zero comparisons without inventing activity from timestamps', () => {
  const previous = snapshot('2026-10-24');
  const current = snapshot('2026-10-25', [repository(1, { topics: ['typescript', 'tool'] })]);
  const { markdown, metrics } = buildDiary(current, previous);

  for (const name of comparisons) assert.equal(metrics[name], 0, name);
  assert.match(markdown, /No comparable repository metadata/);
  assert.match(markdown, /No additional event IDs/);
});

test('event IDs deduplicate repeated samples and distinguish delayed observation from event time', () => {
  const previous = snapshot('2026-10-24', [activeRepository(1, [event('old')])]);
  const delayed = event('delayed', { created_at: '2026-10-22T00:00:00Z', type: 'IssuesEvent', title: 'Delayed issue', action: 'opened' });
  const current = snapshot('2026-10-25', [activeRepository(1, [event('old'), delayed, delayed]), activeRepository(2, [delayed])]);
  const { markdown, metrics } = buildDiary(current, previous);

  assert.equal(metrics.sampled_events, 2);
  assert.equal(metrics.newly_observed_events, 1);
  assert.match(markdown, /2026-10-22T00:00:00Z/);
  assert.match(markdown, /does not mean “happened today/);
  assert.equal((markdown.match(/Delayed issue/g) ?? []).length, 1);
});

test('unavailable activity never produces false head or release changes', () => {
  const current = snapshot('2026-10-25', [repository(1, {
    disabled: true, pushed_at: '2026-10-24T20:00:00Z',
    activity: { status: 'unavailable', reason: 'repository_disabled', latest_commit: null, latest_release: null, recent_events: [] },
  })]);
  const previous = snapshot('2026-10-24', [repository(1, {
    activity: { status: 'available', latest_commit: { sha: 'old' }, latest_release: { id: 1 }, recent_events: [event()] },
  })]);
  const { markdown, metrics } = buildDiary(current, previous);

  assert.equal(metrics.repositories_with_changed_default_branch_head, 0);
  assert.equal(metrics.repositories_with_changed_latest_release, 0);
  assert.equal(metrics.repositories_with_new_pushes, 1);
  assert.equal(metrics.disabled_repository_count, 1);
  assert.equal(metrics.sampled_events, 0);
  assert.match(markdown, /unavailable activity/);
});

test('enabling a different event sample size is disclosed with the observation counts', () => {
  const previous = snapshot('2026-10-24', [repository()], { source: { events_per_repository: 0 } });
  const current = snapshot('2026-10-25', [activeRepository(1, [event()])]);
  const { markdown, metrics } = buildDiary(current, previous);

  assert.equal(metrics.newly_observed_events, 1);
  assert.match(markdown, /event sample limit changed/);
  assert.match(buildDiary(previous).markdown, /Event collection is disabled/);
});

test('owner mismatches and non-earlier comparison captures are rejected', () => {
  assert.throws(() => buildDiary(snapshot(), snapshot('2026-10-24', [], { owner: 'another-owner' })), /different owners/);
  assert.throws(() => buildDiary(snapshot(), snapshot()), /earlier capture date/);
  assert.throws(() => buildDiary(snapshot(), snapshot('2026-10-26')), /earlier capture date/);
  assert.throws(() => buildDiary(snapshot(), snapshot('2026-10-24', [], { captured_at: '2026-10-26T00:00:00Z' })), /earlier capture date/);
  assert.doesNotThrow(() => buildDiary(snapshot(), snapshot('2026-10-24', [], { owner: 'luis85' })));
});

test('hostile repository text stays inline and unsafe link schemes never become Markdown links', () => {
  const hostile = repository(2, {
    full_name: 'Luis85/unsafe|[link]\n# injected',
    url: 'javascript:alert(1)', website: 'data:text/html,<script>alert(1)</script>',
    about: '<img src=x onerror=alert(1)>\n\n# Heading | `code` [click](javascript:alert(1))',
    language: '<script>bad</script>',
    activity: { status: 'available', latest_commit: null, latest_release: null, recent_events: [event('unsafe', { title: '<script>alert(1)</script> | [click](javascript:alert(1))\n# injected', url: 'javascript:alert(1)' })] },
  });
  const { markdown } = buildDiary(snapshot('2026-10-25', [hostile]), snapshot('2026-10-24', []));

  assert.doesNotMatch(markdown, /<img|<script|\]\(javascript:|\]\(data:/);
  assert.doesNotMatch(markdown, /^# injected|^# Heading/m);
  assert.match(markdown, /&lt;img/);
  assert.match(markdown, /\\\|/);
  assert.match(markdown, /\\`code\\`/);
  let columns = 0;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) { columns = 0; continue; }
    const separators = (line.match(/(?<!\\)\|/g) ?? []).length;
    if (!columns) columns = separators;
    else assert.equal(separators, columns, line);
  }
});

test('safe URL destinations encode Markdown delimiters and reject credentialed links', () => {
  const current = snapshot('2026-10-25', [
    repository(1, { website: 'https://example.com/a)b|[x]' }),
    repository(2, { url: 'https://user:password@example.com/repo' }),
  ]);
  const { markdown } = buildDiary(current, snapshot('2026-10-24', []));

  assert.match(markdown, /https:\/\/example.com\/a%29b%7C%5Bx%5D/);
  assert.doesNotMatch(markdown, /user:password/);
});

test('frontmatter strings preserve YAML-sensitive content as quoted scalar values', () => {
  const owner = 'name: "quoted"\n---\nextra: true';
  const { markdown } = buildDiary(snapshot('2026-10-25', [], { owner }));
  const properties = frontmatter(markdown);

  assert.equal(properties.owner, owner);
  assert.equal((markdown.match(/^---$/gm) ?? []).length, 2);
  assert.equal(properties.repository_count, 0);
  assert.equal(typeof properties.repository_count, 'number');
  assert.equal(properties.stars_delta, null);
});

test('diary output is deterministic without modifying snapshot input', () => {
  const current = snapshot('2026-10-25', [activeRepository(3, [event('c'), event('a')]), repository(1)]);
  const original = structuredClone(current);
  const first = buildDiary(current).markdown;
  const second = buildDiary({ ...current, repositories: [...current.repositories].reverse() }).markdown;

  assert.equal(first, second);
  assert.deepEqual(current, original);
});

test('large summaries are bounded while all metrics include the full inventory', () => {
  const repos = Array.from({ length: 45 }, (_, index) => activeRepository(index + 1, [event(String(index))]));
  const { markdown, metrics } = buildDiary(snapshot('2026-10-25', repos), snapshot('2026-10-24', []));

  assert.equal(metrics.repository_count, 45);
  assert.equal(metrics.repositories_added, 45);
  assert.equal(metrics.sampled_events, 45);
  assert.equal(metrics.newly_observed_events, 45);
  assert.equal(metrics.total_stars, 450);
  assert.match(markdown, /25 more entries omitted/);
  assert.ok(markdown.length < 20_000);
});

test('whitespace-only About/website and unspecified languages have useful empty states', () => {
  const { markdown, metrics } = buildDiary(snapshot('2026-10-25', [repository(1, { about: '  ', website: ' ', language: null })]));

  assert.equal(metrics.repositories_with_about, 0);
  assert.equal(metrics.repositories_with_website, 0);
  assert.match(markdown, /Not specified/);
  assert.match(buildDiary(snapshot('2026-10-25', [])).markdown, /No public repositories were listed/);
});
