import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  GitHubCheckRunRecord,
  GitHubInstallationRecord,
  GitHubPullRequestRecord,
  GitHubRefRecord,
  GitHubWebhookEventRecord,
} from "@chroma-snap/shared";

export interface GitHubIntegrationStore {
  getWebhookEvent(deliveryId: string): Promise<GitHubWebhookEventRecord | undefined>;
  saveWebhookEvent(record: GitHubWebhookEventRecord): Promise<void>;
  markWebhookEventProcessed(deliveryId: string, processedAt: string): Promise<void>;
  saveInstallation(record: GitHubInstallationRecord): Promise<void>;
  getInstallation(installationId: number): Promise<GitHubInstallationRecord | undefined>;
  deleteInstallation(installationId: number, deletedAt: string): Promise<void>;
  savePullRequest(record: GitHubPullRequestRecord): Promise<void>;
  getPullRequest(repositoryFullName: string, number: number): Promise<GitHubPullRequestRecord | undefined>;
  saveRef(record: GitHubRefRecord): Promise<void>;
  getRef(repositoryFullName: string, ref: string): Promise<GitHubRefRecord | undefined>;
  saveCheckRun(record: GitHubCheckRunRecord): Promise<void>;
  getCheckRunByBuildId(buildId: string): Promise<GitHubCheckRunRecord | undefined>;
}

export class FileGitHubIntegrationStore implements GitHubIntegrationStore {
  constructor(private readonly storageDir: string) {}

  async getWebhookEvent(deliveryId: string): Promise<GitHubWebhookEventRecord | undefined> {
    return this.readOptional(this.path("github", "webhooks", `${safeSegment(deliveryId)}.json`));
  }

  async saveWebhookEvent(record: GitHubWebhookEventRecord): Promise<void> {
    await this.writeJson(this.path("github", "webhooks", `${safeSegment(record.deliveryId)}.json`), record);
  }

  async markWebhookEventProcessed(deliveryId: string, processedAt: string): Promise<void> {
    const existing = await this.getWebhookEvent(deliveryId);
    if (!existing) {
      return;
    }
    await this.saveWebhookEvent({ ...existing, processed: true, processedAt });
  }

  async saveInstallation(record: GitHubInstallationRecord): Promise<void> {
    await this.writeJson(this.path("github", "installations", `${record.installationId}.json`), record);
  }

  async getInstallation(installationId: number): Promise<GitHubInstallationRecord | undefined> {
    return this.readOptional(this.path("github", "installations", `${installationId}.json`));
  }

  async deleteInstallation(installationId: number, deletedAt: string): Promise<void> {
    const existing = await this.getInstallation(installationId);
    if (!existing) {
      await rm(this.path("github", "installations", `${installationId}.json`), { force: true });
      return;
    }
    await this.saveInstallation({ ...existing, repositories: [], deletedAt, updatedAt: deletedAt });
  }

  async savePullRequest(record: GitHubPullRequestRecord): Promise<void> {
    await this.writeJson(this.path("github", "pull-requests", safeSegment(record.repositoryFullName), `${record.number}.json`), record);
  }

  async getPullRequest(repositoryFullName: string, number: number): Promise<GitHubPullRequestRecord | undefined> {
    return this.readOptional(this.path("github", "pull-requests", safeSegment(repositoryFullName), `${number}.json`));
  }

  async saveRef(record: GitHubRefRecord): Promise<void> {
    await this.writeJson(this.path("github", "refs", safeSegment(record.repositoryFullName), `${safeSegment(record.ref)}.json`), record);
  }

  async getRef(repositoryFullName: string, ref: string): Promise<GitHubRefRecord | undefined> {
    return this.readOptional(this.path("github", "refs", safeSegment(repositoryFullName), `${safeSegment(ref)}.json`));
  }

  async saveCheckRun(record: GitHubCheckRunRecord): Promise<void> {
    await this.writeJson(this.path("github", "check-runs", `${safeSegment(record.buildId)}.json`), record);
  }

  async getCheckRunByBuildId(buildId: string): Promise<GitHubCheckRunRecord | undefined> {
    return this.readOptional(this.path("github", "check-runs", `${safeSegment(buildId)}.json`));
  }

  private path(...segments: string[]): string {
    return resolve(this.storageDir, ...segments);
  }

  private async readOptional<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, path);
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "__");
}
