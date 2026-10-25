/** Stable public JSON contracts. TypeScript types complement runtime validation. */
export interface License {
  key: string;
  name: string;
  spdx_id: string;
  url: string | null;
}

export interface CommitSummary {
  sha: string;
  url: string | null;
  message: string;
  author: string | null;
  authored_at: string | null;
  committed_at: string | null;
}

export interface ReleaseSummary {
  id: number;
  tag_name: string;
  name: string | null;
  url: string | null;
  created_at: string | null;
  published_at: string | null;
}

export interface EventSummary {
  id: string;
  type: string;
  actor: string | null;
  created_at: string | null;
  action: string | null;
  ref: string | null;
  ref_type: string | null;
  head: string | null;
  commit_count: number | null;
  url: string | null;
  title: string | null;
}

export interface AvailableActivity {
  status: 'available';
  latest_commit: CommitSummary | null;
  latest_release: ReleaseSummary | null;
  recent_events: EventSummary[];
}

export interface UnavailableActivity {
  status: 'unavailable';
  reason: 'repository_disabled';
  latest_commit: null;
  latest_release: null;
  recent_events: [];
}

export type RepositoryActivity = AvailableActivity | UnavailableActivity;

export interface RepositorySnapshot {
  id: number;
  node_id: string | null;
  name: string;
  full_name: string;
  owner: string;
  url: string;
  about: string | null;
  website: string | null;
  topics: string[];
  language: string | null;
  default_branch: string | null;
  visibility: 'public';
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
  size_kb: number | null;
  license: License | null;
  counts: { stars: number; forks: number; open_issues_and_pull_requests: number };
  activity: RepositoryActivity;
}

export interface SnapshotSource {
  provider: 'github';
  api_version: string;
  repository_scope: 'public_owned';
  include_forks: true;
  include_archived: true;
  events_per_repository: number;
  events_are_complete_history: false;
}

export type RepositoryMetadata = Omit<RepositorySnapshot, 'activity'>;

export interface SnapshotV1 {
  schema_version: 1;
  snapshot_date: string;
  captured_at: string;
  completed_at: string;
  owner: string;
  source: SnapshotSource;
  repository_count: number;
  repositories: RepositorySnapshot[];
}

export interface InventoryMetrics {
  repository_count: number;
  original_repository_count: number;
  fork_repository_count: number;
  archived_repository_count: number;
  disabled_repository_count: number;
  repositories_with_website: number;
  repositories_with_about: number;
  total_stars: number;
  total_forks: number;
  total_open_issues_and_pull_requests: number;
  sampled_events: number;
}

export interface ComparisonMetrics {
  comparison_date: string | null;
  comparison_days: number | null;
  repositories_added: number | null;
  repositories_removed: number | null;
  repositories_renamed: number | null;
  repositories_with_metadata_changes: number | null;
  repositories_with_new_pushes: number | null;
  repositories_with_changed_default_branch_head: number | null;
  repositories_with_changed_latest_release: number | null;
  newly_observed_events: number | null;
  stars_delta: number | null;
  forks_delta: number | null;
  open_issues_and_pull_requests_delta: number | null;
}

export interface DiaryMetrics extends InventoryMetrics, ComparisonMetrics {}
export interface DiaryResult { markdown: string; metrics: DiaryMetrics }

export interface GitHubResponse { data: unknown; headers: Headers; status: number }
export interface GitHubClient {
  get(path: string, options?: { allowedStatuses?: readonly number[] }): Promise<GitHubResponse>;
  paginate(path: string): Promise<unknown[]>;
}
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SnapshotPaths { latestPath: string; historyPath: string; diaryPath: string }
export interface WriteResult extends SnapshotPaths { historyCreated: boolean; diaryCreated: boolean }
export interface CaptureResult extends WriteResult { status: 'captured' | 'repaired' | 'skipped'; snapshot: SnapshotV1 }

export interface CollectionOptions {
  client: GitHubClient;
  owner: string;
  eventsPerRepo?: number;
  now?: () => Date;
  startedAt?: Date;
}
export interface RunOptions extends CollectionOptions { dataDir?: string; ifNeeded?: boolean }
