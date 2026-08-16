#!/usr/bin/env node

const baseUrl = (process.env.MIRROR_SERVICE_URL ?? "http://127.0.0.1:20879").replace(/\/$/, "");
const token = process.env.MIRROR_API_TOKEN ?? "";
const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") usage();
if (!token) fail("MIRROR_API_TOKEN is required");

switch (command) {
  case "list":
    print(await request("GET", "/api/v1/targets"));
    break;
  case "jobs":
    print(await request("GET", "/api/v1/jobs"));
    break;
  case "add": {
    const repositoryUrl = option(args, "--repository");
    const mode = option(args, "--mode", "tracking");
    const branch = option(args, "--branch", "main");
    const approvedCommit = option(args, "--commit", "");
    print(await request("POST", "/api/v1/targets", {
      repositoryUrl,
      mode,
      ...(mode === "tracking" ? { branch } : { approvedCommit }),
    }));
    break;
  }
  case "sync":
  case "pause":
  case "resume": {
    const targetId = args[0];
    if (!targetId) fail(`${command} requires targetId`);
    print(await request("POST", `/api/v1/targets/${encodeURIComponent(targetId)}/${command}`));
    break;
  }
  default:
    fail(`Unknown command: ${command}`);
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as unknown;
  if (!response.ok) fail(JSON.stringify(value));
  return value;
}

function option(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? fallback : args[index + 1];
  if (!value) fail(`${name} is required`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage(): never {
  process.stdout.write(`OpenHouse Git Mirror CLI\n\n`);
  process.stdout.write(`  list\n  jobs\n  add --repository <github-url> [--mode tracking --branch main]\n`);
  process.stdout.write(`  add --repository <github-url> --mode pinned --commit <40-char-commit>\n`);
  process.stdout.write(`  sync <targetId>\n  pause <targetId>\n  resume <targetId>\n`);
  process.exit(0);
}
