import { MirrorError } from "./errors.js";
import { parseGitHubRepository } from "./repository.js";

export async function requirePublicGitHubRepository(
  repositoryUrl: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const repository = parseGitHubRepository(repositoryUrl);
  let response: Response;
  try {
    response = await request(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "openhouse-git-mirror/0.1",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new MirrorError("github_verification_unavailable", "GitHub repository verification is unavailable", true);
  }
  if (response.status === 404) throw new MirrorError("github_repository_unavailable", "GitHub repository is not publicly accessible");
  if (!response.ok) {
    throw new MirrorError(
      "github_verification_unavailable",
      `GitHub repository verification failed (${response.status})`,
      response.status === 403 || response.status === 429 || response.status >= 500,
    );
  }
  const body = await response.json() as { private?: unknown };
  if (body.private !== false) throw new MirrorError("github_repository_private", "Only public GitHub repositories can be mirrored");
}
