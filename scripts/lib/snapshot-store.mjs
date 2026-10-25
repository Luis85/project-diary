import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildDiary } from './diary.mjs';
import { assertSnapshot } from './snapshot-schema.mjs';

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readSnapshot(path, { owner, date } = {}) {
  const content = await readOptional(path);
  if (content === undefined) return undefined;
  let snapshot;
  try {
    snapshot = JSON.parse(content);
    assertSnapshot(snapshot);
  } catch (error) {
    throw new Error(`Invalid saved snapshot ${path}: ${error.message}`);
  }
  if (owner && snapshot.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Snapshot ${path} tracks a different owner; use a separate data directory.`);
  }
  if (date && snapshot.snapshot_date !== date) throw new Error(`Snapshot date does not match its filename: ${path}.`);
  return snapshot;
}

async function previousArchive(directory, current) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const previous = entries
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < current.snapshot_date)
    .sort()
    .at(-1);
  if (!previous) return null;
  // A corrupt comparison baseline must fail explicitly, never silently look like zero change.
  return readSnapshot(join(directory, previous), { owner: current.owner, date: previous.slice(0, 10) });
}

async function removeIfPresent(path) {
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function removeOwnLink(entry) {
  try {
    const [target, temporary] = await Promise.all([stat(entry.path), stat(entry.temporary)]);
    if (target.dev === temporary.dev && target.ino === temporary.ino) await unlink(entry.path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** Stage every file before publishing; replace the latest pointer last. */
async function publishBundle(entries) {
  const staged = [];
  const created = [];
  try {
    for (const entry of entries) {
      await mkdir(dirname(entry.path), { recursive: true });
      const stagedEntry = { ...entry, temporary: join(dirname(entry.path), `.snapshot-${randomUUID()}.tmp`) };
      staged.push(stagedEntry);
      await writeFile(stagedEntry.temporary, entry.content, { encoding: 'utf8', flag: 'wx' });
    }
    for (const entry of staged) {
      if (entry.exclusive) {
        // Existing archives and notes are never overwritten, including a concurrent manual write.
        await link(entry.temporary, entry.path);
        created.push(entry);
      } else {
        await rename(entry.temporary, entry.path);
      }
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(created.map(removeOwnLink));
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], 'Snapshot publication and rollback failed. Inspect the data directory before retrying.');
    throw error;
  } finally {
    await Promise.all(staged.map(entry => removeIfPresent(entry.temporary)));
  }
}

/** Preserve one matching JSON/Markdown pair per UTC day and refresh the latest JSON. */
export async function writeSnapshot(snapshot, { dataDir = 'data' } = {}) {
  assertSnapshot(snapshot);
  const root = resolve(dataDir);
  const latestPath = join(root, 'snapshot.json');
  const historyPath = join(root, 'snapshots', `${snapshot.snapshot_date}.json`);
  const diaryPath = join(root, 'diary', `${snapshot.snapshot_date}.md`);
  const lockPath = join(root, '.snapshot.lock');
  await mkdir(root, { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`A snapshot writer is already running, or a previous process left ${lockPath}. Remove the lock only after confirming that no writer is running.`);
    }
    throw error;
  }

  try {
    const previousLatest = await readSnapshot(latestPath, { owner: snapshot.owner });
    if (previousLatest && Date.parse(previousLatest.captured_at) > Date.parse(snapshot.captured_at)) {
      throw new Error('Refusing to replace a newer snapshot with an older capture.');
    }
    const archive = await readSnapshot(historyPath, { owner: snapshot.owner, date: snapshot.snapshot_date });
    if (archive && Date.parse(archive.captured_at) > Date.parse(snapshot.captured_at)) {
      throw new Error('Refusing a capture older than its existing daily archive.');
    }
    const existingDiary = await readOptional(diaryPath);
    if (existingDiary !== undefined && !archive) {
      throw new Error(`A diary exists without its matching daily snapshot: ${diaryPath}. Preserve or move that note before retrying.`);
    }

    const daily = archive ?? snapshot;
    let diary;
    if (existingDiary === undefined) {
      const baseline = await previousArchive(dirname(historyPath), daily);
      const previousDiary = baseline ? await readOptional(join(dirname(diaryPath), `${baseline.snapshot_date}.md`)) : undefined;
      diary = buildDiary(daily, baseline, { previousDiaryExists: previousDiary !== undefined });
    }
    const historyCreated = archive === undefined;
    const diaryCreated = existingDiary === undefined;
    const json = `${JSON.stringify(snapshot, null, 2)}\n`;
    const entries = [];
    if (historyCreated) entries.push({ path: historyPath, content: json, exclusive: true });
    if (diaryCreated) entries.push({ path: diaryPath, content: diary.markdown, exclusive: true });
    entries.push({ path: latestPath, content: json, exclusive: false });
    await publishBundle(entries);
    return { latestPath, historyPath, historyCreated, diaryPath, diaryCreated };
  } finally {
    await rmdir(lockPath);
  }
}
