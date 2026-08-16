import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MirrorError, MirrorTooLargeError } from "./errors.js";
import type { RepositoryProvisioner } from "./forgejo.js";
import { parseGitHubRepository } from "./repository.js";
import type { ClaimedMirrorJob, MirrorExecutionResult } from "./types.js";

const execFileAsync = promisify(execFile);
const FULL_COMMIT = /^[a-f0-9]{40}$/;

export interface GitMirrorExecutorOptions {
  workRoot: string;
  githubToken: string;
  forgejoUsername: string;
  forgejoToken: string;
  commandTimeoutMs?: number;
  preflight?: (repositoryUrl: string, maxSizeBytes: number) => Promise<void>;
}

export interface MirrorExecutor {
  execute(claimed: ClaimedMirrorJob): Promise<MirrorExecutionResult>;
}

export class GitMirrorExecutor implements MirrorExecutor {
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly provisioner: RepositoryProvisioner,
    private readonly options: GitMirrorExecutorOptions,
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10 * 60_000;
  }

  async execute(claimed: ClaimedMirrorJob): Promise<MirrorExecutionResult> {
    const { job, target } = claimed;
    await mkdir(this.options.workRoot, { recursive: true, mode: 0o700 });
    if (this.options.preflight) await this.options.preflight(target.repositoryUrl, target.maxSizeBytes);
    else await this.preflightSize(target.repositoryUrl, target.maxSizeBytes);
    const root = await mkdtemp(join(this.options.workRoot, `${job.id}-`));
    const repository = join(root, "repository.git");
    try {
      await this.git(root, ["clone", "--mirror", target.repositoryUrl, repository]);
      await this.git(repository, ["lfs", "fetch", "--all"]);
      await this.git(repository, ["repack", "-Ad"]);
      const sizeBytes = await directorySize(repository);
      if (sizeBytes > target.maxSizeBytes) throw new MirrorTooLargeError(sizeBytes, target.maxSizeBytes);

      const commit = await this.resolveCommit(repository, claimed);
      if (job.pinRef) await this.git(repository, ["update-ref", job.pinRef, commit]);

      const remote = await this.provisioner.ensureRepository(target);
      await this.git(repository, ["remote", "add", "openhouse", remote.cloneUrl]);
      const authenticatedEnvironment = await this.askPassEnvironment(root);
      await this.git(repository, [
        "push", "--force", "openhouse",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ], authenticatedEnvironment);
      await this.git(repository, ["lfs", "push", "--all", "openhouse"], authenticatedEnvironment);
      await this.verifyRemote(repository, commit, authenticatedEnvironment);
      return { sourceCommit: commit, mirrorRef: job.pinRef, sizeBytes };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private async preflightSize(repositoryUrl: string, maxSizeBytes: number): Promise<void> {
    const identity = parseGitHubRepository(repositoryUrl);
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "openhouse-git-mirror/0.1",
        ...(this.options.githubToken ? { authorization: `Bearer ${this.options.githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429 || response.status >= 500) return;
      throw new MirrorError("github_repository_unavailable", `GitHub repository preflight failed (${response.status})`, response.status >= 500);
    }
    const body = await response.json() as { size?: unknown };
    const estimatedBytes = typeof body.size === "number" ? body.size * 1024 : null;
    if (estimatedBytes !== null && estimatedBytes > maxSizeBytes) throw new MirrorTooLargeError(estimatedBytes, maxSizeBytes);
  }

  private async resolveCommit(repository: string, claimed: ClaimedMirrorJob): Promise<string> {
    const candidate = claimed.job.requestedCommit
      ?? (claimed.target.branch ? `refs/heads/${claimed.target.branch}` : "HEAD");
    let commit: string;
    try {
      commit = (await this.git(repository, ["rev-parse", `${candidate}^{commit}`])).trim();
    } catch (error) {
      throw new MirrorError("commit_unavailable", `Source repository does not contain ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!FULL_COMMIT.test(commit)) throw new MirrorError("invalid_source_commit", "Source did not resolve to a full Git commit");
    return commit;
  }

  private async verifyRemote(repository: string, commit: string, environment: NodeJS.ProcessEnv): Promise<void> {
    const output = await this.git(repository, ["ls-remote", "openhouse"], environment);
    if (!output.split("\n").some((line) => line.startsWith(`${commit}\t`))) {
      throw new MirrorError("mirror_commit_missing", `Forgejo does not advertise verified commit ${commit}`, true);
    }
  }

  private async askPassEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
    if (!this.options.forgejoToken) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const helper = join(root, "git-askpass.sh");
    await writeFile(helper, `#!/bin/sh\ncase "$1" in\n  *sername*) printf '%s\\n' "$FORGEJO_USERNAME" ;;\n  *) printf '%s\\n' "$FORGEJO_TOKEN" ;;\nesac\n`, { mode: 0o700 });
    await chmod(helper, 0o700);
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: helper,
      GIT_ASKPASS_REQUIRE: "force",
      FORGEJO_USERNAME: this.options.forgejoUsername,
      FORGEJO_TOKEN: this.options.forgejoToken,
    };
  }

  private async git(cwd: string, args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        env: { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
        timeout: this.commandTimeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const detail = error as { stderr?: string; stdout?: string; message?: string };
      throw new MirrorError("git_failed", (detail.stderr || detail.stdout || detail.message || "Git command failed").trim(), true);
    }
  }
}

export async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}
