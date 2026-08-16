import { errorMessage, MirrorError, MirrorTooLargeError } from "./errors.js";
import type { MirrorExecutor } from "./git-mirror.js";
import { MirrorService } from "./service.js";

export class MirrorWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly service: MirrorService,
    private readonly executor: MirrorExecutor,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async runOnce(): Promise<boolean> {
    this.service.queueDueTargets();
    const claimed = this.service.claimJob();
    if (!claimed) return false;
    try {
      const result = await this.executor.execute(claimed);
      this.service.database.completeJob(claimed.job.id, result, new Date().toISOString());
    } catch (error) {
      const timestamp = new Date().toISOString();
      if (error instanceof MirrorTooLargeError) {
        this.service.database.markOversized(claimed.job.id, error.sizeBytes, error.message, timestamp);
      } else {
        const retryable = error instanceof MirrorError ? error.retryable : false;
        this.service.database.failJob(
          claimed.job.id,
          errorMessage(error),
          retryable,
          this.service.executionConfig.maxAttempts,
          timestamp,
        );
      }
    }
    return true;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      if (this.stopped) return;
      this.running = true;
      let worked = false;
      try { worked = await this.runOnce(); }
      catch (error) { console.error("Mirror worker cycle failed", error); }
      finally { this.running = false; }
      if (!this.stopped) this.schedule(worked ? 0 : this.pollIntervalMs);
    }, delay);
    this.timer.unref();
  }
}
