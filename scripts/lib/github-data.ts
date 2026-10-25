import type { CommitSummary, EventSummary, License, ReleaseSummary, RepositoryMetadata } from './types.ts';
import { diagnosticLabel } from './errors.ts';

function invalid(field: string): never {
  throw new Error(`GitHub returned an invalid ${field}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Identify a failing repository without including raw response data in logs. */
export function repositoryLabel(value: unknown): string {
  const item = isRecord(value) ? value : {};
  const name = typeof item.full_name === 'string' && item.full_name ? diagnosticLabel(item.full_name) : '(name unavailable)';
  const id = typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0 ? ` (ID ${item.id})` : '';
  return `repository ${name}${id}`;
}

export function githubObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(field);
  return value;
}

export function githubArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | null {
  return value === null || value === undefined ? null : githubObject(value, field);
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : string(value, field);
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(field);
  return value;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : integer(value, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function license(value: unknown): License | null {
  const item = optionalObject(value, 'license');
  return item ? {
    key: string(item.key, 'license.key'), name: string(item.name, 'license.name'),
    spdx_id: string(item.spdx_id, 'license.spdx_id'), url: nullableString(item.url, 'license.url'),
  } : null;
}

/** Read only verified public owned records; raw network JSON never receives a blind type cast. */
export function normalizeRepository(value: unknown, owner: string): RepositoryMetadata | null {
  const repo = githubObject(value, 'repository');
  const isPrivate = boolean(repo.private, 'repository visibility');
  const login = string(githubObject(repo.owner, 'repository owner').login, 'repository owner login');
  const visibility = nullableString(repo.visibility, 'repository visibility');
  if (isPrivate || (visibility !== null && visibility !== 'public') || login.toLowerCase() !== owner.toLowerCase()) return null;
  const topics = repo.topics === undefined ? [] : githubArray(repo.topics, 'topics list');
  const homepage = nullableString(repo.homepage, 'website');
  return {
    id: integer(repo.id, 'repository identity', 1),
    node_id: nullableString(repo.node_id, 'node_id'),
    name: string(repo.name, 'repository name'),
    full_name: string(repo.full_name, 'repository full_name'),
    owner: login,
    url: string(repo.html_url, 'repository URL'),
    about: nullableString(repo.description, 'About description'),
    website: homepage === '' ? null : homepage,
    topics: [...new Set(topics.map(topic => string(topic, 'topic')))].sort(),
    language: nullableString(repo.language, 'language'),
    default_branch: nullableString(repo.default_branch, 'default_branch'),
    visibility: 'public',
    fork: boolean(repo.fork, 'fork flag'),
    archived: boolean(repo.archived, 'archived flag'),
    disabled: boolean(repo.disabled, 'disabled flag'),
    created_at: nullableString(repo.created_at, 'created_at'),
    updated_at: nullableString(repo.updated_at, 'updated_at'),
    pushed_at: nullableString(repo.pushed_at, 'pushed_at'),
    size_kb: nullableInteger(repo.size, 'size'),
    license: license(repo.license),
    counts: {
      stars: integer(repo.stargazers_count, 'counts.stars'),
      forks: integer(repo.forks_count, 'counts.forks'),
      // GitHub reports open issues and pull requests in this one counter.
      open_issues_and_pull_requests: integer(repo.open_issues_count, 'counts.open_issues_and_pull_requests'),
    },
  };
}

export function summarizeCommit(value: unknown): CommitSummary | null {
  if (value === undefined) return null;
  const item = githubObject(value, 'commit');
  const commit = githubObject(item.commit, 'commit metadata');
  const author = optionalObject(item.author, 'commit GitHub author');
  const commitAuthor = optionalObject(commit.author, 'commit author');
  const committer = optionalObject(commit.committer, 'committer');
  return {
    sha: string(item.sha, 'commit SHA'), url: nullableString(item.html_url, 'commit URL'),
    message: string(commit.message, 'commit message'),
    author: nullableString(author?.login ?? commitAuthor?.name, 'commit author name'),
    authored_at: nullableString(commitAuthor?.date, 'authored_at'),
    committed_at: nullableString(committer?.date, 'committed_at'),
  };
}

export function summarizeRelease(value: unknown): ReleaseSummary {
  const item = githubObject(value, 'release');
  return {
    id: integer(item.id, 'release ID', 1), tag_name: string(item.tag_name, 'release tag'),
    name: nullableString(item.name, 'release name'), url: nullableString(item.html_url, 'release URL'),
    created_at: nullableString(item.created_at, 'release created_at'),
    published_at: nullableString(item.published_at, 'release published_at'),
  };
}

export function summarizeEvent(value: unknown, repositoryUrl: string): EventSummary | null {
  const item = githubObject(value, 'event');
  if (item.public !== true) return null;
  const payload = optionalObject(item.payload, 'event payload') ?? {};
  const actor = optionalObject(item.actor, 'event actor');
  const subject = optionalObject(payload.pull_request ?? payload.issue ?? payload.discussion ?? payload.release ?? payload.forkee, 'event subject');
  const comment = optionalObject(payload.comment, 'event comment');
  const review = optionalObject(payload.review, 'event review');
  const id = typeof item.id === 'number' ? String(integer(item.id, 'event ID', 1)) : string(item.id, 'event ID');
  return {
    id, type: string(item.type, 'event type'), actor: nullableString(actor?.login, 'event actor login'),
    created_at: nullableString(item.created_at, 'event created_at'),
    action: nullableString(payload.action, 'event action'), ref: nullableString(payload.ref, 'event ref'),
    ref_type: nullableString(payload.ref_type, 'event ref_type'), head: nullableString(payload.head, 'event head'),
    commit_count: nullableInteger(payload.size, 'event commit_count'),
    url: nullableString(comment?.html_url ?? review?.html_url ?? subject?.html_url ?? repositoryUrl, 'event URL'),
    title: nullableString(subject?.title ?? subject?.name, 'event title'),
  };
}
