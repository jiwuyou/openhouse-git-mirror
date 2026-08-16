import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ClaimedMirrorJob,
  MirrorExecutionResult,
  MirrorJob,
  MirrorJobStatus,
  MirrorMode,
  MirrorSnapshot,
  MirrorTarget,
  MirrorTargetStatus,
} from "./types.js";

type SqlValue = string | number | bigint | null | Uint8Array;

interface TargetRow {
  target_id: string;
  repository_url: string;
  mode: string;
  branch: string | null;
  approved_commit: string | null;
  forgejo_owner: string;
  forgejo_repository: string;
  mirror_url: string;
  max_size_bytes: number;
  interval_seconds: number;
  status: string;
  current_size_bytes: number | null;
  last_synced_commit: string | null;
  last_error: string | null;
  next_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  job_id: string;
  target_id: string;
  release_id: string | null;
  package_id: string | null;
  requested_commit: string | null;
  pin_ref: string | null;
  status: string;
  attempts: number;
  available_at: string;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SnapshotRow {
  snapshot_id: string;
  target_id: string;
  release_id: string | null;
  package_id: string | null;
  source_commit: string;
  mirror_ref: string | null;
  size_bytes: number;
  verified_at: string;
}

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export interface CreateTargetInput {
  repositoryUrl: string;
  mode: MirrorMode;
  branch: string | null;
  approvedCommit: string | null;
  forgejoOwner: string;
  forgejoRepository: string;
  mirrorUrl: string;
  maxSizeBytes: number;
  intervalSeconds: number;
  nextSyncAt: string | null;
}

export interface EnqueueJobInput {
  targetId: string;
  releaseId: string | null;
  packageId: string | null;
  requestedCommit: string | null;
  pinRef: string | null;
  idempotencyKey: string;
  availableAt: string;
}

export class MirrorDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mirror_targets (
        target_id TEXT PRIMARY KEY,
        repository_url TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK(mode IN ('tracking', 'pinned')),
        branch TEXT,
        approved_commit TEXT,
        forgejo_owner TEXT NOT NULL,
        forgejo_repository TEXT NOT NULL,
        mirror_url TEXT NOT NULL UNIQUE,
        max_size_bytes INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ready', 'oversized', 'failed')),
        current_size_bytes INTEGER,
        last_synced_commit TEXT,
        last_error TEXT,
        next_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(forgejo_owner, forgejo_repository)
      );

