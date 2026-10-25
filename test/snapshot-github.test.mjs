import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectSnapshot,
  createGitHubClient,
  listPublicRepositories,
  runSnapshot,
  writeSnapshot,
} from '../scripts/snapshot-github.mjs';

const OWNER = 'Luis85';
const CAPTURED_AT = '2026-10-25T04:17:00.000Z';

function repository(id = 1, overrides = {}) {
  const name = `project-${String(id).padStart(3, '0')}`;
  return {
    id,
    node_id: `R_${id}`,
    name,
    full_name: `${OWNER}/${name}`,
    owner: { login: OWNER },
    private: false,
    visibility: 'public',
    html_url: `https://github.com/${OWNER}/${name}`,
    description: 'A public project',
    homepage: '',
    topics: ['typescript', 'tools'],
    language: 'TypeScript',
    default_branch: 'main',
    fork: false,
    archived: false,
    disabled: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-10-24T10:00:00Z',
    pushed_at: '2026-10-24T09:00:00Z',
    stargazers_count: 8,
    forks_count: 2,
    open_issues_count: 3,
    size: 120,
    license: null,
    ...overrides,
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientFor(handler, options = {}) {
  const calls = [];
  const waits = [];
  const client = createGitHubClient({
    token: 'test-token',
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init });
      return handler(url, init, calls.length);
    },
    sleep: async (ms) => { waits.push(ms); },
    ...options,
  });
  return { client, calls, waits };
}

function emptyActivityClient(repositories, options = {}) {
  return clientFor((url) => {
    if (url.pathname === `/users/${OWNER}/repos`) return json(repositories);
    if (url.pathname.endsWith('/commits')) {
      return json({ message: 'Git Repository is empty.' }, 409);
    }
    if (url.pathname.endsWith('/releases/latest')) {
      return json({ message: 'Not Found' }, 404);
    }
    if (url.pathname.endsWith('/events')) return json([]);
    throw new Error(`Unexpected request: ${url}`);
  }, options);
}

function clock(time = CAPTURED_AT) {
  return () => new Date(time);
}

async function temporaryData(t) {
  const directory = await mkdtemp(join(tmpdir(), 'project-diary-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function emptySnapshot(time = CAPTURED_AT) {
  return collectSnapshot({
    client: emptyActivityClient([]).client,
    owner: OWNER,
    now: clock(time),
  });
}

test('discovery follows all repository pages beyond 100 and deduplicates stable IDs', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => repository(index + 1));
  const { client, calls } = clientFor((url) => {
    if (url.searchParams.get('page') === '2') {
      return json([repository(100), repository(101)]);
    }
    return json(firstPage, 200, {
      link: '<https://api.github.com/users/Luis85/repos?type=owner&per_page=100&page=2>; rel="next", <https://api.github.com/users/Luis85/repos?type=owner&per_page=100&page=2>; rel="last"',
    });
  });

  const result = await listPublicRepositories(client, OWNER);

  assert.equal(result.length, 101);
  assert.equal(new Set(result.map((repo) => repo.id)).size, 101);
  assert.equal(result.at(-1).id, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('per_page'), '100');
  assert.equal(calls[0].url.searchParams.get('type'), 'owner');
});

test('discovery includes forks and archives but excludes private and other owners', async () => {
  const { client } = emptyActivityClient([
    repository(5, { visibility: 'private' }),
    repository(4, { owner: { login: 'someone-else' }, full_name: 'someone-else/project' }),
    repository(3, { private: true }),
    repository(2, { archived: true }),
    repository(1, { fork: true, owner: { login: 'luis85' } }),
  ]);

  const result = await listPublicRepositories(client, OWNER);

  assert.deepEqual(result.map((repo) => repo.id), [1, 2]);
  assert.equal(result[0].fork, true);
  assert.equal(result[1].archived, true);
});

test('invalid owner and event-limit configuration fail before making requests', async () => {
  const { client, calls } = emptyActivityClient([]);

  await assert.rejects(listPublicRepositories(client, '../other-owner'));
  for (const eventsPerRepo of [-1, 101, 1.5, NaN]) {
    await assert.rejects(collectSnapshot({ client, owner: OWNER, eventsPerRepo, now: clock() }));
  }
  assert.equal(calls.length, 0);
});

