import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_VERSION, createGitHubClient } from './lib/github-client.mjs';
import { assertOwner, assertEventLimit, assertSnapshot } from './lib/snapshot-schema.mjs';
import { writeSnapshot } from './lib/snapshot-store.mjs';

export { API_VERSION, createGitHubClient, writeSnapshot };

/** Enumerate public repositories owned by the account, including forks and archives. */
export async function listPublicRepositories(client, owner) {
  assertOwner(owner);
  const repos = await client.paginate(
    `/users/${encodeURIComponent(owner)}/repos?type=owner&sort=full_name&direction=asc&per_page=100`,
  );
  const unique = new Map();
  for (const repo of repos) {
    if (!repo || typeof repo.private !== 'boolean' || typeof repo.owner?.login !== 'string') {
      throw new Error('GitHub returned invalid repository visibility or owner metadata.');
    }
    if (repo.private || (repo.visibility && repo.visibility !== 'public')) continue;
    if (repo.owner.login.toLowerCase() !== owner.toLowerCase()) continue;
    if (!Number.isSafeInteger(repo.id) || repo.id < 1 || typeof repo.full_name !== 'string' ||
        typeof repo.name !== 'string' || typeof repo.html_url !== 'string') {
      throw new Error('GitHub returned an invalid repository identity.');
    }
    if (repo.topics !== undefined && (!Array.isArray(repo.topics) || repo.topics.some(topic => typeof topic !== 'string'))) {
      throw new Error(`GitHub returned an invalid topics list for ${repo.full_name}.`);
    }
    for (const flag of ['fork', 'archived', 'disabled']) {
      if (typeof repo[flag] !== 'boolean') throw new Error(`GitHub returned an invalid ${flag} flag for ${repo.full_name}.`);
    }
    unique.set(repo.id, repo);
  }
  return [...unique.values()].sort((a, b) => a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0);
}

function repositoryMetadata(repo) {
  return {
    id: repo.id,
    node_id: repo.node_id ?? null,
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner.login,
    url: repo.html_url,
    about: repo.description ?? null,
    website: repo.homepage === '' ? null : repo.homepage ?? null,
    topics: [...new Set(repo.topics ?? [])].sort(),
    language: repo.language ?? null,
    default_branch: repo.default_branch ?? null,
    visibility: 'public',
    fork: repo.fork,
    archived: repo.archived,
    disabled: repo.disabled,
    created_at: repo.created_at ?? null,
    updated_at: repo.updated_at ?? null,
    pushed_at: repo.pushed_at ?? null,
    size_kb: repo.size ?? null,
    license: repo.license ? {
      key: repo.license.key,
      name: repo.license.name,
      spdx_id: repo.license.spdx_id,
      url: repo.license.url ?? null,
    } : null,
    counts: {
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      // GitHub's open_issues_count includes pull requests. Preserve that distinction.
      open_issues_and_pull_requests: repo.open_issues_count,
    },
  };
}

function summarizeCommit(commit) {
  if (!commit) return null;
  if (typeof commit.sha !== 'string' || typeof commit.commit?.message !== 'string') {
    throw new Error('GitHub returned invalid commit metadata.');
  }
  return {
    sha: commit.sha,
    url: commit.html_url ?? null,
    message: commit.commit.message,
    author: commit.author?.login ?? commit.commit.author?.name ?? null,
    authored_at: commit.commit.author?.date ?? null,
    committed_at: commit.commit.committer?.date ?? null,
  };
}

function summarizeRelease(release) {
  if (!Number.isSafeInteger(release?.id) || typeof release.tag_name !== 'string') {
    throw new Error('GitHub returned invalid release metadata.');
  }
  return {
    id: release.id,
    tag_name: release.tag_name,
    name: release.name ?? null,
    url: release.html_url ?? null,
    created_at: release.created_at ?? null,
    published_at: release.published_at ?? null,
  };
}

function summarizeEvent(event, repositoryUrl) {
  if (!event.id || typeof event.type !== 'string') throw new Error('GitHub returned invalid event metadata.');
  const payload = event.payload ?? {};
  const subject = payload.pull_request ?? payload.issue ?? payload.release ?? payload.forkee;
  return {
    id: String(event.id),
    type: event.type,
    actor: event.actor?.login ?? null,
    created_at: event.created_at ?? null,
    action: payload.action ?? null,
    ref: payload.ref ?? null,
    ref_type: payload.ref_type ?? null,
    head: payload.head ?? null,
    commit_count: payload.size ?? null,
    url: payload.comment?.html_url ?? subject?.html_url ?? repositoryUrl,
    title: subject?.title ?? subject?.name ?? null,
  };
}

