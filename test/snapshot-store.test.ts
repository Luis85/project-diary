import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SnapshotV1 } from '../scripts/lib/types.ts';
import { assertSnapshot } from '../scripts/lib/snapshot-schema.ts';
import { writeSnapshot } from '../scripts/lib/snapshot-store.ts';

function snapshot(date = '2026-10-25', stars = 5, time = '04:17:00.000Z'): SnapshotV1 {
  return {
    schema_version: 1, snapshot_date: date, captured_at: `${date}T${time}`, completed_at: `${date}T${time}`,
    owner: 'Luis85', repository_count: 1,
    source: { provider: 'github', api_version: '2026-03-10', repository_scope: 'public_owned', include_forks: true, include_archived: true, events_per_repository: 10, events_are_complete_history: false },
    repositories: [{
      id: 1, node_id: 'R_1', name: 'project', full_name: 'Luis85/project', owner: 'Luis85',
      url: 'https://github.com/Luis85/project', about: 'A project', website: null,
      topics: [], language: 'TypeScript', default_branch: 'main', visibility: 'public',
      fork: false, archived: false, disabled: false, size_kb: 20, license: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', pushed_at: null,
      counts: { stars, forks: 1, open_issues_and_pull_requests: 2 },
      activity: { status: 'available', latest_commit: null, latest_release: null, recent_events: [] },
    }],
  };
}

function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null, 'Expected the fixture/result item to exist');
  return value;
}

async function loadSnapshot(path: string): Promise<SnapshotV1> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assertSnapshot(value);
  return value;
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'project-diary-storage-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function properties(markdown: string): Record<string, unknown> {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  const text = required(block?.[1]);
  return Object.fromEntries(text.split('\n').filter(line => !line.startsWith('tags:')).map(line => {
    const separator = line.indexOf(':');
    const value: unknown = JSON.parse(line.slice(separator + 1).trim());
    return [line.slice(0, separator), value];
  }));
}

test('a successful capture creates matching JSON and an Obsidian note with numeric metrics', async t => {
  const dataDir = await directory(t);
  const current = snapshot();
  const result = await writeSnapshot(current, { dataDir });
  const note = properties(await readFile(result.diaryPath, 'utf8'));

  assert.equal(result.historyCreated, true);
  assert.equal(result.diaryCreated, true);
  assert.deepEqual(await loadSnapshot(result.latestPath), current);
  assert.deepEqual(await loadSnapshot(result.historyPath), current);
  assert.equal(note.date, current.snapshot_date);
  assert.equal(note.captured_at, current.captured_at);
  assert.equal(note.repository_count, 1);
  assert.equal(note.total_stars, 5);
  assert.equal(note.stars_delta, null);
  assert.deepEqual((await readdir(dataDir)).sort(), ['diary', 'snapshot.json', 'snapshots']);
  assert.deepEqual(await readdir(join(dataDir, 'diary')), ['2026-10-25.md']);
  assert.deepEqual(await readdir(join(dataDir, 'snapshots')), ['2026-10-25.json']);
});

test('same-day refresh preserves the exact diary bytes including personal notes', async t => {
  const dataDir = await directory(t);
  const first = await writeSnapshot(snapshot(), { dataDir });
  const archive = await readFile(first.historyPath, 'utf8');
  const personalNote = `${await readFile(first.diaryPath, 'utf8')}Reviewed roadmap with the team.\n`;
  await writeFile(first.diaryPath, personalNote);

  const result = await writeSnapshot(snapshot('2026-10-25', 99, '18:00:00.000Z'), { dataDir });

  assert.equal(result.historyCreated, false);
  assert.equal(result.diaryCreated, false);
  assert.equal(await readFile(result.diaryPath, 'utf8'), personalNote);
  assert.equal(await readFile(result.historyPath, 'utf8'), archive);
  assert.equal(required((await loadSnapshot(result.latestPath)).repositories[0]).counts.stars, 99);
});

test('a missing same-day note is regenerated from the frozen archive rather than refreshed data', async t => {
  const dataDir = await directory(t);
  const first = await writeSnapshot(snapshot(), { dataDir });
  const originalNote = await readFile(first.diaryPath, 'utf8');
  await unlink(first.diaryPath);

  const result = await writeSnapshot(snapshot('2026-10-25', 99, '18:00:00.000Z'), { dataDir });

  assert.equal(result.historyCreated, false);
  assert.equal(result.diaryCreated, true);
  assert.equal(await readFile(result.diaryPath, 'utf8'), originalNote);
  assert.equal(properties(originalNote).total_stars, 5);
});

test('diary comparison uses the nearest earlier archive and discloses gaps instead of using latest JSON', async t => {
  const dataDir = await directory(t);
  const first = await writeSnapshot(snapshot('2026-10-24', 5), { dataDir });
  // A newer latest file can exist independently from a retained daily comparison archive.
  await writeFile(first.latestPath, JSON.stringify(snapshot('2026-10-26', 999)));

  const result = await writeSnapshot(snapshot('2026-10-27', 8), { dataDir });
  const markdown = await readFile(result.diaryPath, 'utf8');
  const note = properties(markdown);

  assert.equal(note.comparison_date, '2026-10-24');
  assert.equal(note.comparison_days, 3);
  assert.equal(note.stars_delta, 3);
  assert.match(markdown, /gaps between these daily captures/);
});

