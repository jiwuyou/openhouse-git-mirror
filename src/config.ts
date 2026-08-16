import { resolve } from "node:path";
import { DEFAULT_MAX_MIRROR_BYTES } from "./types.js";

export type ForgejoOwnerKind = "organization" | "user";

export interface MirrorConfig {
  host: string;
  port: number;
  databasePath: string;
  workRoot: string;
  apiToken: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  maxAttempts: number;
  defaultMaxBytes: number;
  defaultIntervalSeconds: number;
  seedFile: string | null;
  githubToken: string;
  forgejoBaseUrl: string;
  forgejoPublicUrl: string;
  forgejoToken: string;
  forgejoOwner: string;
  forgejoOwnerKind: ForgejoOwnerKind;
  forgejoUsername: string;
}

function integer(value: string | undefined, fallback: number, name: string, minimum: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} is invalid`);
  return parsed;
}

function origin(value: string | undefined, fallback: string, name: string): string {
  const parsed = new URL(value ?? fallback);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be HTTP or HTTPS`);
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MirrorConfig {
  const port = integer(env.MIRROR_PORT, 20879, "MIRROR_PORT", 1);
  if (port > 65535) throw new Error("MIRROR_PORT is invalid");
  const ownerKind = env.FORGEJO_OWNER_KIND ?? "organization";
  if (ownerKind !== "organization" && ownerKind !== "user") throw new Error("FORGEJO_OWNER_KIND is invalid");
  const forgejoBaseUrl = origin(env.FORGEJO_BASE_URL, "http://127.0.0.1:3000", "FORGEJO_BASE_URL");
  return {
    host: env.MIRROR_HOST ?? "127.0.0.1",
    port,
    databasePath: resolve(env.MIRROR_DB_PATH ?? "data/mirror.sqlite"),
    workRoot: resolve(env.MIRROR_WORK_ROOT ?? "work"),
    apiToken: env.MIRROR_API_TOKEN?.trim() ?? "",
    pollIntervalMs: integer(env.MIRROR_POLL_INTERVAL_MS, 5_000, "MIRROR_POLL_INTERVAL_MS", 250),
    leaseSeconds: integer(env.MIRROR_LEASE_SECONDS, 15 * 60, "MIRROR_LEASE_SECONDS", 30),
    maxAttempts: integer(env.MIRROR_MAX_ATTEMPTS, 5, "MIRROR_MAX_ATTEMPTS", 1),
    defaultMaxBytes: integer(env.MIRROR_MAX_BYTES, DEFAULT_MAX_MIRROR_BYTES, "MIRROR_MAX_BYTES", 1024),
    defaultIntervalSeconds: integer(env.MIRROR_DEFAULT_INTERVAL_SECONDS, 3600, "MIRROR_DEFAULT_INTERVAL_SECONDS", 60),
    seedFile: env.MIRROR_SEED_FILE?.trim() ? resolve(env.MIRROR_SEED_FILE) : null,
    githubToken: env.GITHUB_TOKEN?.trim() ?? "",
    forgejoBaseUrl,
    forgejoPublicUrl: origin(env.FORGEJO_PUBLIC_URL, forgejoBaseUrl, "FORGEJO_PUBLIC_URL"),
    forgejoToken: env.FORGEJO_TOKEN?.trim() ?? "",
    forgejoOwner: env.FORGEJO_OWNER?.trim() || "openhouse",
    forgejoOwnerKind: ownerKind,
    forgejoUsername: env.FORGEJO_USERNAME?.trim() || "mirror-worker",
  };
}
