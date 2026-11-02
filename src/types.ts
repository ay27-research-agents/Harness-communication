export type Stage = 'analyze' | 'review' | 'report';
export type Scenario = 'inventory' | 'intel';
export type Topology = 'coordinator' | 'pubsub' | 'routed' | 'handoff';
export type WorkerId = 'analyst' | 'reviewer' | 'reporter';
export type Party = WorkerId | 'coordinator' | 'broker' | 'router' | 'controller';

export interface Artifact {
  revision?: number;
  id: string;
  kind: string;
  data: unknown;
  producer: string;
  taskId: string;
  hash: string;
  createdAt: string;
}

export interface Envelope {
  schemaVersion: 1;
  messageId: string;
  runId: string;
  taskId: string;
  type: string;
  sender: Party;
  recipient: Party;
  correlationId?: string;
  causationId?: string;
  stateVersion: number;
  ownershipEpoch: number;
  artifactRefs: string[];
  payload: Record<string, unknown>;
}

export interface ContextPackage {
  assessment?: { revision: number; previousClaims?: { id: string; status: string }[]; previousRecommendation?: string };
  scenario?: Scenario;
  taskId: string;
  objective: string;
  stateVersion: number;
  ownershipEpoch: number;
  inputs: Artifact[];
  recentMessages: Envelope[];
  outputContract: string;
  maxChars: number;
}

export interface WorkRequest {
  stage: Stage;
  context: ContextPackage;
  signal?: AbortSignal;
}
export interface WorkResult {
  data: unknown;
  summary: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
export type Worker = (request: WorkRequest) => Promise<WorkResult>;

export interface TaskRecord {
  revision?: number;
  id: string;
  owner: WorkerId;
  objective: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stateVersion: number;
  ownershipEpoch: number;
  attempt: number;
  outputs: Partial<Record<Stage, string>>;
  error?: string;
}

export interface HandoffRecord {
  id: string;
  taskId: string;
  from: WorkerId;
  to: WorkerId;
  expectedEpoch: number;
  packageRef: string;
  status: 'offered' | 'accepted' | 'committed' | 'aborted';
}

export interface JournalEvent {
  seq: number;
  id: string;
  runId: string;
  kind: string;
  at: string;
  data: unknown;
}
export interface Journal {
  append(runId: string, changes: { kind: string; data: unknown }[]): JournalEvent[];
  read(runId: string): JournalEvent[];
  runIds(): string[];
  close(): void;
}