async function collectActivity(client, repo, eventsPerRepo) {
  const activity = { status: 'available', latest_commit: null, latest_release: null, recent_events: [] };
  if (repo.disabled) return { ...activity, status: 'unavailable', reason: 'repository_disabled' };
  const base = `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
  const branch = repo.default_branch ? `&sha=${encodeURIComponent(repo.default_branch)}` : '';
  const commits = await client.get(`${base}/commits?per_page=1${branch}`, { allowedStatuses: [409] });
  if (commits.status === 409) {
    if (!/\b(?:git\s+)?repository\s+is\s+empty\b/i.test(commits.data?.message ?? '')) {
      throw new Error(`Unexpected GitHub conflict reading commits for ${repo.full_name}.`);
    }
  } else {
    if (!Array.isArray(commits.data)) throw new Error(`Invalid commit list for ${repo.full_name}.`);
    activity.latest_commit = summarizeCommit(commits.data[0]);
  }

  const release = await client.get(`${base}/releases/latest`, { allowedStatuses: [404] });
  if (release.status !== 404) activity.latest_release = summarizeRelease(release.data);

  if (eventsPerRepo > 0) {
    const events = await client.get(`${base}/events?per_page=${eventsPerRepo}`);
    if (!Array.isArray(events.data)) throw new Error(`Invalid event list for ${repo.full_name}.`);
    const unique = new Map(events.data
      .filter(event => event.public === true)
      .map(event => [String(event.id), summarizeEvent(event, repo.html_url)]));
    activity.recent_events = [...unique.values()].slice(0, eventsPerRepo);
  }
  return activity;
}

/** Collection completes before any on-disk snapshot is changed. */
export async function collectSnapshot({ client, owner, eventsPerRepo = 10, now = () => new Date() }) {
  assertOwner(owner);
  assertEventLimit(eventsPerRepo);
  const capturedAt = now().toISOString();
  const repos = await listPublicRepositories(client, owner);
  const repositories = [];
  for (const repo of repos) {
    repositories.push({ ...repositoryMetadata(repo), activity: await collectActivity(client, repo, eventsPerRepo) });
  }
  const snapshot = {
    schema_version: 1,
    snapshot_date: capturedAt.slice(0, 10),
    captured_at: capturedAt,
    completed_at: now().toISOString(),
    owner,
    source: {
      provider: 'github',
      api_version: API_VERSION,
      repository_scope: 'public_owned',
      include_forks: true,
      include_archived: true,
      events_per_repository: eventsPerRepo,
      events_are_complete_history: false,
    },
    repository_count: repositories.length,
    repositories,
  };
  assertSnapshot(snapshot);
  return snapshot;
}

export async function runSnapshot({ client, owner, eventsPerRepo = 10, dataDir = 'data', now = () => new Date() }) {
  const snapshot = await collectSnapshot({ client, owner, eventsPerRepo, now });
  const files = await writeSnapshot(snapshot, { dataDir });
  return { snapshot, ...files };
}

async function main() {
  const owner = process.env.GITHUB_OWNER || process.env.GITHUB_REPOSITORY_OWNER || 'Luis85';
  const eventLimit = process.env.SNAPSHOT_EVENTS_PER_REPO ?? '10';
  if (!/^\d+$/.test(eventLimit)) throw new Error('SNAPSHOT_EVENTS_PER_REPO must be an integer from 0 to 100.');
  const result = await runSnapshot({
    client: createGitHubClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '' }),
    owner,
    eventsPerRepo: Number(eventLimit),
    dataDir: process.env.SNAPSHOT_DATA_DIR || 'data',
  });
  console.log(`Captured ${result.snapshot.repository_count} public repositories for ${owner}.`);
  console.log(`Latest: ${result.latestPath}`);
  console.log(`History: ${result.historyPath} (${result.historyCreated ? 'created' : 'preserved'})`);
  console.log(`Diary: ${result.diaryPath} (${result.diaryCreated ? 'created' : 'preserved'})`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`Snapshot failed: ${error.message}`);
    process.exitCode = 1;
  });
}
