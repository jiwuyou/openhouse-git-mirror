import assert from "node:assert/strict";
import { test } from "node:test";
import { MirrorError } from "../src/errors.js";
import { requirePublicGitHubRepository } from "../src/github.js";

test("public repository verification uses anonymous GitHub access", async () => {
  let authorization: string | null = "not-called";
  await requirePublicGitHubRepository("https://github.com/example/public", async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return Response.json({ private: false });
  });
  assert.equal(authorization, null);
});

test("private or unavailable repositories cannot be registered", async () => {
  await assert.rejects(
    requirePublicGitHubRepository("https://github.com/example/private", async () => Response.json({ private: true })),
    (error) => error instanceof MirrorError && error.code === "github_repository_private",
  );
  await assert.rejects(
    requirePublicGitHubRepository("https://github.com/example/missing", async () => new Response(null, { status: 404 })),
    (error) => error instanceof MirrorError && error.code === "github_repository_unavailable",
  );
});
