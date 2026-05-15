import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileStoreLock } from "./file-store-lock.js";
import type { AuditEvent, ReviewDecision, ReviewDecisionState } from "./review.js";

export interface ReviewDecisionListInput {
  buildId?: string;
  identityKey?: string;
  state?: ReviewDecisionState;
}

export interface AuditEventListInput {
  repositoryFullName?: string;
  buildId?: string;
  identityKey?: string;
  eventType?: string;
  limit?: number;
}

export interface ReviewStore {
  saveReviewDecision(decision: ReviewDecision): Promise<void>;
  listReviewDecisions(input: ReviewDecisionListInput): Promise<ReviewDecision[]>;
  getLatestReviewDecision(input: ReviewDecisionListInput): Promise<ReviewDecision | undefined>;
  saveAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(input?: AuditEventListInput): Promise<AuditEvent[]>;
}

export interface ReviewStoreDocument {
  version: 1;
  decisions: ReviewDecision[];
  auditEvents: AuditEvent[];
}

export class FileReviewStore implements ReviewStore {
  constructor(private readonly path: string) {}

  async saveReviewDecision(decision: ReviewDecision): Promise<void> {
    await withFileStoreLock(this.path, async () => {
      const store = await this.readStore();
      store.decisions.push(decision);
      await this.writeStore(store);
    });
  }

  async listReviewDecisions(input: ReviewDecisionListInput): Promise<ReviewDecision[]> {
    const store = await this.readStore();
    return store.decisions
      .filter((decision) => !input.buildId || decision.buildId === input.buildId)
      .filter((decision) => !input.identityKey || decision.identityKey === input.identityKey)
      .filter((decision) => !input.state || decision.state === input.state)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async getLatestReviewDecision(input: ReviewDecisionListInput): Promise<ReviewDecision | undefined> {
    const decisions = await this.listReviewDecisions(input);
    return decisions.at(-1);
  }

  async saveAuditEvent(event: AuditEvent): Promise<void> {
    await withFileStoreLock(this.path, async () => {
      const store = await this.readStore();
      store.auditEvents.push(event);
      await this.writeStore(store);
    });
  }

  async listAuditEvents(input: AuditEventListInput = {}): Promise<AuditEvent[]> {
    const store = await this.readStore();
    const events = store.auditEvents
      .filter((event) => !input.repositoryFullName || event.repositoryFullName === input.repositoryFullName)
      .filter((event) => !input.buildId || event.buildId === input.buildId)
      .filter((event) => !input.identityKey || event.identityKey === input.identityKey)
      .filter((event) => !input.eventType || event.eventType === input.eventType)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return input.limit === undefined ? events : events.slice(-Math.max(0, input.limit));
  }

  async readStore(): Promise<ReviewStoreDocument> {
    try {
      return normalizeStore(JSON.parse(await readFile(this.path, "utf8")) as Partial<ReviewStoreDocument>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, decisions: [], auditEvents: [] };
      }
      throw error;
    }
  }

  async writeStore(store: ReviewStoreDocument): Promise<void> {
    await mkdir(dirname(resolve(this.path)), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}

function normalizeStore(store: Partial<ReviewStoreDocument>): ReviewStoreDocument {
  return {
    version: 1,
    decisions: Array.isArray(store.decisions) ? store.decisions : [],
    auditEvents: Array.isArray(store.auditEvents) ? store.auditEvents : [],
  };
}
