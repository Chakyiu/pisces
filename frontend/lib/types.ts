export type Endpoint = {
  id: string;
  name: string;
  kind: string;
  status: "up" | "down" | string;
};

export type Page<T> = {
  items: T[];
  total: number;
  nextCursor?: string | null;
};

export type Port = {
  host: number | null;
  hostIp?: string | null;
  container: number;
  protocol: string;
};

export type EnvValue = { key: string; value: string };
export type LabelValue = { key: string; value: string };
export type MountEdit = { source: string; destination: string; mountType: string; readOnly: boolean };

export type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  statusText: string;
  ports: Port[];
  created: number;
  /** Present on the container list: the agent policy for this container. */
  aiAccess?: AiAccessLabel | null;
};

export type StackContainer = {
  id: string;
  name: string;
  service?: string | null;
  state: string;
};

export type Stack = {
  project: string;
  origin: "managed" | "discovered";
  hasFile: boolean;
  running: number;
  total: number;
  state: string;
  containers: StackContainer[];
};

export type StackDetail = Stack & {
  compose?: string | null;
  env?: EnvValue[] | null;
  containerDetails?: Container[];
};

export type Mount = { source: string; destination: string; mode: string };

export type Attachment = { name: string; ip: string };

export type ContainerDetail = {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  statusText: string;
  created: string;
  started: string | null;
  command: string;
  entrypoint: string;
  restartPolicy: string;
  restartMaximumRetryCount: number | null;
  ports: Port[];
  mounts: Mount[];
  networks: Attachment[];
  env: { key: string; value: string }[];
  labels: { key: string; value: string }[];
};

export type LogLine = { timestamp: string; stream: string; text: string };

export type Overview = {
  engine: {
    version: string;
    apiVersion: string;
    os: string;
    cpus: number;
    memoryBytes: number;
    status: string;
  };
  counts: {
    containersRunning: number;
    containersStopped: number;
    images: number;
    volumes: number;
    networks: number;
  };
  recentContainers: Container[];
};

export type ImageItem = {
  id: string;
  tags: string[];
  sizeBytes: number;
  created: number;
};

export type Volume = {
  name: string;
  driver: string;
  mountpoint: string;
  created: string;
};

export type Network = {
  name: string;
  driver: string;
  scope: string;
  subnet: string;
  containerCount: number;
  removable: boolean;
};

export type AiAccessState = "locked" | "read" | "operate";

export type AiAccess = {
  state: AiAccessState;
  forcedLocked: boolean;
  reason: string;
  mount?: string | null;
  readable: boolean;
};

export type AiAccessItem = {
  containerId: string;
  containerName: string;
  state: AiAccessState;
  forcedLocked: boolean;
  reason: string;
  mount?: string | null;
};

/** The per-row policy carried on the container list. */
export type AiAccessLabel = {
  state: AiAccessState;
  forcedLocked: boolean;
  reason: string;
  mount?: string | null;
};

export type AgentCredential = {
  id: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  ttlSecs: number;
  idleSecs: number;
  idleDeadline: number | null;
  accessTier: "read" | "operate";
  state: "active" | "expired" | "revoked" | "idle" | "none";
};

export type IssuedCredential = AgentCredential & { secret: string };

export type ProposalStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "expired"
  | "failed"
  | "applied";

export type Proposal = {
  id: string;
  action: string;
  endpointId: string;
  containerId?: string | null;
  containerName?: string | null;
  project?: string | null;
  /** The credential that asked, when the proposal record has one. */
  credentialId?: string | null;
  payload: unknown;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  decidedBy?: string | null;
  decidedAt?: number | null;
  message?: string | null;
};
