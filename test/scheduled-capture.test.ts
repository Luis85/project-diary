import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runSnapshot } from '../scripts/snapshot-github.ts';
import { assertSnapshot } from '../scripts/lib/snapshot-schema.ts';
import type { GitHubClient, SnapshotV1 } from '../scripts/lib/types.ts';

const OWNER = 'Luis85';
const FIRST_CAPTURE = '2026-10-25T04:17:00.000Z';
const RECOVERY_CAPTURE = '2026-10-25T10:17:00.000Z';

function clock(value = FIRST_CAPTURE): () => Date {
  return () => new Date(value);
}

function inventoryClient(): { client: GitHubClient; calls: string[] } {
  const calls: string[] = [];
  const client: GitHubClient = {
    async paginate(path) {
      calls.push(path);
      return [];
    },
    async get(path) {
      throw new Error(`Unexpected detail request for an empty inventory: ${path}`);
    },
  };
  return { client, calls };
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'project-diary-schedule-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function loadSnapshot(path: string): Promise<SnapshotV1> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assertSnapshot(value);
  return value;
}

test('a scheduled run captures a missing daily bundle', async t => {
  const dataDir = await directory(t);
  const { client, calls } = inventoryClient();

  const result = await runSnapshot({ client, owner: OWNER, dataDir, ifNeeded: true, now: clock() });

  assert.equal(result.status, 'captured');
  assert.equal(calls.length, 1);
  assert.equal(result.snapshot.snapshot_date, '2026-10-25');
  assert.equal(result.historyCreated, true);
  assert.equal(result.diaryCreated, true);
  assert.equal((await loadSnapshot(result.latestPath)).captured_at, FIRST_CAPTURE);
  assert.match(await readFile(result.diaryPath, 'utf8'), /^---\n/);
});

test('a complete daily bundle skips API requests and leaves files and annotations untouched', async t => {
  const dataDir = await directory(t);
  const first = await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock() });
  const latest = await readFile(first.latestPath, 'utf8');
  const archive = await readFile(first.historyPath, 'utf8');
  const note = `${await readFile(first.diaryPath, 'utf8')}Personal observation preserved.\n`;
  await writeFile(first.diaryPath, note);
  const { client, calls } = inventoryClient();

  const result = await runSnapshot({ client, owner: OWNER, dataDir, ifNeeded: true, now: clock(RECOVERY_CAPTURE) });

  assert.equal(result.status, 'skipped');
  assert.equal(result.historyCreated, false);
  assert.equal(result.diaryCreated, false);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(result.latestPath, 'utf8'), latest);
  assert.equal(await readFile(result.historyPath, 'utf8'), archive);
  assert.equal(await readFile(result.diaryPath, 'utf8'), note);
});

test('a missing same-day diary is repaired from its archive without API access or losing a newer latest capture', async t => {
  const dataDir = await directory(t);
  const first = await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock() });
  const note = await readFile(first.diaryPath, 'utf8');
  const archive = await readFile(first.historyPath, 'utf8');
  await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock(RECOVERY_CAPTURE) });
  const latest = await readFile(first.latestPath, 'utf8');
  await unlink(first.diaryPath);
  const { client, calls } = inventoryClient();

  const result = await runSnapshot({ client, owner: OWNER, dataDir, ifNeeded: true, now: clock('2026-10-25T16:17:00.000Z') });

  assert.equal(result.status, 'repaired');
  assert.equal(calls.length, 0);
  assert.equal(result.historyCreated, false);
  assert.equal(result.diaryCreated, true);
  assert.equal(await readFile(result.historyPath, 'utf8'), archive);
  assert.equal(await readFile(result.diaryPath, 'utf8'), note);
  assert.equal(await readFile(result.latestPath, 'utf8'), latest);
  assert.equal((await loadSnapshot(result.latestPath)).captured_at, RECOVERY_CAPTURE);
});

test('a missing latest JSON is repaired from the current archive without API access', async t => {
  const dataDir = await directory(t);
  const first = await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock() });
  const archive = await readFile(first.historyPath, 'utf8');
  const note = await readFile(first.diaryPath, 'utf8');
  await unlink(first.latestPath);
  const { client, calls } = inventoryClient();

  const result = await runSnapshot({ client, owner: OWNER, dataDir, ifNeeded: true, now: clock(RECOVERY_CAPTURE) });

  assert.equal(result.status, 'repaired');
  assert.equal(calls.length, 0);
  assert.equal((await loadSnapshot(result.latestPath)).captured_at, FIRST_CAPTURE);
  assert.equal(await readFile(result.historyPath, 'utf8'), archive);
  assert.equal(await readFile(result.diaryPath, 'utf8'), note);
});

