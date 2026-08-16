import { randomUUID } from "node:crypto";
import type { MirrorConfig } from "./config.js";
import { MirrorDatabase } from "./database.js";
import { MirrorError } from "./errors.js";
import {
  forgejoRepositoryName,
  parseGitHubRepository,
  releasePinRef,
  requireBranch,
  requireCommit,
} from "./repository.js";
import type { ClaimedMirrorJob, MirrorMode, ReleaseMirrorRequest } from "./types.js";

const now = () => new Date().toISOString();

export interface CreateMirrorTargetRequest {
  repositoryUrl: string;
  mode?: MirrorMode;
  branch?: string;
  approvedCommit?: string;
  maxSizeBytes?: number;
  intervalSeconds?: number;
}

export class MirrorService {
  constructor(
    readonly database: MirrorDatabase,
    private readonly config: MirrorConfig,
  ) {}

  registerTarget(input: CreateMirrorTargetRequest) {
    const identity = parseGitHubRepository(input.repositoryUrl);
    const mode = input.mode ?? "tracking";
    if (mode !== "tracking" && mode !== "pinned") throw new MirrorError("invalid_mode", "mode must be tracking or pinned");
    const branch = mode === "tracking" ? requireBranch(input.branch ?? "main") : null;
    const approvedCommit = input.approvedCommit ? requireCommit(input.approvedCommit) : null;
    if (mode === "pinned" && !approvedCommit) throw new MirrorError("commit_required", "Pinned mirrors require approvedCommit");
    const maxSizeBytes = positiveInteger(input.maxSizeBytes ?? this.config.defaultMaxBytes, "maxSizeBytes", 1024);
    const intervalSeconds = positiveInteger(input.intervalSeconds ?? this.config.defaultIntervalSeconds, "intervalSeconds", 60);
    const timestamp = now();
    const forgejoRepository = forgejoRepositoryName(identity);
    const target = this.database.ensureTarget({
      repositoryUrl: identity.repositoryUrl,
      mode,
      branch,
      approvedCommit,
      forgejoOwner: this.config.forgejoOwner,
      forgejoRepository,
      mirrorUrl: `${this.config.forgejoPublicUrl}/${encodeURIComponent(this.config.forgejoOwner)}/${encodeURIComponent(forgejoRepository)}.git`,
      maxSizeBytes,
      intervalSeconds,
      nextSyncAt: mode === "tracking" ? addSeconds(timestamp, intervalSeconds) : null,
    }, timestamp);
    const job = this.database.enqueueJob({
      targetId: target.id,
      releaseId: null,
      packageId: null,
      requestedCommit: approvedCommit,
      pinRef: mode === "pinned" ? releasePinRef(`target-${target.id}`) : null,
      idempotencyKey: `target:${target.id}:initial`,
      availableAt: timestamp,
    }, timestamp);
    return { target, job };
  }

  registerRelease(input: ReleaseMirrorRequest) {
    const packageId = requiredIdentifier(input.packageId, "packageId");
    const releaseId = requiredIdentifier(input.releaseId, "releaseId");
    const approvedCommit = requireCommit(input.approvedCommit);
    const identity = parseGitHubRepository(input.repositoryUrl);
    const timestamp = now();
    let target = this.database.getTargetByRepository(identity.repositoryUrl);
    if (!target) {
      const registered = this.registerTarget({ repositoryUrl: identity.repositoryUrl, mode: "tracking", branch: "main" });
      target = registered.target;
    }
    const job = this.database.enqueueJob({
      targetId: target.id,
      releaseId,
      packageId,
      requestedCommit: approvedCommit,
      pinRef: releasePinRef(releaseId),
      idempotencyKey: `release:${releaseId}:${approvedCommit}`,
      availableAt: timestamp,
    }, timestamp);
    return { target, job };
  }

  runNow(targetId: string) {
    const target = this.requireTarget(targetId);
    if (target.status === "paused") throw new MirrorError("target_paused", "Resume the mirror before running it");
    const timestamp = now();
    return this.database.enqueueJob({
      targetId,
      releaseId: null,
      packageId: null,
      requestedCommit: target.mode === "pinned" ? target.approvedCommit : null,
      pinRef: null,
      idempotencyKey: `manual:${targetId}:${randomUUID()}`,
      availableAt: timestamp,
    }, timestamp);
  }

  pause(targetId: string) {
    const target = this.requireTarget(targetId);
    return this.database.updateTarget(target.id, { status: "paused", updatedAt: now() })!;
  }

  resume(targetId: string) {
    const target = this.requireTarget(targetId);
    const timestamp = now();
    return this.database.updateTarget(target.id, {
      status: target.lastSyncedCommit ? "ready" : "active",
      nextSyncAt: target.mode === "tracking" ? timestamp : null,
      lastError: null,
      updatedAt: timestamp,
    })!;
  }

  queueDueTargets(timestamp = now()): number {
    let count = 0;
    for (const target of this.database.listDueTrackingTargets(timestamp)) {
      const occurrence = target.nextSyncAt ?? timestamp;
      this.database.updateTarget(target.id, {
        nextSyncAt: addSeconds(timestamp, target.intervalSeconds),
        updatedAt: timestamp,
      });
      this.database.enqueueJob({
        targetId: target.id,
        releaseId: null,
        packageId: null,
        requestedCommit: null,
        pinRef: null,
        idempotencyKey: `tracking:${target.id}:${occurrence}`,
        availableAt: timestamp,
      }, timestamp);
      count += 1;
    }
    return count;
  }

  claimJob(timestamp = now()): ClaimedMirrorJob | null {
    return this.database.claimNextJob(timestamp, addSeconds(timestamp, this.config.leaseSeconds));
  }

  listTargets() {
    return this.database.listTargets();
  }

  listJobs() {
    return this.database.listJobs();
  }

  getTarget(targetId: string) {
    return this.requireTarget(targetId);
  }

  findSource(repositoryUrl: string, approvedCommit: string) {
    const identity = parseGitHubRepository(repositoryUrl);
    const commit = requireCommit(approvedCommit);
    return this.database.findReadyMirror(identity.repositoryUrl, commit);
  }

  get executionConfig() {
    return {
      workRoot: this.config.workRoot,
      githubToken: this.config.githubToken,
      forgejoBaseUrl: this.config.forgejoBaseUrl,
      forgejoToken: this.config.forgejoToken,
      forgejoOwnerKind: this.config.forgejoOwnerKind,
      forgejoUsername: this.config.forgejoUsername,
      maxAttempts: this.config.maxAttempts,
    };
  }

  private requireTarget(targetId: string) {
    const target = this.database.getTarget(targetId);
    if (!target) throw new MirrorError("target_not_found", "Mirror target does not exist");
    return target;
  }
}

function positiveInteger(value: number, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new MirrorError("invalid_request", `${field} must be an integer of at least ${minimum}`);
  return value;
}

function requiredIdentifier(value: string, field: string): string {
  const result = value?.trim();
  if (!result || result.length > 240) throw new MirrorError("invalid_request", `${field} is required`);
  return result;
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
}
