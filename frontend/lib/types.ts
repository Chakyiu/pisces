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
};

export type StackContainer = {
  id: string;
  name: string;
  service?: string | null;
  state: string;
};

export type Stack = {
  project: string;
  running: number;
  total: number;
  state: string;
  containers: StackContainer[];
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
