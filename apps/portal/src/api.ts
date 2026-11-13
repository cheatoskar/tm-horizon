import type {
  ApiTokenInfo, ClaimRequest, ContentReportInput, DownloadStats, GameId, HubImage, HubInstall, HubProject, HubProjectType, HubUser, HubVersion,
  ProjectInput, ProjectRole, ReviewItem, SourcePreview, StatementOfReasons,
} from '@tm-hub/shared';

export interface HubConfig {
  providers: string[];
  devLogin: boolean;
  maxUploadMb: number;
  maxImageMb: number;
  holdMinutes: number;
  publicUrl: string;
  githubApp: string | null;
  indexKey: { keyId: string; publicKey: string };
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (f: (() => void) | null) => { onUnauthorized = f; };

async function toError(r: Response): Promise<ApiError> {
  let body: { error?: string; message?: string; details?: unknown } = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return new ApiError(r.status, body.error ?? 'error', body.message ?? `${r.status} ${r.statusText}`, body.details);
}

async function call<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(path, { method, headers, credentials: 'same-origin', body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the hub. Check your connection and try again.');
  }
  if (!r.ok) {
    const e = await toError(r);
    if (e.status === 401) onUnauthorized?.();
    throw e;
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
const get = <T>(p: string) => call<T>('GET', p);
const post = <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {});
const send = <T>(m: string, p: string, b?: unknown) => call<T>(m, p, b);
const q = encodeURIComponent;

/** Multipart POST with upload progress. */
export function upload<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', path);
    x.setRequestHeader('X-CSRF-Token', csrf);
    x.withCredentials = true;
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onerror = () => reject(new ApiError(0, 'network', 'Upload failed. Check your connection and try again.'));
    x.onload = () => {
      let body: any = null;
      try { body = x.responseText ? JSON.parse(x.responseText) : null; } catch { /* ignore */ }
      if (x.status >= 200 && x.status < 300) return resolve(body as T);
      if (x.status === 401) onUnauthorized?.();
      reject(new ApiError(x.status, body?.error ?? 'error', body?.message ?? `Upload failed (${x.status})`, body?.details));
    };
    x.send(form);
  });
}

export type MyProject = HubProject;
export type ClaimRow = { id: string; method: string; detail: string; status: string; created_at: string; slug: string; name: string };
export interface AdminUser extends HubUser { strikes: number; suspension: StatementOfReasons | null }
export interface AuditRow { id: number; at: string; actor: string; action: string; target: string; detail: unknown }
export interface RevocationRow { version_id: string; project_slug: string; version: string; sha256: string; reason: string; revoked_at: string }
export interface DiscoveredItem {
  repo: string; fullName: string; owner: string; name: string; description: string | null; url: string; homepage: string | null; language: string | null; topics: string[]; matchedTopics: string[];
  stars: number; forks: number; isFork: boolean; archived: boolean; license: string | null; pushed: string | null; score: number; games: string[]; gamesGuessed: boolean;
  hasReadme: boolean | null; state: string; note: string | null; projectSlug: string | null; firstSeen: string;
}
export interface DiscoveredList { enabled: boolean; counts: Record<string, number>; last: { at: string; seen: number; added: number; error: string | null } | null; items: DiscoveredItem[] }
export interface Notice { kind: string; text: string; url?: string; at: string }
export type StatementInput = { facts: string; ground: string; groundType: 'terms' | 'law'; automated: boolean; redress?: string };
export type VersionMeta = { version: string; channel: 'stable' | 'beta'; changelog: string; installs?: Partial<Record<GameId, HubInstall>>; signature?: { keyId: string; sig: string } | null };
export type ImportGithubBody = {
  url: string; summary?: string; description?: string; license?: string | null; links?: ProjectInput['links']; images?: string[]; banner?: string | null;
  showcase?: 'repo' | 'catalog' | null; games?: GameId[]; install?: HubInstall; assetPattern?: string | null;
};
/** POST /v1/projects/import. Everything after `type` is what the author confirmed in the import preview (each item opt-in). */
export type ImportBody = {
  url: string; product?: string | null; slug?: string; name?: string; games: GameId[]; install: HubInstall; assetPattern?: string | null;
  type: HubProjectType;
  summary?: string; description?: string; license?: string | null; links?: ProjectInput['links'];
  /** Pictures out of the preview's `images`, in gallery order. */
  images?: string[]; banner?: string | null;
  showcase?: 'repo' | 'catalog' | null;
  /** false: attach the source but skip the current releases. */
  importLatest?: boolean;
};

