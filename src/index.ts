import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { MirrorDatabase } from "./database.js";
import { ForgejoClient } from "./forgejo.js";
import { GitMirrorExecutor } from "./git-mirror.js";
import { createMirrorServer } from "./server.js";
import { MirrorService, type CreateMirrorTargetRequest } from "./service.js";
import { MirrorWorker } from "./worker.js";

const config = loadConfig();
const database = new MirrorDatabase(config.databasePath);
const service = new MirrorService(database, config);
await loadSeedTargets(service, config.seedFile);

const forgejo = new ForgejoClient({
  baseUrl: config.forgejoBaseUrl,
  token: config.forgejoToken,
  ownerKind: config.forgejoOwnerKind,
});
const executor = new GitMirrorExecutor(forgejo, {
  workRoot: config.workRoot,
  githubToken: config.githubToken,
  forgejoUsername: config.forgejoUsername,
  forgejoToken: config.forgejoToken,
});
const worker = new MirrorWorker(service, executor, config.pollIntervalMs);
const server = createMirrorServer({ service, apiToken: config.apiToken });

worker.start();
server.listen(config.port, config.host, () => {
  console.log(`OpenHouse Git Mirror listening on http://${config.host}:${config.port}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

async function loadSeedTargets(service: MirrorService, seedFile: string | null): Promise<void> {
  if (!seedFile) return;
  const parsed = JSON.parse(await readFile(seedFile, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("MIRROR_SEED_FILE must contain a JSON array");
  for (const item of parsed) service.registerTarget(item as CreateMirrorTargetRequest);
}