test('snapshot maps About, website, counters and separate commit/release/public event activity', async () => {
  const repo = repository(42, {
    description: 'Build useful things',
    homepage: 'https://example.com/project',
    default_branch: 'release/current',
  });
  const commit = {
    sha: 'abc123',
    html_url: `${repo.html_url}/commit/abc123`,
    author: { login: 'contributor' },
    commit: {
      message: 'Improve the project\n\nMore context.',
      author: { name: 'Contributor', email: 'not-needed@example.com', date: '2026-10-24T08:00:00Z' },
      committer: { date: '2026-10-24T09:00:00Z' },
    },
  };
  const release = {
    id: 123,
    tag_name: 'v1.0.0',
    name: 'First release',
    html_url: `${repo.html_url}/releases/tag/v1.0.0`,
    created_at: '2026-10-23T10:00:00Z',
    published_at: '2026-10-24T11:00:00Z',
  };
  const events = [
    {
      id: '1001', type: 'IssuesEvent', public: true,
      actor: { login: 'contributor' }, created_at: '2026-10-24T12:00:00Z',
      payload: { action: 'opened', issue: { number: 7, title: 'Fix import', html_url: `${repo.html_url}/issues/7` } },
    },
    { id: '1002', type: 'PushEvent', public: false, payload: {}, created_at: '2026-10-24T13:00:00Z' },
    { id: '1003', type: 'PushEvent', payload: {}, created_at: '2026-10-24T14:00:00Z' },
  ];
  const { client, calls } = clientFor((url) => {
    if (url.pathname === `/users/${OWNER}/repos`) return json([repo]);
    if (url.pathname.endsWith('/commits')) return json([commit]);
    if (url.pathname.endsWith('/releases/latest')) return json(release);
    if (url.pathname.endsWith('/events')) return json(events);
    throw new Error(`Unexpected request: ${url}`);
  });

  const snapshot = await collectSnapshot({ client, owner: OWNER, now: clock() });
  const actual = snapshot.repositories[0];

  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.repository_count, 1);
  assert.equal(actual.id, 42);
  assert.equal(actual.url, repo.html_url);
  assert.equal(actual.about, repo.description);
  assert.equal(actual.website, repo.homepage);
  assert.equal(actual.updated_at, repo.updated_at);
  assert.equal(actual.pushed_at, repo.pushed_at);
  assert.deepEqual(actual.counts, { stars: 8, forks: 2, open_issues_and_pull_requests: 3 });
  assert.equal(actual.activity.latest_commit.sha, commit.sha);
  assert.equal(actual.activity.latest_commit.message, commit.commit.message);
  assert.equal(actual.activity.latest_commit.committed_at, commit.commit.committer.date);
  assert.equal(actual.activity.latest_release.tag_name, release.tag_name);
  assert.equal(actual.activity.latest_release.published_at, release.published_at);
  assert.deepEqual(actual.activity.recent_events.map((event) => event.id), ['1001']);
  assert.equal(actual.activity.recent_events[0].title, 'Fix import');
  assert.equal(actual.activity.recent_events[0].action, 'opened');
  assert.equal(actual.activity.recent_events[0].actor, 'contributor');
  assert.equal(calls.find(({ url }) => url.pathname.endsWith('/commits')).url.searchParams.get('sha'), 'release/current');
  assert.equal(calls.find(({ url }) => url.pathname.endsWith('/events')).url.searchParams.get('per_page'), '10');
  assert.equal(JSON.stringify(snapshot).includes('not-needed@example.com'), false);
});

test('empty repositories, absent releases and missing About/site remain explicit nulls', async () => {
  const { client } = emptyActivityClient([repository(1, { description: null, homepage: null })]);

  const snapshot = await collectSnapshot({ client, owner: OWNER, now: clock() });
  const repo = snapshot.repositories[0];

  assert.equal(repo.about, null);
  assert.equal(repo.website, null);
  assert.equal(repo.activity.latest_commit, null);
  assert.equal(repo.activity.latest_release, null);
  assert.deepEqual(repo.activity.recent_events, []);
});

