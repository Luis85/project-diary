import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildDiary } from './diary.ts';
import { errorMessage, hasErrorCode } from './errors.ts';
import { assertDate, assertOwner, assertSnapshot } from './snapshot-schema.ts';
import type { CaptureResult, SnapshotPaths, SnapshotV1, WriteResult } from './types.ts';

interface StoreOptions { dataDir?: string }
interface SnapshotLookup { owner?: string; date?: string }
interface FileEntry { path: string; content: string; exclusive: boolean }
interface StagedEntry extends FileEntry { temporary: string }

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (hasErrorCode(error, 'ENOENT')) return undefined; throw error; }
}

async function readSnapshot(path: string, { owner, date }: SnapshotLookup = {}): Promise<SnapshotV1 | undefined> {
  const content = await readOptional(path);
  if (content === undefined) return undefined;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(content);
    assertSnapshot(snapshot);
  } catch (error) {
    throw new Error(`Invalid saved snapshot ${path}: ${errorMessage(error)}`);
  }
  if (owner && snapshot.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Snapshot ${path} tracks a different owner; use a separate data directory.`);
  }
  if (date && snapshot.snapshot_date !== date) throw new Error(`Snapshot date does not match its filename: ${path}.`);
  return snapshot;
}

async function readDiary(path: string): Promise<string | undefined> {
  const content = await readOptional(path);
  if (content !== undefined && content.trim().length === 0) {
    throw new Error(`The existing diary is empty: ${path}. It was preserved; inspect it before retrying.`);
  }
  return content;
}

async function previousArchive(directory: string, current: SnapshotV1): Promise<SnapshotV1 | null> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) { if (hasErrorCode(error, 'ENOENT')) return null; throw error; }
  const previous = entries
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < current.snapshot_date)
    .sort().at(-1);
  if (!previous) return null;
  const result = await readSnapshot(join(directory, previous), { owner: current.owner, date: previous.slice(0, 10) });
  if (!result) throw new Error(`The comparison snapshot disappeared during collection: ${previous}.`);
  return result;
}

function pathsFor(root: string, date: string): SnapshotPaths {
  return {
    latestPath: join(root, 'snapshot.json'),
    historyPath: join(root, 'snapshots', `${date}.json`),
    diaryPath: join(root, 'diary', `${date}.md`),
  };
}

function serialize(snapshot: SnapshotV1): string { return `${JSON.stringify(snapshot, null, 2)}\n`; }

async function diaryEntry(daily: SnapshotV1, paths: SnapshotPaths): Promise<FileEntry> {
  const baseline = await previousArchive(dirname(paths.historyPath), daily);
  const previousDiary = baseline ? await readOptional(join(dirname(paths.diaryPath), `${baseline.snapshot_date}.md`)) : undefined;
  const diary = buildDiary(daily, baseline, { previousDiaryExists: Boolean(previousDiary?.trim()) });
  return { path: paths.diaryPath, content: diary.markdown, exclusive: true };
}

async function removeIfPresent(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; }
}

async function removeOwnLink(entry: StagedEntry): Promise<void> {
  try {
    const [target, temporary] = await Promise.all([stat(entry.path), stat(entry.temporary)]);
    if (target.dev === temporary.dev && target.ino === temporary.ino) await unlink(entry.path);
  } catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; }
}

/** Stage every file before publication; the mutable latest JSON must be the final entry. */
async function publishBundle(entries: readonly FileEntry[]): Promise<void> {
  const staged: StagedEntry[] = [];
  const created: StagedEntry[] = [];
  try {
    for (const entry of entries) {
      await mkdir(dirname(entry.path), { recursive: true });
      const item = { ...entry, temporary: join(dirname(entry.path), `.snapshot-${randomUUID()}.tmp`) };
      staged.push(item);
      await writeFile(item.temporary, entry.content, { encoding: 'utf8', flag: 'wx' });
    }
    for (const entry of staged) {
      if (entry.exclusive) {
        await link(entry.temporary, entry.path);
        created.push(entry);
      } else await rename(entry.temporary, entry.path);
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(created.map(removeOwnLink));
    const failures: unknown[] = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], 'Snapshot publication and rollback failed. Inspect the data directory before retrying.');
    throw error;
  } finally {
    await Promise.all(staged.map(entry => removeIfPresent(entry.temporary)));
  }
}

async function withWriterLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(root, '.snapshot.lock');
  await mkdir(root, { recursive: true });
  try { await mkdir(lockPath); }
  catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error(`A snapshot writer is already running, or a previous process left ${lockPath}. Remove the lock only after confirming that no writer is running.`);
    }
    throw error;
  }
  try { return await operation(); } finally { await rmdir(lockPath); }
}

/** Preserve one validated JSON/Markdown pair per UTC day and refresh the latest JSON. */
export async function writeSnapshot(value: unknown, { dataDir = 'data' }: StoreOptions = {}): Promise<WriteResult> {
  assertSnapshot(value);
  const snapshot = value;
  const root = resolve(dataDir);
  const paths = pathsFor(root, snapshot.snapshot_date);
  return withWriterLock(root, async () => {
    const previousLatest = await readSnapshot(paths.latestPath, { owner: snapshot.owner });
    if (previousLatest && Date.parse(previousLatest.captured_at) > Date.parse(snapshot.captured_at)) {
      throw new Error('Refusing to replace a newer snapshot with an older capture.');
    }
    const archive = await readSnapshot(paths.historyPath, { owner: snapshot.owner, date: snapshot.snapshot_date });
    if (archive && Date.parse(archive.captured_at) > Date.parse(snapshot.captured_at)) {
      throw new Error('Refusing a capture older than its existing daily archive.');
    }
    const existingDiary = await readDiary(paths.diaryPath);
    if (existingDiary !== undefined && !archive) {
      throw new Error(`A diary exists without its matching daily snapshot: ${paths.diaryPath}. Preserve or move that note before retrying.`);
    }
    const historyCreated = archive === undefined;
    const diaryCreated = existingDiary === undefined;
    const json = serialize(snapshot);
    const entries: FileEntry[] = [];
    if (historyCreated) entries.push({ path: paths.historyPath, content: json, exclusive: true });
    if (diaryCreated) entries.push(await diaryEntry(archive ?? snapshot, paths));
    entries.push({ path: paths.latestPath, content: json, exclusive: false });
    await publishBundle(entries);
    return { ...paths, historyCreated, diaryCreated };
  });
}

/** Reuse a complete daily bundle, or repair missing derived files from its archived source. */
export async function recoverDailyCapture({ date, owner, dataDir = 'data' }: StoreOptions & { date: string; owner: string }): Promise<CaptureResult | null> {
  assertDate(date);
  assertOwner(owner);
  const root = resolve(dataDir);
  const paths = pathsFor(root, date);
  return withWriterLock(root, async () => {
    const archive = await readSnapshot(paths.historyPath, { owner, date });
    const latest = await readSnapshot(paths.latestPath, { owner });
    const existingDiary = await readDiary(paths.diaryPath);
    if (latest && latest.snapshot_date > date) throw new Error('The latest snapshot is newer than the current UTC date. Check the system clock.');
    if (!archive) {
      if (existingDiary !== undefined) throw new Error(`A diary exists without its matching daily snapshot: ${paths.diaryPath}.`);
      return null;
    }
    if (latest && latest.snapshot_date === date && Date.parse(latest.captured_at) < Date.parse(archive.captured_at)) {
      throw new Error('The latest capture is older than its daily archive. Inspect the existing data before retrying.');
    }
    const diaryCreated = existingDiary === undefined;
    const restoreLatest = latest === undefined || latest.snapshot_date !== date;
    if (!diaryCreated && !restoreLatest) {
      return { status: 'skipped', snapshot: archive, ...paths, historyCreated: false, diaryCreated: false };
    }
    const entries: FileEntry[] = [];
    if (diaryCreated) entries.push(await diaryEntry(archive, paths));
    if (restoreLatest) entries.push({ path: paths.latestPath, content: serialize(archive), exclusive: false });
    await publishBundle(entries);
    return { status: 'repaired', snapshot: archive, ...paths, historyCreated: false, diaryCreated };
  });
}
