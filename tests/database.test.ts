import assert from "node:assert/strict";
import { test } from "node:test";
import type { MirrorConfig } from "../src/config.js";
import { MirrorDatabase } from "../src/database.js";
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