test('a prior day does not prevent the next day from capturing automatically', async t => {
  const dataDir = await directory(t);
  const first = await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock() });
  const note = await readFile(first.diaryPath, 'utf8');
  const { client, calls } = inventoryClient();

  const result = await runSnapshot({ client, owner: OWNER, dataDir, ifNeeded: true, now: clock('2026-10-26T04:17:00.000Z') });

  assert.equal(result.status, 'captured');
  assert.equal(calls.length, 1);
  assert.equal(result.snapshot.snapshot_date, '2026-10-26');
  assert.deepEqual((await readdir(join(dataDir, 'snapshots'))).sort(), ['2026-10-25.json', '2026-10-26.json']);
  assert.deepEqual((await readdir(join(dataDir, 'diary'))).sort(), ['2026-10-25.md', '2026-10-26.md']);
  assert.equal(await readFile(first.diaryPath, 'utf8'), note);
});

test('a corrupt daily archive fails before API requests instead of being skipped or replaced', async t => {
  const dataDir = await directory(t);
  const first = await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock() });
  const latest = await readFile(first.latestPath, 'utf8');
  const note = await readFile(first.diaryPath, 'utf8');
  await writeFile(first.historyPath, '{invalid JSON');
  const { client, calls } = inventoryClient();

  await assert.rejects(runSnapshot({ client, owner: OWNER, dataDir, ifNeeded: true, now: clock(RECOVERY_CAPTURE) }), /Invalid saved snapshot/);

  assert.equal(calls.length, 0);
  assert.equal(await readFile(first.latestPath, 'utf8'), latest);
  assert.equal(await readFile(first.diaryPath, 'utf8'), note);
  assert.equal(await readFile(first.historyPath, 'utf8'), '{invalid JSON');
});

test('an empty existing diary fails visibly rather than being overwritten or treated as a complete day', async t => {
  const dataDir = await directory(t);
  const first = await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock() });
  const latest = await readFile(first.latestPath, 'utf8');
  const archive = await readFile(first.historyPath, 'utf8');
  await writeFile(first.diaryPath, ' \n\t');
  const { client, calls } = inventoryClient();

  await assert.rejects(runSnapshot({ client, owner: OWNER, dataDir, ifNeeded: true, now: clock(RECOVERY_CAPTURE) }), /empty|whitespace|blank/i);

  assert.equal(calls.length, 0);
  assert.equal(await readFile(first.latestPath, 'utf8'), latest);
  assert.equal(await readFile(first.historyPath, 'utf8'), archive);
  assert.equal(await readFile(first.diaryPath, 'utf8'), ' \n\t');
});

test('manual same-day execution still refreshes latest JSON and keeps the frozen daily pair', async t => {
  const dataDir = await directory(t);
  const first = await runSnapshot({ client: inventoryClient().client, owner: OWNER, dataDir, now: clock() });
  const archive = await readFile(first.historyPath, 'utf8');
  const note = await readFile(first.diaryPath, 'utf8');
  const { client, calls } = inventoryClient();

  const result = await runSnapshot({ client, owner: OWNER, dataDir, now: clock(RECOVERY_CAPTURE) });

  assert.equal(result.status, 'captured');
  assert.equal(calls.length, 1);
  assert.equal((await loadSnapshot(result.latestPath)).captured_at, RECOVERY_CAPTURE);
  assert.equal(await readFile(first.historyPath, 'utf8'), archive);
  assert.equal(await readFile(first.diaryPath, 'utf8'), note);
});

test('scheduled recovery fixes the capture start once across midnight', async t => {
  const dataDir = await directory(t);
  const timestamps = [new Date('2026-10-25T23:59:59.999Z'), new Date('2026-10-26T00:00:01.000Z')];
  const { client } = inventoryClient();

  const result = await runSnapshot({
    client, owner: OWNER, dataDir, ifNeeded: true,
    now: () => {
      const value = timestamps.shift();
      assert.ok(value, 'The run should read the clock once for start and once for completion');
      return value;
    },
  });

  assert.equal(result.snapshot.snapshot_date, '2026-10-25');
  assert.equal(result.snapshot.captured_at, '2026-10-25T23:59:59.999Z');
  assert.equal(result.snapshot.completed_at, '2026-10-26T00:00:01.000Z');
  assert.equal(timestamps.length, 0);
});