test('an unrelated commit conflict is an error instead of being recorded as an empty repository', async () => {
  const { client } = clientFor((url) => {
    if (url.pathname === `/users/${OWNER}/repos`) return json([repository()]);
    return json({ message: 'An unrelated repository conflict' }, 409);
  });

  await assert.rejects(collectSnapshot({ client, owner: OWNER, now: clock() }));
});

test('disabled repositories stay in the inventory with explicitly unavailable activity', async () => {
  const { client, calls } = emptyActivityClient([repository(1, { disabled: true })]);

  const snapshot = await collectSnapshot({ client, owner: OWNER, now: clock() });

  assert.equal(snapshot.repository_count, 1);
  assert.equal(snapshot.repositories[0].activity.status, 'unavailable');
  assert.equal(snapshot.repositories[0].activity.reason, 'repository_disabled');
  assert.equal(snapshot.repositories[0].activity.latest_commit, null);
  assert.deepEqual(snapshot.repositories[0].activity.recent_events, []);
  assert.equal(calls.length, 1);
});

test('zero event limit disables event requests without losing other metadata', async () => {
  const { client, calls } = emptyActivityClient([repository()]);

  const snapshot = await collectSnapshot({ client, owner: OWNER, eventsPerRepo: 0, now: clock() });

  assert.equal(snapshot.repository_count, 1);
  assert.deepEqual(snapshot.repositories[0].activity.recent_events, []);
  assert.equal(calls.some(({ url }) => url.pathname.endsWith('/events')), false);
});

test('capture date uses the start in UTC even when collection finishes after midnight', async () => {
  const timestamps = [new Date('2026-10-24T23:59:59.999Z'), new Date('2026-10-25T00:00:01.000Z')];

  const snapshot = await collectSnapshot({
    client: emptyActivityClient([]).client,
    owner: OWNER,
    now: () => timestamps.shift(),
  });

  assert.equal(snapshot.snapshot_date, '2026-10-24');
  assert.equal(snapshot.captured_at, '2026-10-24T23:59:59.999Z');
  assert.equal(snapshot.completed_at, '2026-10-25T00:00:01.000Z');
});

test('same-day reruns preserve the first archive, update latest, and create a new archive next day', async (t) => {
  const dataDir = await temporaryData(t);
  const first = await emptySnapshot();
  const second = await emptySnapshot('2026-10-25T18:00:00.000Z');
  const third = await emptySnapshot('2026-10-26T04:17:00.000Z');

  const firstResult = await writeSnapshot(first, { dataDir });
  const archiveBefore = await readFile(firstResult.historyPath, 'utf8');
  const secondResult = await writeSnapshot(second, { dataDir });

  assert.equal(firstResult.historyCreated, true);
  assert.equal(secondResult.historyCreated, false);
  assert.equal(await readFile(firstResult.historyPath, 'utf8'), archiveBefore);
  assert.deepEqual(JSON.parse(await readFile(secondResult.latestPath, 'utf8')), second);

  const thirdResult = await writeSnapshot(third, { dataDir });
  assert.equal(thirdResult.historyCreated, true);
  assert.deepEqual((await readdir(join(dataDir, 'snapshots'))).sort(), ['2026-10-25.json', '2026-10-26.json']);
  assert.deepEqual((await readdir(dataDir)).sort(), ['snapshot.json', 'snapshots']);
  assert.deepEqual(JSON.parse(await readFile(thirdResult.latestPath, 'utf8')), third);
});

