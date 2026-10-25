import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { API_VERSION, createGitHubClient } from './lib/github-client.ts';
import { githubArray, githubObject, normalizeRepository, repositoryLabel, summarizeCommit, summarizeEvent, summarizeRelease } from './lib/github-data.ts';
import { assertOwner, assertEventLimit, assertSnapshot } from './lib/snapshot-schema.ts';
import { recoverDailyCapture, writeSnapshot } from './lib/snapshot-store.ts';
import { contextualError, errorMessage } from './lib/errors.ts';
import type { CaptureResult, CollectionOptions, EventSummary, GitHubClient, RepositoryActivity, RepositoryMetadata, RepositorySnapshot, RunOptions, SnapshotV1 } from './lib/types.ts';

export { API_VERSION, createGitHubClient, writeSnapshot };
export type { SnapshotV1, RepositorySnapshot, DiaryMetrics } from './lib/types.ts';

/** Enumerate and normalize every public repository owned by the account. */
export async function listPublicRepositories(client: GitHubClient, owner: string): Promise<RepositoryMetadata[]> {
  assertOwner(owner);
  const repos = await client.paginate(`/users/${encodeURIComponent(owner)}/repos?type=owner&sort=full_name&direction=asc&per_page=100`);
  const unique = new Map<number, RepositoryMetadata>();
  for (const [index, value] of repos.entries()) {
    try {
      const repo = normalizeRepository(value, owner);
      if (repo) unique.set(repo.id, repo);
    } catch (error) {
      throw contextualError(`Could not read metadata for ${repositoryLabel(value)} at inventory item ${index + 1}`, error);
    }
  }
  return [...unique.values()].sort((a, b) => a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0);
}

async function readActivity<T>(repo: RepositoryMetadata, stage: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw contextualError(`Could not read ${stage} for ${repositoryLabel(repo)}`, error);
  }
}

async function collectActivity(client: GitHubClient, repo: RepositoryMetadata, eventsPerRepo: number): Promise<RepositoryActivity> {
  if (repo.disabled) return { status: 'unavailable', reason: 'repository_disabled', latest_commit: null, latest_release: null, recent_events: [] };
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const branch = repo.default_branch ? `&sha=${encodeURIComponent(repo.default_branch)}` : '';
  const latestCommit = await readActivity(repo, 'latest commit', async () => {
    const commits = await client.get(`${base}/commits?per_page=1${branch}`, { allowedStatuses: [409] });
    if (commits.status === 409) {
      const { message } = githubObject(commits.data, 'commit error response');
      if (typeof message !== 'string' || !/\b(?:git\s+)?repository\s+is\s+empty\b/i.test(message)) {
        throw new Error('Unexpected GitHub conflict response.');
      }
      return null;
    }
    return summarizeCommit(githubArray(commits.data, 'commit list')[0]);
  });
  const latestRelease = await readActivity(repo, 'latest release', async () => {
    const release = await client.get(`${base}/releases/latest`, { allowedStatuses: [404] });
    return release.status === 404 ? null : summarizeRelease(release.data);
  });
  const recentEvents = eventsPerRepo > 0 ? await readActivity(repo, 'public events', async () => {
    const response = await client.get(`${base}/events?per_page=${eventsPerRepo}`);
    const unique = new Map<string, EventSummary>();
    for (const value of githubArray(response.data, 'event list')) {
      const event = summarizeEvent(value, repo.url);
      if (event) unique.set(event.id, event);
    }
    return [...unique.values()].slice(0, eventsPerRepo);
  }) : [];
  return { status: 'available', latest_commit: latestCommit, latest_release: latestRelease, recent_events: recentEvents };
}

/** The complete normalized inventory must pass runtime validation before persistence. */
export async function collectSnapshot({ client, owner, eventsPerRepo = 10, now = () => new Date(), startedAt }: CollectionOptions): Promise<SnapshotV1> {
  assertOwner(owner);
  assertEventLimit(eventsPerRepo);
  const capturedAt = (startedAt ?? now()).toISOString();
  const repositories: RepositorySnapshot[] = [];
  for (const repo of await listPublicRepositories(client, owner)) {
    repositories.push({ ...repo, activity: await collectActivity(client, repo, eventsPerRepo) });
  }
  const snapshot: SnapshotV1 = {
    schema_version: 1, snapshot_date: capturedAt.slice(0, 10), captured_at: capturedAt,
    completed_at: now().toISOString(), owner,
    source: {
      provider: 'github', api_version: API_VERSION, repository_scope: 'public_owned',
      include_forks: true, include_archived: true, events_per_repository: eventsPerRepo,
      events_are_complete_history: false,
    },
    repository_count: repositories.length, repositories,
  };
  assertSnapshot(snapshot);
  return snapshot;
}

export async function runSnapshot({ client, owner, eventsPerRepo = 10, dataDir = 'data', now = () => new Date(), ifNeeded = false }: RunOptions): Promise<CaptureResult> {
  assertOwner(owner);
  assertEventLimit(eventsPerRepo);
  const startedAt = now();
  if (ifNeeded) {
    const existing = await recoverDailyCapture({ date: startedAt.toISOString().slice(0, 10), owner, dataDir });
    if (existing) return existing;
  }
  const snapshot = await collectSnapshot({ client, owner, eventsPerRepo, now, startedAt });
  const files = await writeSnapshot(snapshot, { dataDir });
  return { status: 'captured', snapshot, ...files };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'if-needed': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log('Usage: npm run snapshot -- [--if-needed]\n\n--if-needed  Reuse today\'s validated capture, or repair missing derived files from its archive.\nEnvironment: GITHUB_OWNER, GITHUB_TOKEN/GH_TOKEN, SNAPSHOT_EVENTS_PER_REPO, SNAPSHOT_DATA_DIR.');
    return;
  }
  const owner = process.env.GITHUB_OWNER || process.env.GITHUB_REPOSITORY_OWNER || 'Luis85';
  const eventLimit = process.env.SNAPSHOT_EVENTS_PER_REPO ?? '10';
  if (!/^\d+$/.test(eventLimit)) throw new Error('SNAPSHOT_EVENTS_PER_REPO must be an integer from 0 to 100.');
  const result = await runSnapshot({
    client: createGitHubClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '' }),
    owner, eventsPerRepo: Number(eventLimit), dataDir: process.env.SNAPSHOT_DATA_DIR || 'data', ifNeeded: values['if-needed'],
  });
  console.log(`${result.status}: ${result.snapshot.repository_count} public repositories for ${owner}; daily source ${result.snapshot.captured_at}.`);
  console.log(`Latest: ${result.latestPath}`);
  console.log(`History: ${result.historyPath} (${result.historyCreated ? 'created' : 'preserved'})`);
  console.log(`Diary: ${result.diaryPath} (${result.diaryCreated ? 'created' : 'preserved'})`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => { console.error(`Snapshot failed: ${errorMessage(error)}`); process.exitCode = 1; });
}
