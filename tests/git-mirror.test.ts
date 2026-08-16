import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import type { RepositoryProvisioner } from "../src/forgejo.js";
import { GitMirrorExecutor } from "../src/git-mirror.js";
import type { ClaimedMirrorJob } from "../src/types.js";

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

test("Git executor pushes branches and an immutable release pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "openhouse-git-mirror-"));
  cleanup.push(root);
  const source = join(root, "source");
  const destination = join(root, "destination.git");
  const work = join(root, "work");
  await git(root, ["init", "-b", "main", source]);
  await writeFile(join(source, "README.md"), "fixture\n");
  await git(source, ["add", "README.md"]);
  await git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture"]);
  const commit = (await git(source, ["rev-parse", "HEAD"])).trim();
  await git(root, ["init", "--bare", destination]);

  const provisioner: RepositoryProvisioner = { ensureRepository: async () => ({ cloneUrl: destination }) };
  const executor = new GitMirrorExecutor(provisioner, {
    workRoot: work,
    githubToken: "",
    forgejoUsername: "unused",
    forgejoToken: "",
    preflight: async () => undefined,
  });
  const claimed: ClaimedMirrorJob = {
    job: {
      id: "job_fixture", targetId: "mirror_fixture", releaseId: "rel_fixture", packageId: "io.fixture",
      requestedCommit: commit, pinRef: "refs/tags/openhouse-pin/rel_fixture", status: "running", attempts: 1,
      availableAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60_000).toISOString(), lastError: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    target: {
      id: "mirror_fixture", repositoryUrl: source, mode: "tracking", branch: "main", approvedCommit: null,
      forgejoOwner: "openhouse", forgejoRepository: "fixture", mirrorUrl: destination,
      maxSizeBytes: 30 * 1024 * 1024, intervalSeconds: 3600, status: "active", currentSizeBytes: null,
      lastSyncedCommit: null, lastError: null, nextSyncAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  };

  const result = await executor.execute(claimed);
  assert.equal(result.sourceCommit, commit);
  assert.equal((await git(root, ["--git-dir", destination, "rev-parse", "refs/heads/main"])).trim(), commit);
  assert.equal((await git(root, ["--git-dir", destination, "rev-parse", "refs/tags/openhouse-pin/rel_fixture"])).trim(), commit);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}
