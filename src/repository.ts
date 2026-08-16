import { MirrorError } from "./errors.js";

const GITHUB_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_REF_PART = /^[A-Za-z0-9._/-]+$/;

export interface GitHubRepositoryIdentity {
  owner: string;
  name: string;
  repositoryUrl: string;
}

export function parseGitHubRepository(value: string): GitHubRepositoryIdentity {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new MirrorError("invalid_repository", "repositoryUrl must be a valid HTTPS GitHub URL"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new MirrorError("invalid_repository", "Only HTTPS github.com repositories can be mirrored");
  }
  const match = GITHUB_PATH.exec(url.pathname);
  if (!match?.[1] || !match[2]) throw new MirrorError("invalid_repository", "GitHub repository must have owner/name form");
  const name = match[2].replace(/\.git$/i, "");
  return {
    owner: match[1],
    name,
    repositoryUrl: `https://github.com/${match[1]}/${name}.git`,
  };
}

export function requireCommit(value: string): string {
  const commit = value.trim().toLowerCase();
  if (!FULL_COMMIT.test(commit)) throw new MirrorError("invalid_commit", "approvedCommit must be a full 40-character Git commit");
  return commit;
}

export function requireBranch(value: string): string {
  const branch = value.trim();
  if (!branch || branch.length > 240 || !SAFE_REF_PART.test(branch) || branch.startsWith("/") || branch.endsWith("/") || branch.includes("..")) {
    throw new MirrorError("invalid_branch", "branch is not a safe Git branch name");
  }
  return branch;
}

export function forgejoRepositoryName(identity: GitHubRepositoryIdentity): string {
  return `${identity.owner}--${identity.name}`.toLowerCase();
}

export function releasePinRef(releaseId: string): string {
  const safe = releaseId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new MirrorError("invalid_release_id", "releaseId cannot be converted to a Git ref");
  return `refs/tags/openhouse-pin/${safe}`;
}
