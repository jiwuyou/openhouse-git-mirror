export const DEFAULT_MAX_MIRROR_BYTES = 30 * 1024 * 1024;

export type MirrorMode = "tracking" | "pinned";
export type MirrorTargetStatus = "active" | "paused" | "ready" | "oversized" | "failed";
export type MirrorJobStatus = "pending" | "running" | "succeeded" | "failed" | "oversized";

export interface MirrorTarget {
  id: string;
  repositoryUrl: string;
  mode: MirrorMode;
  branch: string | null;
  approvedCommit: string | null;
  forgejoOwner: string;
  forgejoRepository: string;
  mirrorUrl: string;
  maxSizeBytes: number;
  intervalSeconds: number;
  status: MirrorTargetStatus;
  currentSizeBytes: number | null;
  lastSyncedCommit: string | null;
  lastError: string | null;
  nextSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MirrorJob {
  id: string;
  targetId: string;
  releaseId: string | null;
  packageId: string | null;
  requestedCommit: string | null;
  pinRef: string | null;
  status: MirrorJobStatus;
  attempts: number;
  availableAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MirrorSnapshot {
  id: string;
  targetId: string;
  releaseId: string | null;
  packageId: string | null;
  sourceCommit: string;
  mirrorRef: string | null;
  sizeBytes: number;
  verifiedAt: string;
}

export interface ClaimedMirrorJob {
  job: MirrorJob;
  target: MirrorTarget;
}

export interface ReleaseMirrorRequest {
  packageId: string;
  releaseId: string;
  repositoryUrl: string;
  approvedCommit: string;
}

export interface MirrorExecutionResult {
  sourceCommit: string;
  mirrorRef: string | null;
  sizeBytes: number;
}
