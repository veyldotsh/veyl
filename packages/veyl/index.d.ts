export interface VeylOptions { token: string; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch; }
export interface Project { id: string; name: string; symbol: string; purpose: string; template: string; swarm: boolean; status: string; model: string; policy: Record<string, number>; committed: number; createdAt: string; }
export interface CallAccounting { version: 1; callId: string; journalId: string; status: 'pending' | 'bound' | 'settled'; reservedMicroUsd: number; modelCapMicroUsd: number; valuationMicroUsd?: number; chargeWei?: string; report?: Record<string, unknown>; }
export interface JobStep { role: string; status: string; callAccounting?: CallAccounting; additionalCalls?: Array<{ callAccounting?: CallAccounting; [key: string]: unknown }>; [key: string]: unknown; }
export interface Job { id: string; projectId: string; requestKey?: string; status: string; prompt: string; reservation?: number; steps?: JobStep[]; [key: string]: unknown; }
export interface Memory { id: string; content: string; at: string; requestKey?: string; }
export interface Draft { id: string; status: string; channel: 'x' | 'telegram'; preview: { text: string; [key: string]: unknown }; [key: string]: unknown; }
export interface Model { id: string; [key: string]: unknown; }
export class VeylApiError extends Error { status: number; code: string; requestId?: string; uncertain: boolean; }
export class VeylClient {
  constructor(options: VeylOptions);
  project(): Promise<{ project: Project }>;
  models(): Promise<{ models: Model[] }>;
  jobs(input?: { requestKey?: string }): Promise<{ jobs: Job[]; hasMore?: boolean }>;
  job(id: string): Promise<{ job: Job; artifact: Record<string, unknown> | null }>;
  submitJob(input: { requestKey: string; prompt: string }): Promise<{ job: Job }>;
  memory(): Promise<{ memory: Memory[] }>;
  saveMemory(input: { requestKey: string; content: string }): Promise<{ memory: Memory }>;
  drafts(): Promise<{ drafts: Draft[] }>;
  prepareDraft(input: { channel: 'x' | 'telegram'; text: string; idempotencyKey: string; madeWithAi?: boolean }): Promise<{ draft: Draft }>;
}
