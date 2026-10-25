import { setTimeout as delay } from 'node:timers/promises';
import type { FetchLike, GitHubClient, GitHubResponse } from './types.ts';

export interface GitHubClientOptions {
  token?: string;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
  timeoutMs?: number;
}

export const API_VERSION = '2026-03-10';
const API_ORIGIN = 'https://api.github.com';
const MAX_RETRY_WAIT_MS = 60_000;

function apiUrl(path: string): URL {
  const url = new URL(path, API_ORIGIN);
  // Pagination URLs are server input. Never forward the token to another host.
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) {
    throw new Error('Refusing a GitHub API URL outside https://api.github.com.');
  }
  return url;
}

function nextPage(linkHeader: string | null | undefined): string | null {
  if (linkHeader === null || linkHeader === undefined || linkHeader.trim() === '') return null;
  const parts: string[] = [];
  let start = 0;
  let inUrl = false;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < linkHeader.length; index += 1) {
    const character = linkHeader[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (!inUrl && character === '"') quoted = !quoted;
    if (!quoted && character === '<') inUrl = true;
    if (!quoted && character === '>') inUrl = false;
    if (!quoted && !inUrl && character === ',') {
      parts.push(linkHeader.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || inUrl || escaped) throw new Error('Malformed GitHub pagination Link header.');
  parts.push(linkHeader.slice(start));

  let next: string | null = null;
  for (const part of parts) {
    const match = part.match(/^\s*<([^<>]+)>(.*)$/s);
    if (!match || match[1] === undefined || match[2] === undefined) throw new Error('Malformed GitHub pagination Link header.');
    const parameters = match[2].trimEnd();
    const pattern = /;\s*([a-z][a-z\d_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))\s*/giy;
    let offset = 0;
    let relation: string | undefined;
    while (offset < parameters.length) {
      while (/\s/.test(parameters[offset] ?? '') && offset < parameters.length) offset += 1;
      pattern.lastIndex = offset;
      const parameter = pattern.exec(parameters);
      if (!parameter || parameter[1] === undefined) throw new Error('Malformed GitHub pagination Link parameters.');
      offset = pattern.lastIndex;
      if (parameter[1].toLowerCase() === 'rel') {
        if (relation !== undefined) throw new Error('Duplicate GitHub pagination relation.');
        const value = parameter[2] ?? parameter[3];
        if (value === undefined) throw new Error('Missing GitHub pagination relation.');
        relation = value.replace(/\\(.)/g, '$1');
      }
    }
    if (!relation) throw new Error('GitHub pagination link is missing its relation.');
    if (relation.split(/\s+/).includes('next')) {
      if (next !== null) throw new Error('GitHub returned ambiguous next-page links.');
      next = apiUrl(match[1]).href;
    }
  }
  return next;
}

function retryWait(response: Response, attempt: number, now: () => number, isRateLimit: boolean): number {
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
} : GitHubClientOptions = {}): GitHubClient {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error('maxAttempts must be an integer from 1 to 5.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer.');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'project-diary-snapshot',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function get(path: string, { allowedStatuses = [] }: { allowedStatuses?: readonly number[] } = {}): Promise<GitHubResponse> {
    const url = apiUrl(path);
    const label = `${url.pathname}${url.search}`;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: Response;
      let body: string;
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

      let data: unknown;
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
        /rate limit|secondary rate|abuse/i.test(typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string' ? data.message : '')
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

  async function paginate(path: string): Promise<unknown[]> {
    const result: unknown[] = [];
    const visited = new Set<string>();
    let next: string | null = path;
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