test('corrupt historical metrics stop publication before any current-day file is created', async t => {
  const dataDir = await directory(t);
  const first = await writeSnapshot(snapshot('2026-10-24'), { dataDir });
  const latest = await readFile(first.latestPath, 'utf8');
  const previousNote = await readFile(first.diaryPath, 'utf8');
  const valid = snapshot('2026-10-24');
  const repo = required(valid.repositories[0]);
  const corrupt: unknown = { ...valid, repositories: [{ ...repo, counts: { ...repo.counts, stars: 'five' } }] };
  await writeFile(first.historyPath, JSON.stringify(corrupt));

  await assert.rejects(writeSnapshot(snapshot(), { dataDir }), /Invalid saved snapshot/);

  assert.equal(await readFile(first.latestPath, 'utf8'), latest);
  assert.equal(await readFile(first.diaryPath, 'utf8'), previousNote);
  assert.deepEqual(await readdir(join(dataDir, 'snapshots')), ['2026-10-24.json']);
  assert.deepEqual(await readdir(join(dataDir, 'diary')), ['2026-10-24.md']);
  assert.deepEqual((await readdir(dataDir)).sort(), ['diary', 'snapshot.json', 'snapshots']);
});

test('legacy JSON history without an older diary still produces working comparison links', async t => {
  const dataDir = await directory(t);
  const first = await writeSnapshot(snapshot('2026-10-24'), { dataDir });
  await unlink(first.diaryPath);

  const result = await writeSnapshot(snapshot(), { dataDir });
  const markdown = await readFile(result.diaryPath, 'utf8');

  assert.match(markdown, /\[Previous snapshot JSON\]\(\.\.\/snapshots\/2026-10-24\.json\)/);
  assert.doesNotMatch(markdown, /\[Previous diary\]/);
  assert.equal(properties(markdown).comparison_date, '2026-10-24');
});

test('an existing writer lock is respected and is not removed by the rejected writer', async t => {
  const dataDir = await directory(t);
  await mkdir(join(dataDir, '.snapshot.lock'));

  await assert.rejects(writeSnapshot(snapshot(), { dataDir }), /writer is already running/);

  assert.deepEqual(await readdir(dataDir), ['.snapshot.lock']);
});

test('a diary without a matching archive is preserved instead of paired with unrelated generated metrics', async t => {
  const dataDir = await directory(t);
  await mkdir(join(dataDir, 'diary'));
  const path = join(dataDir, 'diary', '2026-10-25.md');
  await writeFile(path, '# My pre-existing daily note\n');

  await assert.rejects(writeSnapshot(snapshot(), { dataDir }), /without its matching daily snapshot/);

  assert.equal(await readFile(path, 'utf8'), '# My pre-existing daily note\n');
  assert.deepEqual(await readdir(dataDir), ['diary']);
});

test('a blocked diary destination leaves an existing latest snapshot and archive untouched', async t => {
  const dataDir = await directory(t);
  const first = await writeSnapshot(snapshot('2026-10-24'), { dataDir });
  const latest = await readFile(first.latestPath, 'utf8');
  await mkdir(join(dataDir, 'diary', '2026-10-25.md'));

  await assert.rejects(writeSnapshot(snapshot(), { dataDir }));

  assert.equal(await readFile(first.latestPath, 'utf8'), latest);
  assert.deepEqual(await readdir(join(dataDir, 'snapshots')), ['2026-10-24.json']);
  assert.deepEqual((await readdir(dataDir)).sort(), ['diary', 'snapshot.json', 'snapshots']);
});

test('validation rejects misleading counters, duplicate identities, invalid UTC times and private scope', () => {
  assert.doesNotThrow(() => assertSnapshot(snapshot()));
  const valid = snapshot();
  const repo = required(valid.repositories[0]);
  const replaceRepository = (changes: Record<string, unknown>): unknown => ({
    ...valid,
    repositories: [{ ...repo, ...changes }],
  });
  const invalidValues: unknown[] = [
    replaceRepository({ counts: { ...repo.counts, stars: undefined } }),
    replaceRepository({ counts: { ...repo.counts, forks: -1 } }),
    replaceRepository({ counts: { ...repo.counts, open_issues_and_pull_requests: 1.5 } }),
    { ...valid, repositories: [repo, structuredClone(repo)], repository_count: 2 },
    replaceRepository({ owner: 'other' }),
    replaceRepository({ visibility: 'private' }),
    replaceRepository({ pushed_at: '2026-02-30T00:00:00Z' }),
    { ...valid, completed_at: '2026-10-24T04:17:00.000Z' },
    { ...valid, captured_at: '2026-10-25T06:17:00+02:00' },
    replaceRepository({ activity: { ...repo.activity, status: 'unknown' } }),
  ];
  for (const invalid of invalidValues) assert.throws(() => assertSnapshot(invalid));
});

test('invalid incoming data and captures older than current latest never replace successful files', async t => {
  const dataDir = await directory(t);
  const first = await writeSnapshot(snapshot(), { dataDir });
  const latest = await readFile(first.latestPath, 'utf8');
  const note = await readFile(first.diaryPath, 'utf8');
  const valid = snapshot('2026-10-26');
  const repo = required(valid.repositories[0]);
  const invalid: unknown = { ...valid, repositories: [{ ...repo, counts: { ...repo.counts, stars: null } }] };

  await assert.rejects(writeSnapshot(invalid, { dataDir }));
  await assert.rejects(writeSnapshot(snapshot('2026-10-24'), { dataDir }), /newer snapshot/);

  assert.equal(await readFile(first.latestPath, 'utf8'), latest);
  assert.equal(await readFile(first.diaryPath, 'utf8'), note);
  assert.deepEqual(await readdir(join(dataDir, 'snapshots')), ['2026-10-25.json']);
});
