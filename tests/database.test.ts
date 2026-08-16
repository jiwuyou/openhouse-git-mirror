import assert from "node:assert/strict";
import { test } from "node:test";
import type { MirrorConfig } from "../src/config.js";
import { MirrorDatabase } from "../src/database.js";
import { MirrorError } from "../src/errors.js";
import { MirrorService } from "../src/service.js";

const COMMIT = "1111111111111111111111111111111111111111";

test("release registration is idempotent and exposes only completed mirror snapshots", () => {
  const database = new MirrorDatabase(":memory:");
  const service = new MirrorService(database, config());
  const first = service.registerRelease({
    packageId: "io.wuxianpi.fixture",
    releaseId: "rel_fixture",
    repositoryUrl: "https://github.com/example/fixture",
    approvedCommit: COMMIT,
  });
  service.registerRelease({
    packageId: "io.wuxianpi.fixture",
    releaseId: "rel_fixture",
    repositoryUrl: "https://github.com/example/fixture.git",
    approvedCommit: COMMIT,
  });

  assert.equal(database.listJobs().length, 2, "one initial job and one immutable release job");
  assert.equal(service.findSource(first.target.repositoryUrl, COMMIT), null);

  for (let claim = service.claimJob(); claim; claim = service.claimJob()) {
    database.completeJob(claim.job.id, {
      sourceCommit: COMMIT,
      mirrorRef: claim.job.pinRef,
      sizeBytes: 1024,
    }, new Date().toISOString());
  }

  const source = service.findSource(first.target.repositoryUrl, COMMIT);
  assert.equal(source?.mirrorUrl, first.target.mirrorUrl);
  assert.equal(source?.snapshot.releaseId, "rel_fixture");
  database.close();
});

test("an oversized update preserves the last verified snapshot", () => {
  const database = new MirrorDatabase(":memory:");
  const service = new MirrorService(database, config());
  const registered = service.registerTarget({ repositoryUrl: "https://github.com/example/fixture" });
  const initial = service.claimJob();
  assert.ok(initial);
  database.completeJob(initial.job.id, { sourceCommit: COMMIT, mirrorRef: null, sizeBytes: 1024 }, new Date().toISOString());

  service.runNow(registered.target.id);
  const update = service.claimJob();
  assert.ok(update);
  database.markOversized(update.job.id, 40 * 1024 * 1024, "too large", new Date().toISOString());

  const target = service.getTarget(registered.target.id);
  assert.equal(target.status, "oversized");
  assert.equal(target.lastSyncedCommit, COMMIT);
  assert.equal(service.findSource(target.repositoryUrl, COMMIT)?.snapshot.sourceCommit, COMMIT);
  database.close();
});

test("paused targets keep verified snapshots and preserve pause across an in-flight job", () => {
  const database = new MirrorDatabase(":memory:");
  const service = new MirrorService(database, config());
  const registered = service.registerTarget({ repositoryUrl: "https://github.com/example/paused" });
  const initial = service.claimJob();
  assert.ok(initial);

  service.pause(registered.target.id);
  database.completeJob(initial.job.id, { sourceCommit: COMMIT, mirrorRef: null, sizeBytes: 1024 }, new Date().toISOString());

  assert.equal(service.getTarget(registered.target.id).status, "paused");
  assert.equal(service.findSource(registered.target.repositoryUrl, COMMIT)?.snapshot.sourceCommit, COMMIT);
  assert.throws(() => service.runNow(registered.target.id), (error) => error instanceof MirrorError && error.code === "target_paused");
  database.close();
});

test("manual synchronization is coalesced and target jobs can be queried", () => {
  const database = new MirrorDatabase(":memory:");
  const service = new MirrorService(database, config());
  const registered = service.registerTarget({ repositoryUrl: "https://github.com/example/coalesced" });

  const first = service.runNow(registered.target.id);
  const second = service.runNow(registered.target.id);

  assert.equal(first.id, second.id);
  assert.equal(service.listJobsForTarget(registered.target.id).length, 2, "initial and one manual job");
  database.close();
});

test("tracking settings are adjustable but the global size ceiling is enforced", () => {
  const database = new MirrorDatabase(":memory:");
  const service = new MirrorService(database, config());
  const registered = service.registerTarget({ repositoryUrl: "https://github.com/example/settings" });

  const updated = service.updateTarget(registered.target.id, {
    branch: "stable",
    intervalSeconds: 7200,
    maxSizeBytes: 10 * 1024 * 1024,
  });
  assert.equal(updated.branch, "stable");
  assert.equal(updated.intervalSeconds, 7200);
  assert.equal(updated.maxSizeBytes, 10 * 1024 * 1024);
  assert.throws(
    () => service.updateTarget(registered.target.id, { maxSizeBytes: 30 * 1024 * 1024 + 1 }),
    (error) => error instanceof MirrorError && error.code === "mirror_size_limit_exceeded",
  );
  database.close();
});

function config(): MirrorConfig {
  return {
    host: "127.0.0.1",
    port: 20879,
    databasePath: ":memory:",
    workRoot: "/tmp/openhouse-git-mirror-test",
    apiToken: "test-token",
    pollIntervalMs: 1000,
    leaseSeconds: 60,
    maxAttempts: 3,
    defaultMaxBytes: 30 * 1024 * 1024,
    defaultIntervalSeconds: 3600,
    seedFile: null,
    githubToken: "",
    forgejoBaseUrl: "https://git.example.com",
    forgejoPublicUrl: "https://git.example.com",
    forgejoToken: "",
    forgejoOwner: "openhouse",
    forgejoOwnerKind: "organization",
    forgejoUsername: "mirror-worker",
  };
}
