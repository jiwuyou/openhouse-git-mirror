import type { ForgejoOwnerKind } from "./config.js";
import { MirrorError } from "./errors.js";
import type { MirrorTarget } from "./types.js";

export interface ForgejoRepository {
  cloneUrl: string;
}

export interface RepositoryProvisioner {
  ensureRepository(target: MirrorTarget): Promise<ForgejoRepository>;
}

export interface ForgejoClientOptions {
  baseUrl: string;
  token: string;
  ownerKind: ForgejoOwnerKind;
}

export class ForgejoClient implements RepositoryProvisioner {
  constructor(private readonly options: ForgejoClientOptions) {}

  async ensureRepository(target: MirrorTarget): Promise<ForgejoRepository> {
    if (!this.options.token) throw new MirrorError("forgejo_not_configured", "FORGEJO_TOKEN is required", true);
    const existing = await this.request(`/api/v1/repos/${encodeURIComponent(target.forgejoOwner)}/${encodeURIComponent(target.forgejoRepository)}`, "GET");
    if (existing.status === 200) return { cloneUrl: requireCloneUrl(await existing.json()) };
    if (existing.status !== 404) throw await responseError(existing, "Unable to query Forgejo repository");

    const path = this.options.ownerKind === "organization"
      ? `/api/v1/orgs/${encodeURIComponent(target.forgejoOwner)}/repos`
      : "/api/v1/user/repos";
    const created = await this.request(path, "POST", {
      name: target.forgejoRepository,
      description: `Read-only mirror of ${target.repositoryUrl}`,
      private: false,
      auto_init: false,
      default_branch: target.branch ?? "main",
      has_issues: false,
      has_projects: false,
      has_wiki: false,
      has_pull_requests: false,
    });
    if (created.status !== 201) throw await responseError(created, "Unable to create Forgejo repository");
    return { cloneUrl: requireCloneUrl(await created.json()) };
  }

  private request(path: string, method: "GET" | "POST", body?: unknown): Promise<Response> {
    return fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `token ${this.options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  }
}

function requireCloneUrl(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MirrorError("forgejo_invalid_response", "Forgejo returned an invalid repository", true);
  const cloneUrl = (value as Record<string, unknown>).clone_url;
  if (typeof cloneUrl !== "string" || !cloneUrl) throw new MirrorError("forgejo_invalid_response", "Forgejo repository has no clone_url", true);
  return cloneUrl;
}

async function responseError(response: Response, message: string): Promise<MirrorError> {
  const detail = (await response.text()).slice(0, 2000);
  return new MirrorError("forgejo_request_failed", `${message} (${response.status}): ${detail}`, response.status >= 500 || response.status === 429);
}