      CREATE TABLE IF NOT EXISTS mirror_jobs (
        job_id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES mirror_targets(target_id) ON DELETE CASCADE,
        release_id TEXT,
        package_id TEXT,
        requested_commit TEXT,
        pin_ref TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'oversized')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mirror_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES mirror_targets(target_id) ON DELETE CASCADE,
        release_id TEXT,
        package_id TEXT,
        source_commit TEXT NOT NULL,
        mirror_ref TEXT,
        size_bytes INTEGER NOT NULL,
        verified_at TEXT NOT NULL,
        UNIQUE(target_id, release_id, source_commit)
      );

      CREATE TABLE IF NOT EXISTS mirror_events (
        event_id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES mirror_targets(target_id) ON DELETE CASCADE,
        job_id TEXT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mirror_targets_due ON mirror_targets(status, next_sync_at);
      CREATE INDEX IF NOT EXISTS idx_mirror_jobs_claim ON mirror_jobs(status, available_at, lease_until);
      CREATE INDEX IF NOT EXISTS idx_mirror_snapshots_lookup ON mirror_snapshots(target_id, source_commit);
      CREATE INDEX IF NOT EXISTS idx_mirror_events_target ON mirror_events(target_id, created_at DESC);
    `);
  }

  ensureTarget(input: CreateTargetInput, timestamp: string): MirrorTarget {
    const existing = this.getTargetByRepository(input.repositoryUrl);
    if (existing) return existing;
    const targetId = id("mirror");
    this.sqlite.prepare(`
      INSERT INTO mirror_targets(
        target_id, repository_url, mode, branch, approved_commit, forgejo_owner,
        forgejo_repository, mirror_url, max_size_bytes, interval_seconds, status,
        current_size_bytes, last_synced_commit, last_error, next_sync_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?, ?)
    `).run(
      targetId, input.repositoryUrl, input.mode, input.branch, input.approvedCommit,
      input.forgejoOwner, input.forgejoRepository, input.mirrorUrl, input.maxSizeBytes,
      input.intervalSeconds, input.nextSyncAt, timestamp, timestamp,
    );
    return this.getTarget(targetId)!;
  }

  getTarget(targetId: string): MirrorTarget | null {
    const row = this.sqlite.prepare("SELECT * FROM mirror_targets WHERE target_id = ?")
      .get(targetId) as TargetRow | undefined;
    return row ? this.mapTarget(row) : null;
  }

  getTargetByRepository(repositoryUrl: string): MirrorTarget | null {
    const row = this.sqlite.prepare("SELECT * FROM mirror_targets WHERE repository_url = ?")
      .get(repositoryUrl) as TargetRow | undefined;
    return row ? this.mapTarget(row) : null;
  }

  listTargets(): MirrorTarget[] {
    return (this.sqlite.prepare("SELECT * FROM mirror_targets ORDER BY created_at ASC, target_id ASC")
      .all() as unknown as TargetRow[]).map((row) => this.mapTarget(row));
  }

  updateTarget(targetId: string, changes: Partial<Pick<
    MirrorTarget,
    "mode" | "branch" | "approvedCommit" | "maxSizeBytes" | "intervalSeconds" | "status" | "nextSyncAt" | "lastError" | "updatedAt"
  >>): MirrorTarget | null {
    const mapping: Record<string, string> = {
      mode: "mode", branch: "branch", approvedCommit: "approved_commit", maxSizeBytes: "max_size_bytes",
      intervalSeconds: "interval_seconds", status: "status", nextSyncAt: "next_sync_at",
      lastError: "last_error", updatedAt: "updated_at",
    };
    const values: SqlValue[] = [];
    const assignments = Object.entries(changes).map(([key, value]) => {
      values.push(value as SqlValue);
      return `${mapping[key]} = ?`;
    });
    if (assignments.length === 0) return this.getTarget(targetId);
    values.push(targetId);
    this.sqlite.prepare(`UPDATE mirror_targets SET ${assignments.join(", ")} WHERE target_id = ?`).run(...values);
    return this.getTarget(targetId);
  }

  listDueTrackingTargets(timestamp: string): MirrorTarget[] {
    return (this.sqlite.prepare(`
      SELECT * FROM mirror_targets
      WHERE mode = 'tracking' AND status <> 'paused' AND next_sync_at IS NOT NULL AND next_sync_at <= ?
      ORDER BY next_sync_at ASC, target_id ASC
    `).all(timestamp) as unknown as TargetRow[]).map((row) => this.mapTarget(row));
  }

  enqueueJob(input: EnqueueJobInput, timestamp: string): MirrorJob {
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO mirror_jobs(
        job_id, target_id, release_id, package_id, requested_commit, pin_ref,
        idempotency_key, status, attempts, available_at, lease_until, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
    `).run(
      id("job"), input.targetId, input.releaseId, input.packageId, input.requestedCommit,
      input.pinRef, input.idempotencyKey, input.availableAt, timestamp, timestamp,
    );
    const row = this.sqlite.prepare("SELECT * FROM mirror_jobs WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as unknown as JobRow;
    return this.mapJob(row);
  }

  getJob(jobId: string): MirrorJob | null {
    const row = this.sqlite.prepare("SELECT * FROM mirror_jobs WHERE job_id = ?")
      .get(jobId) as JobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  listJobs(limit = 100): MirrorJob[] {
    return (this.sqlite.prepare("SELECT * FROM mirror_jobs ORDER BY created_at DESC, job_id DESC LIMIT ?")
      .all(limit) as unknown as JobRow[]).map((row) => this.mapJob(row));
  }

  claimNextJob(timestamp: string, leaseUntil: string): ClaimedMirrorJob | null {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const row = this.sqlite.prepare(`
        SELECT j.* FROM mirror_jobs j
        JOIN mirror_targets t ON t.target_id = j.target_id
        WHERE t.status <> 'paused' AND (
          (j.status = 'pending' AND j.available_at <= ?) OR
          (j.status = 'running' AND j.lease_until IS NOT NULL AND j.lease_until <= ?)
        )
        ORDER BY j.available_at ASC, j.created_at ASC LIMIT 1
      `).get(timestamp, timestamp) as JobRow | undefined;
      if (!row) {
        this.sqlite.exec("COMMIT");
        return null;
      }
      this.sqlite.prepare(`
        UPDATE mirror_jobs SET status = 'running', attempts = attempts + 1,
          lease_until = ?, last_error = NULL, updated_at = ? WHERE job_id = ?
      `).run(leaseUntil, timestamp, row.job_id);
      this.sqlite.exec("COMMIT");
      const job = this.getJob(row.job_id)!;
      return { job, target: this.getTarget(job.targetId)! };
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  completeJob(jobId: string, result: MirrorExecutionResult, timestamp: string): MirrorSnapshot {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const job = this.requireRunningJob(jobId);
      this.sqlite.prepare(`
        UPDATE mirror_jobs SET status = 'succeeded', lease_until = NULL, last_error = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(timestamp, jobId);
      this.sqlite.prepare(`
        UPDATE mirror_targets SET status = 'ready', current_size_bytes = ?, last_synced_commit = ?,
          last_error = NULL, updated_at = ? WHERE target_id = ?
      `).run(result.sizeBytes, result.sourceCommit, timestamp, job.targetId);
      const snapshotId = id("snapshot");
      this.sqlite.prepare(`
        INSERT INTO mirror_snapshots(
          snapshot_id, target_id, release_id, package_id, source_commit, mirror_ref, size_bytes, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_id, release_id, source_commit) DO UPDATE SET
          mirror_ref = excluded.mirror_ref, size_bytes = excluded.size_bytes, verified_at = excluded.verified_at
      `).run(
        snapshotId, job.targetId, job.releaseId, job.packageId, result.sourceCommit,
        result.mirrorRef, result.sizeBytes, timestamp,
      );
      this.insertEvent(job.targetId, jobId, "succeeded", result, timestamp);
      this.sqlite.exec("COMMIT");
      return this.getSnapshot(job.targetId, job.releaseId, result.sourceCommit)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  markOversized(jobId: string, sizeBytes: number, message: string, timestamp: string): void {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const job = this.requireRunningJob(jobId);
      this.sqlite.prepare(`
        UPDATE mirror_jobs SET status = 'oversized', lease_until = NULL, last_error = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(message, timestamp, jobId);
      this.sqlite.prepare(`
        UPDATE mirror_targets SET status = 'oversized', current_size_bytes = ?, last_error = ?, updated_at = ?
        WHERE target_id = ?
      `).run(sizeBytes, message, timestamp, job.targetId);
      this.insertEvent(job.targetId, jobId, "oversized", { sizeBytes, message }, timestamp);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  failJob(jobId: string, message: string, retryable: boolean, maxAttempts: number, timestamp: string): void {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const job = this.requireRunningJob(jobId);
      const retry = retryable && job.attempts < maxAttempts;
      const delaySeconds = Math.min(3600, 60 * (2 ** Math.max(0, job.attempts - 1)));
      const availableAt = new Date(Date.parse(timestamp) + delaySeconds * 1000).toISOString();
      this.sqlite.prepare(`
        UPDATE mirror_jobs SET status = ?, available_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(retry ? "pending" : "failed", availableAt, message, timestamp, jobId);
      const target = this.getTarget(job.targetId)!;
      this.sqlite.prepare(`
        UPDATE mirror_targets SET status = ?, last_error = ?, updated_at = ? WHERE target_id = ?
      `).run(target.lastSyncedCommit ? "ready" : retry ? "active" : "failed", message, timestamp, job.targetId);
      this.insertEvent(job.targetId, jobId, retry ? "retry_scheduled" : "failed", { message, availableAt }, timestamp);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  findReadyMirror(repositoryUrl: string, sourceCommit: string): { mirrorUrl: string; snapshot: MirrorSnapshot } | null {
    const row = this.sqlite.prepare(`
      SELECT s.*, t.mirror_url FROM mirror_snapshots s
      JOIN mirror_targets t ON t.target_id = s.target_id
      WHERE t.repository_url = ? AND s.source_commit = ? AND t.status <> 'paused'
      ORDER BY (s.release_id IS NOT NULL) DESC, s.verified_at DESC LIMIT 1
    `).get(repositoryUrl, sourceCommit) as (SnapshotRow & { mirror_url: string }) | undefined;
    return row ? { mirrorUrl: row.mirror_url, snapshot: this.mapSnapshot(row) } : null;
  }

  private getSnapshot(targetId: string, releaseId: string | null, commit: string): MirrorSnapshot | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM mirror_snapshots
      WHERE target_id = ? AND release_id IS ? AND source_commit = ?
    `).get(targetId, releaseId, commit) as SnapshotRow | undefined;
    return row ? this.mapSnapshot(row) : null;
  }

  private requireRunningJob(jobId: string): MirrorJob {
    const job = this.getJob(jobId);
    if (!job || job.status !== "running") throw new Error("mirror_job_not_running");
    return job;
  }

  private insertEvent(targetId: string, jobId: string | null, action: string, detail: unknown, timestamp: string): void {
    this.sqlite.prepare(`
      INSERT INTO mirror_events(event_id, target_id, job_id, action, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id("event"), targetId, jobId, action, JSON.stringify(detail), timestamp);
  }

  private mapTarget(row: TargetRow): MirrorTarget {
    return {
      id: row.target_id,
      repositoryUrl: row.repository_url,
      mode: row.mode as MirrorMode,
      branch: row.branch,
      approvedCommit: row.approved_commit,
      forgejoOwner: row.forgejo_owner,
      forgejoRepository: row.forgejo_repository,
      mirrorUrl: row.mirror_url,
      maxSizeBytes: Number(row.max_size_bytes),
      intervalSeconds: Number(row.interval_seconds),
      status: row.status as MirrorTargetStatus,
      currentSizeBytes: row.current_size_bytes === null ? null : Number(row.current_size_bytes),
      lastSyncedCommit: row.last_synced_commit,
      lastError: row.last_error,
      nextSyncAt: row.next_sync_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapJob(row: JobRow): MirrorJob {
    return {
      id: row.job_id,
      targetId: row.target_id,
      releaseId: row.release_id,
      packageId: row.package_id,
      requestedCommit: row.requested_commit,
      pinRef: row.pin_ref,
      status: row.status as MirrorJobStatus,
      attempts: Number(row.attempts),
      availableAt: row.available_at,
      leaseUntil: row.lease_until,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSnapshot(row: SnapshotRow): MirrorSnapshot {
    return {
      id: row.snapshot_id,
      targetId: row.target_id,
      releaseId: row.release_id,
      packageId: row.package_id,
      sourceCommit: row.source_commit,
      mirrorRef: row.mirror_ref,
      sizeBytes: Number(row.size_bytes),
      verifiedAt: row.verified_at,
    };
  }
}
