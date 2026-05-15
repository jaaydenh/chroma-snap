export type QueueJobStatus = "pending" | "processing" | "completed" | "failed";

export interface QueueJobRow {
  id: string;
  type: string;
  buildId?: string;
  payloadJson: string;
  status: QueueJobStatus;
  attempts: number;
  createdAt: string;
  processedAt?: string;
  lastError?: string;
  nextRetryAt?: string;
}

export interface QueueJobProcessorOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  now?: () => Date;
}

export type QueueJobHandler = (job: QueueJobRow) => Promise<void>;
export type QueueJobHandlers = Record<string, QueueJobHandler>;

export interface QueueJobProcessResult {
  job: QueueJobRow;
  handled: boolean;
  error?: string;
}

export class QueueJobProcessor {
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => Date;

  constructor(private readonly handlers: QueueJobHandlers, options: QueueJobProcessorOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
  }

  async executeWithRetry(job: QueueJobRow): Promise<QueueJobProcessResult> {
    if (isTerminal(job)) {
      return { job, handled: false };
    }

    const handler = this.handlers[job.type];
    if (!handler) {
      return this.fail(job, new Error(`No queue job handler registered for '${job.type}'.`));
    }

    const processingJob: QueueJobRow = {
      ...job,
      status: "processing",
      lastError: undefined,
      nextRetryAt: undefined,
    };

    try {
      await handler(processingJob);
      return {
        handled: true,
        job: {
          ...processingJob,
          status: "completed",
          processedAt: this.now().toISOString(),
          lastError: undefined,
          nextRetryAt: undefined,
        },
      };
    } catch (error) {
      return this.fail(job, error);
    }
  }

  private fail(job: QueueJobRow, error: unknown): QueueJobProcessResult {
    const attempts = job.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attempts >= this.maxAttempts;
    const nextRetryAt = terminal ? undefined : new Date(this.now().getTime() + retryDelayMs(attempts, this.baseBackoffMs)).toISOString();
    return {
      handled: true,
      error: message,
      job: {
        ...job,
        status: terminal ? "failed" : "pending",
        attempts,
        lastError: message,
        nextRetryAt,
        processedAt: terminal ? this.now().toISOString() : undefined,
      },
    };
  }
}

export function retryDelayMs(attempts: number, baseBackoffMs = 1_000): number {
  return baseBackoffMs * 2 ** Math.max(0, attempts - 1);
}

function isTerminal(job: QueueJobRow): boolean {
  return job.status === "completed" || Boolean(job.processedAt) || (job.status as QueueJobStatus) === "failed";
}
