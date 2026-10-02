export interface VeylOptions { token: string; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch; }
export interface Project { id: string; name: string; symbol: string; purpose: string; template: string; swarm: boolean; status: string; model: string; policy: Record<string, number>; committed: number; createdAt: string; }
export interface CallAccounting { version: 1; callId: string; journalId: string; status: 'pending' | 'bound' | 'settled'; reservedMicroUsd: number; modelCapMicroUsd: number; valuationMicroUsd?: number; chargeWei?: string; report?: Record<string, unknown>; }
export interface JobStep { role: string; status: string; callAccounting?: CallAccounting; additionalCalls?: Array<{ callAccounting?: CallAccounting; [key: string]: unknown }>; [key: string]: unknown; }
export interface Job { id: string; projectId: string; requestKey?: string; status: string; prompt: string; reservation?: number; steps?: JobStep[]; [key: string]: unknown; }
export interface Memory { id: string; content: string; at: string; requestKey?: string; }
export interface Draft { id: string; status: string; channel: 'x' | 'telegram'; preview: { text: string; [key: string]: unknown }; [key: string]: unknown; }
export interface Model { id: string; [key: string]: unknown; }
export interface WatchlistSettings { name: string; brief: string; sources: string[]; enabled: boolean; cadenceMinutes: 60 | 360 | 1440; reviewerModel?: string | null; }
export interface ResearchWatchlist extends WatchlistSettings { id: string; requestKey: string; [key: string]: unknown; }
export interface ResearchCheck { id: string; requestKey: string; status: string; [key: string]: unknown; }
export interface ResearchSnapshot { watchlists: ResearchWatchlist[]; checks: ResearchCheck[]; limits: Record<string, number | number[]>; sourceHosts: string[]; historyOmitted: number; }
export class VeylApiError extends Error { status: number; code: string; requestId?: string; uncertain: boolean; }
export class VeylClient {
  constructor(options: VeylOptions);
  project(): Promise<{ project: Project }>;
  models(): Promise<{ models: Model[] }>;
  jobs(input?: { requestKey?: string }): Promise<{ jobs: Job[]; hasMore?: boolean }>;
  job(id: string): Promise<{ job: Job; artifact: Record<string, unknown> | null }>;
  submitJob(input: { requestKey: string; prompt: string }): Promise<{ job: Job }>;
  memory(): Promise<{ memory: Memory[] }>;
  research(): Promise<ResearchSnapshot>;
  /** Explicit enabled=true authorizes scheduled checks and budgeted changed-source reports. */
  createWatchlist(input: WatchlistSettings & { requestKey: string }): Promise<{ watchlist: ResearchWatchlist }>;
  updateWatchlist(id: string, input: Partial<WatchlistSettings>): Promise<{ watchlist: ResearchWatchlist }>;
  /** May queue paid work when fetched source content changes. Never retried automatically. */
  checkWatchlist(id: string, input: { requestKey: string }): Promise<{ check: ResearchCheck }>;
  saveMemory(input: { requestKey: string; content: string }): Promise<{ memory: Memory }>;
  drafts(): Promise<{ drafts: Draft[] }>;
  /** At most 4096 raw characters; X weighting is checked by the server. madeWithAi is local draft provenance, not an X media label. */
  prepareDraft(input: { channel: 'x' | 'telegram'; text: string; idempotencyKey: string; madeWithAi?: boolean }): Promise<{ draft: Draft }>;
}
