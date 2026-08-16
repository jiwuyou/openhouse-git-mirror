import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MirrorError } from "./errors.js";
import { requirePublicGitHubRepository } from "./github.js";
import { MirrorService } from "./service.js";

export interface MirrorServerOptions {
  service: MirrorService;
  apiToken: string;
}

export function createMirrorServer(options: MirrorServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      await route(options, request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof MirrorError) {
        sendJson(response, errorStatus(error.code), { error: { code: error.code, message: error.message } });
      } else {
        console.error(error);
        sendJson(response, 500, { error: { code: "internal_error", message: "Mirror service could not complete the request" } });
      }
    }
  });
}

async function route(options: MirrorServerOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "openhouse-git-mirror", time: new Date().toISOString() });
    return;
  }
  if (!url.pathname.startsWith("/api/v1/")) throw new MirrorError("route_not_found", "Route does not exist");
  authenticate(request, options.apiToken);
  const parts = url.pathname.slice("/api/v1/".length).split("/").filter(Boolean).map(decodeURIComponent);
  const { service } = options;

  if (parts[0] === "targets") {
    if (parts.length === 1 && method === "GET") {
      sendJson(response, 200, { targets: service.listTargets() });
      return;
    }
    if (parts.length === 1 && method === "POST") {
      const input = await readJson(request) as { repositoryUrl?: unknown };
      if (typeof input.repositoryUrl !== "string") throw new MirrorError("invalid_request", "repositoryUrl is required");
      await requirePublicGitHubRepository(input.repositoryUrl);
      sendJson(response, 202, service.registerTarget(input as never));
      return;
    }
    if (parts[1] && parts.length === 2 && method === "GET") {
      sendJson(response, 200, { target: service.getTarget(parts[1]) });
      return;
    }
    if (parts[1] && parts.length === 2 && method === "PATCH") {
      sendJson(response, 200, { target: service.updateTarget(parts[1], await readJson(request) as never) });
      return;
    }
    if (parts[1] && parts.length === 3 && parts[2] === "jobs" && method === "GET") {
      sendJson(response, 200, { jobs: service.listJobsForTarget(parts[1]) });
      return;
    }
    if (parts[1] && parts.length === 3 && method === "POST") {
      if (parts[2] === "sync") sendJson(response, 202, { job: service.runNow(parts[1]) });
      else if (parts[2] === "pause") sendJson(response, 200, { target: service.pause(parts[1]) });
      else if (parts[2] === "resume") sendJson(response, 200, { target: service.resume(parts[1]) });
      else throw new MirrorError("route_not_found", "Target action does not exist");
      return;
    }
  }

  if (parts[0] === "releases" && parts.length === 1 && method === "POST") {
    const input = await readJson(request) as { repositoryUrl?: unknown };
    if (typeof input.repositoryUrl !== "string") throw new MirrorError("invalid_request", "repositoryUrl is required");
    await requirePublicGitHubRepository(input.repositoryUrl);
    sendJson(response, 202, service.registerRelease(input as never));
    return;
  }

  if (parts[0] === "jobs" && parts.length === 1 && method === "GET") {
    sendJson(response, 200, { jobs: service.listJobs() });
    return;
  }

  if (parts[0] === "sources" && parts.length === 1 && method === "GET") {
    const repositoryUrl = url.searchParams.get("repositoryUrl");
    const approvedCommit = url.searchParams.get("approvedCommit");
    if (!repositoryUrl || !approvedCommit) throw new MirrorError("invalid_request", "repositoryUrl and approvedCommit are required");
    const ready = service.findSource(repositoryUrl, approvedCommit);
    sendJson(response, 200, {
      source: ready ? {
        kind: "mirror",
        url: ready.mirrorUrl,
        priority: 90,
        verifiedCommit: ready.snapshot.sourceCommit,
        sizeBytes: ready.snapshot.sizeBytes,
        verifiedAt: ready.snapshot.verifiedAt,
      } : null,
    });
    return;
  }

  throw new MirrorError("route_not_found", "Route does not exist");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new MirrorError("request_too_large", "Request exceeds 1 MiB");
    chunks.push(bytes);
  }
  try { return size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new MirrorError("invalid_json", "Request body is not valid JSON"); }
}

function authenticate(request: IncomingMessage, expected: string): void {
  if (!expected) throw new MirrorError("api_auth_not_configured", "MIRROR_API_TOKEN is not configured");
  const header = request.headers.authorization;
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new MirrorError("api_auth_invalid", "Mirror API bearer token is invalid");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

function errorStatus(code: string): number {
  if (code === "route_not_found" || code === "target_not_found") return 404;
  if (code === "target_paused") return 409;
  if (code === "github_verification_unavailable") return 503;
  if (code === "api_auth_invalid") return 401;
  if (code === "api_auth_not_configured") return 503;
  if (code === "request_too_large") return 413;
  return 400;
}