test('invalid existing archives stop a write before replacing the previous latest snapshot', async (t) => {
  const dataDir = await temporaryData(t);
  const initial = await emptySnapshot();
  const paths = await writeSnapshot(initial, { dataDir });
  const previousLatest = await readFile(paths.latestPath, 'utf8');
  const next = await emptySnapshot('2026-10-25T18:00:00.000Z');

  const invalidArchives = [
    '{broken json',
    'null',
    'false',
    '0',
    JSON.stringify({ ...initial, owner: 'someone-else' }),
    JSON.stringify({ ...initial, snapshot_date: '2026-10-24' }),
    JSON.stringify({ ...initial, schema_version: 999 }),
  ];
  for (const invalid of invalidArchives) {
    await writeFile(paths.historyPath, invalid, 'utf8');
    await assert.rejects(writeSnapshot(next, { dataDir }));
    assert.equal(await readFile(paths.latestPath, 'utf8'), previousLatest);
    assert.equal(await readFile(paths.historyPath, 'utf8'), invalid);
  }
});

test('a failure after collecting one repository leaves all previously successful files untouched', async (t) => {
  const dataDir = await temporaryData(t);
  const previous = await emptySnapshot('2026-10-24T04:17:00.000Z');
  const paths = await writeSnapshot(previous, { dataDir });
  const latestBefore = await readFile(paths.latestPath, 'utf8');
  const historyBefore = await readFile(paths.historyPath, 'utf8');
  const { client } = clientFor((url) => {
    if (url.pathname === `/users/${OWNER}/repos`) return json([repository(1), repository(2)]);
    if (url.pathname.includes('/project-002/')) return json({ message: 'Unavailable' }, 503);
    if (url.pathname.endsWith('/commits')) return json({ message: 'Git Repository is empty.' }, 409);
    if (url.pathname.endsWith('/releases/latest')) return json({ message: 'Not Found' }, 404);
    if (url.pathname.endsWith('/events')) return json([]);
    throw new Error(`Unexpected request: ${url}`);
  });

  await assert.rejects(runSnapshot({ client, owner: OWNER, dataDir, now: clock() }));

  assert.equal(await readFile(paths.latestPath, 'utf8'), latestBefore);
  assert.equal(await readFile(paths.historyPath, 'utf8'), historyBefore);
  assert.deepEqual(await readdir(join(dataDir, 'snapshots')), ['2026-10-24.json']);
  assert.deepEqual((await readdir(dataDir)).sort(), ['snapshot.json', 'snapshots']);
});

test('HTTP client retries timeout and transient service failure with bounded backoff', async () => {
  const { client, calls, waits } = clientFor((_url, _init, attempt) => {
    if (attempt === 1) throw new DOMException('Timed out', 'TimeoutError');
    if (attempt === 2) return json({ message: 'Unavailable' }, 503);
    return json({ ok: true });
  });

  const result = await client.get('/repos/Luis85/project-diary');

  assert.deepEqual(result.data, { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms > 0 && ms <= 60_000));
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-token');
  assert.equal(headers.get('x-github-api-version'), '2026-03-10');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('rate-limit retry honors Retry-After while ordinary forbidden/not-found responses fail immediately', async () => {
  for (const status of [429, 403]) {
    const { client, calls, waits } = clientFor((_url, _init, attempt) => (
      attempt === 1
        ? json({ message: 'API rate limit exceeded' }, status, { 'retry-after': '2', 'x-ratelimit-remaining': '0' })
        : json([])
    ));
    await client.get('/repos/Luis85/project-diary/events');
    assert.equal(calls.length, 2);
    assert.ok(waits[0] >= 2_000 && waits[0] <= 60_000);
  }

  for (const status of [403, 404]) {
    const { client, calls, waits } = clientFor(() => json({ message: status === 403 ? 'Resource not accessible by integration' : 'Not Found' }, status));
    await assert.rejects(client.get('/repos/Luis85/project-diary'));
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});

test('a rate limit requiring a long wait fails rather than retrying before the reset', async () => {
  const { client, calls, waits } = clientFor(() => json({ message: 'API rate limit exceeded' }, 429, { 'retry-after': '3600' }));

  await assert.rejects(client.get('/repos/Luis85/project-diary'));

  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('pagination refuses an external next URL before forwarding credentials', async () => {
  const { client, calls } = clientFor(() => json([repository()], 200, {
    link: '<https://untrusted.example/collect?token=not-real>; rel="next"',
  }));

  await assert.rejects(client.paginate('/users/Luis85/repos'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://api.github.com');
});
