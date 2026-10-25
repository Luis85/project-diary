import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const API_VERSION = '2026-03-10';
const API_ORIGIN = 'https://api.github.com';
const MAX_RETRY_WAIT_MS = 60_000;

function assertOwner(owner) {
  if (typeof owner !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) {
    throw new Error('GITHUB_OWNER must be a GitHub username (1–39 letters, digits, or hyphens).');
  }
}

function assertEventLimit(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('SNAPSHOT_EVENTS_PER_REPO must be an integer from 0 to 100.');
  }
}

function apiUrl(path) {
  const url = new URL(path, API_ORIGIN);
  // Pagination URLs are server input. Never forward the token to another host.
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) {
    throw new Error('Refusing a GitHub API URL outside https://api.github.com.');
  }
  return url;
}

function nextPage(linkHeader) {
  for (const part of (linkHeader ?? '').split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match?.[2].split(/\s+/).includes('next')) return match[1];
  }
  return null;
}

function retryWait(response, attempt, now, isRateLimit) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
    if (Number.isFinite(wait)) return Math.max(0, wait);
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - now() + 1000);
  }
  return isRateLimit ? 60_000 : 1000 * 2 ** attempt;
}

/** Serial, authenticated public API reads with bounded retries and timeouts. */
export function createGitHubClient({
  token = '',
  fetchImpl = globalThis.fetch,
  sleep = delay,
  now = Date.now,
  maxAttempts = 3,
  timeoutMs = 30_000,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error('maxAttempts must be an integer from 1 to 5.');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'project-diary-snapshot',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function get(path, { allowedStatuses = [] } = {}) {
    const url = apiUrl(path);
    const label = `${url.pathname}${url.search}`;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      let body;
      try {
        response = await fetchImpl(url.href, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        body = await response.text();
      } catch {
        if (attempt + 1 === maxAttempts) {
          throw new Error(`GitHub request failed or timed out: ${label} (${maxAttempts} attempts).`);
        }
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      let data;
      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        // Transient gateway responses are sometimes HTML; retry their status below.
        data = null;
      }
      if (response.ok || allowedStatuses.includes(response.status)) {
        if (data === null) throw new Error(`GitHub returned an invalid JSON response: ${label}.`);
        return { data, headers: response.headers, status: response.status };
      }

      const isRateLimit = response.status === 429 || (response.status === 403 && (
        response.headers.has('retry-after') ||
        response.headers.get('x-ratelimit-remaining') === '0' ||
        /rate limit|secondary rate|abuse/i.test(data?.message ?? '')
      ));
      const retryable = isRateLimit || response.status >= 500;
      const error = new Error(`GitHub HTTP ${response.status}: ${label}${isRateLimit ? ' (rate limit)' : ''}.`);
      if (!retryable || attempt + 1 === maxAttempts) throw error;
      const wait = retryWait(response, attempt, now, isRateLimit);
      if (wait > MAX_RETRY_WAIT_MS) {
        throw new Error(`${error.message} Required retry wait exceeds 60 seconds; try again later.`);
      }
      await sleep(wait);
    }
    throw new Error('GitHub request exhausted its retry budget.');
  }

  async function paginate(path) {
    const result = [];
    const visited = new Set();
    let next = path;
    while (next) {
      const url = apiUrl(next).href;
      if (visited.has(url)) throw new Error('GitHub returned a repeated pagination URL.');
      visited.add(url);
      const response = await get(url);
      if (!Array.isArray(response.data)) throw new Error('Expected a paginated GitHub JSON array.');
      result.push(...response.data);
      next = nextPage(response.headers.get('link'));
    }
    return result;
  }

  return { get, paginate };
}

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
    website: repo.homepage || null,
    topics: [...(repo.topics ?? [])].sort(),
    language: repo.language ?? null,
    default_branch: repo.default_branch ?? null,
    visibility: 'public',
    fork: Boolean(repo.fork),
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
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
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
      // GitHub's open_issues_count includes pull requests. Preserve that distinction.
      open_issues_and_pull_requests: repo.open_issues_count ?? 0,
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
    activity.recent_events = events.data
      .filter(event => event.public === true)
      .slice(0, eventsPerRepo)
      .map(event => summarizeEvent(event, repo.html_url));
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
  return {
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
}

async function readIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertSnapshot(snapshot) {
  if (snapshot?.schema_version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.snapshot_date) ||
      typeof snapshot.captured_at !== 'string' || !Number.isFinite(Date.parse(snapshot.captured_at)) ||
      snapshot.captured_at.slice(0, 10) !== snapshot.snapshot_date ||
      !Array.isArray(snapshot.repositories) || snapshot.repository_count !== snapshot.repositories.length) {
    throw new Error('Refusing to write an invalid snapshot.');
  }
  assertOwner(snapshot.owner);
}

async function atomicWrite(path, content, { exclusive = false } = {}) {
  const temporary = join(dirname(path), `.snapshot-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    if (exclusive) {
      try {
        // Hard-linking the completed file provides atomic creation without overwriting an archive.
        await link(temporary, path);
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    } else {
      await rename(temporary, path);
    }
    return true;
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Keep the first successful UTC-day archive; refresh the convenient latest file. */
export async function writeSnapshot(snapshot, { dataDir = 'data' } = {}) {
  assertSnapshot(snapshot);
  const latestPath = resolve(dataDir, 'snapshot.json');
  const historyPath = resolve(dataDir, 'snapshots', `${snapshot.snapshot_date}.json`);
  const previous = await readIfExists(latestPath);
  if (previous !== undefined) {
    assertSnapshot(previous);
    if (previous.owner.toLowerCase() !== snapshot.owner.toLowerCase()) {
      throw new Error('The data directory already tracks a different owner; use a separate directory.');
    }
    if (Date.parse(previous.captured_at) > Date.parse(snapshot.captured_at)) {
      throw new Error('Refusing to replace a newer snapshot with an older capture.');
    }
  }
  const archive = await readIfExists(historyPath);
  if (archive !== undefined) {
    assertSnapshot(archive);
    if (archive.snapshot_date !== snapshot.snapshot_date || archive.owner.toLowerCase() !== snapshot.owner.toLowerCase()) {
      throw new Error('The existing daily archive does not match this capture date and owner.');
    }
  }
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  await mkdir(dirname(historyPath), { recursive: true });
  const historyCreated = archive !== undefined ? false : await atomicWrite(historyPath, content, { exclusive: true });
  await atomicWrite(latestPath, content);
  return { latestPath, historyPath, historyCreated };
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
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`Snapshot failed: ${error.message}`);
    process.exitCode = 1;
  });
}