export interface AdminServer {
  id: string; game: string; address: string; name: string; contact: string; homepage: string | null; status: string; note: string | null;
  created_at: string; decided_at: string | null; announced_at: string | null; submitter_id: string | null; owner: boolean; verified_at: string | null;
  last_check_at: string | null; last_ok_at: string | null; offline_since: string | null;
  check_info: { name: string; players: number; maxPlayers: number; spectators: number; map: string | null; mode: string | null; password: boolean } | null;
}

export const api = {
  config: () => get<HubConfig>('/v1/config'),
  me: () => get<{ user: HubUser | null; csrf: string }>('/v1/me'),
  devLogin: (as: string) => post<{ ok: true }>('/auth/dev/login', { as }),
  logout: () => post('/auth/logout'),
  devGithubClaim: (slug: string) => post<{ next: string }>('/auth/dev/github-claim', { slug }),

  myProjects: () => get<HubProject[]>('/v1/me/projects'),
  project: (slug: string) => get<HubProject>(`/v1/projects/${q(slug)}`),
  versions: (slug: string) => get<HubVersion[]>(`/v1/projects/${q(slug)}/versions`),
  createProject: (b: ProjectInput) => post<HubProject>('/v1/projects', b),
  patchProject: (slug: string, b: Partial<Omit<ProjectInput, 'slug'>>) => send<HubProject>('PATCH', `/v1/projects/${q(slug)}`, b),
  preview: (url: string, product?: string | null) => post<SourcePreview>('/v1/sources/preview', { url, product: product ?? null }),
  /** The ticked items of the preview, applied to an existing project ("Import from GitHub"). */
  importGithub: (slug: string, b: ImportGithubBody) => post<{ applied: string[]; sourceId: string; first: unknown; pictureErrors?: string[] }>(`/v1/projects/${q(slug)}/import-github`, b),
  importProject: (b: ImportBody) => post<{ project: HubProject; first: unknown; pictureErrors?: string[] }>('/v1/projects/import', b),

  putShowcase: (slug: string, doc: unknown) => send<{ showcase: unknown }>('PUT', `/v1/projects/${q(slug)}/showcase`, doc),
  deleteShowcase: (slug: string) => send('DELETE', `/v1/projects/${q(slug)}/showcase`),
  adoptShowcase: (slug: string, from: 'repo' | 'catalog') => post<{ showcase: unknown }>(`/v1/projects/${q(slug)}/showcase/adopt`, { from }),
  uploadImage: (slug: string, form: FormData) => upload<HubImage>(`/v1/projects/${q(slug)}/images`, form),
  orderImages: (slug: string, ids: string[]) => send<HubImage[]>('PUT', `/v1/projects/${q(slug)}/images/order`, { ids }),
  deleteImage: (slug: string, id: string) => send('DELETE', `/v1/projects/${q(slug)}/images/${q(id)}`),

  uploadVersion: (slug: string, form: FormData, onProgress: (f: number) => void) => upload<HubVersion>(`/v1/projects/${q(slug)}/versions`, form, onProgress),
  cancelVersion: (id: string) => post(`/v1/versions/${q(id)}/cancel`),

  addSource: (slug: string, b: { url: string; product?: string | null }) => post(`/v1/projects/${q(slug)}/sources`, b),
  checkSource: (id: string) => post(`/v1/sources/${q(id)}/check`),
  chooseAsset: (id: string, tag: string, asset: string) => post(`/v1/sources/${q(id)}/choose`, { tag, asset }),
  removeSource: (id: string) => send('DELETE', `/v1/sources/${q(id)}`),

  setMember: (slug: string, user: string, role: ProjectRole) => post<HubProject['team']>(`/v1/projects/${q(slug)}/team`, { user, role }),
  removeMember: (slug: string, userId: string) => send('DELETE', `/v1/projects/${q(slug)}/team/${q(userId)}`),
  stats: (slug: string, days: number) => get<DownloadStats>(`/v1/projects/${q(slug)}/stats?days=${days}`),

  tokens: () => get<ApiTokenInfo[]>('/v1/me/tokens'),
  createToken: (b: { name: string; scopes: string[]; projects: string[] | null; expiresDays: number | null }) => post<ApiTokenInfo>('/v1/me/tokens', b),
  revokeToken: (id: string) => send('DELETE', `/v1/me/tokens/${q(id)}`),
  addKey: (publicKey: string) => post<{ keyId: string }>('/v1/me/keys', { publicKey }),
  removeKey: (keyId: string) => send('DELETE', `/v1/me/keys/${q(keyId)}`),

  requestClaim: (slug: string, method: 'tmloader-token' | 'manual', message?: string) => post<ClaimRequest>(`/v1/projects/${q(slug)}/claim`, { method, message: message ?? null }),
  verifyClaim: (id: string) => post<{ ok: boolean }>(`/v1/claims/${q(id)}/verify`),
  myClaims: () => get<ClaimRow[]>('/v1/me/claims'),

  report: (b: ContentReportInput & { website?: string }) => post<{ id: string }>('/v1/reports', b),

  queue: () => get<ReviewItem[]>('/v1/admin/queue'),
  approve: (id: string) => post(`/v1/admin/versions/${q(id)}/approve`),
  rejectVersion: (id: string, s: StatementInput) => post(`/v1/admin/versions/${q(id)}/reject`, s),
  revokeVersion: (id: string, s: StatementInput) => post(`/v1/admin/versions/${q(id)}/revoke`, s),
  removeProject: (slug: string, s: StatementInput & { revokeAll: boolean }) => post(`/v1/admin/projects/${q(slug)}/remove`, s),
  restoreProject: (slug: string) => post(`/v1/admin/projects/${q(slug)}/restore`),
  decideClaim: (id: string, approve: boolean, note?: string) => post(`/v1/admin/claims/${q(id)}/decide`, { approve, note }),
  resolveReport: (id: string, status: 'actioned' | 'dismissed', resolution: string) => post(`/v1/admin/reports/${q(id)}/resolve`, { status, resolution }),
  users: (s: string) => get<AdminUser[]>(`/v1/admin/users?q=${q(s)}`),
  suspend: (id: string, s: StatementInput) => post(`/v1/admin/users/${q(id)}/suspend`, s),
  unsuspend: (id: string) => post(`/v1/admin/users/${q(id)}/unsuspend`),
  audit: () => get<AuditRow[]>('/v1/admin/audit?limit=200'),
  revocations: () => get<RevocationRow[]>('/v1/admin/revocations'),
  notices: () => get<Notice[]>('/v1/admin/notices'),

  servers: (status: string) => get<AdminServer[]>(`/v1/admin/servers?status=${q(status)}`),
  approveServer: (id: string, owner: boolean) => post<{ token: string }>(`/v1/admin/servers/${q(id)}/approve`, { owner }),
  rejectServer: (id: string, note: string) => post(`/v1/admin/servers/${q(id)}/reject`, { note }),
  removeServer: (id: string, note: string) => post(`/v1/admin/servers/${q(id)}/remove`, { note }),
  restoreServer: (id: string) => post<{ status: string }>(`/v1/admin/servers/${q(id)}/restore`),
  recheckServer: (id: string) => post<{ result: 'online' | 'offline' | 'skipped' }>(`/v1/admin/servers/${q(id)}/recheck`),
  recheckAllServers: () => post<{ started: boolean }>('/v1/admin/servers/recheck-all'),
  discovered: (state: string) => get<DiscoveredList>(`/v1/admin/discovered?state=${q(state)}`),
  acceptDiscovered: (repo: string) => post<{ slug: string }>(`/v1/admin/discovered/${repo.split('/').map(q).join('/')}/accept`),
  decideDiscovered: (repo: string, what: 'hide' | 'ignore' | 'restore') => post(`/v1/admin/discovered/${repo.split('/').map(q).join('/')}/${what}`),
  acceptWithTopics: () => post<{ accepted: string[]; failed: { repo: string; error: string }[] }>('/v1/admin/discovered/accept-with-topics'),
  runDiscovery: () => post<{ added: number; requests: number; error: string | null }>('/v1/admin/discovered/run'),
};
