import type {
  BaselineBranchInput,
  BaselineLookupInput,
  BaselineRecord,
  BaselineStore,
  ComparisonReport,
  ComparisonStore,
} from "@chroma-snap/shared";

export class ApiBaselineStore implements BaselineStore {
  constructor(
    private readonly baseUrl: string,
    private readonly buildId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookupBaseline(input: BaselineLookupInput): Promise<BaselineRecord | undefined> {
    const params = new URLSearchParams({ branch: input.branch, identityKey: input.identityKey });
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(this.buildId)}/baselines?${params}`);
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Baseline lookup failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { baseline?: BaselineRecord };
    return body.baseline;
  }

  async listBaselinesForBranch(input: BaselineBranchInput): Promise<BaselineRecord[]> {
    const params = new URLSearchParams({ branch: input.branch });
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(this.buildId)}/baselines?${params}`);
    if (!response.ok) {
      throw new Error(`Baseline list failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { baselines?: BaselineRecord[] };
    return body.baselines ?? [];
  }

  async promoteBaseline(record: BaselineRecord): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/baselines`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseline: record }),
    });
    if (!response.ok) {
      throw new Error(`Baseline promotion failed with ${response.status}: ${await response.text()}`);
    }
  }

  async deleteBaseline(input: BaselineLookupInput): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/baselines`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Baseline deletion failed with ${response.status}: ${await response.text()}`);
    }
  }
}

export class ApiComparisonStore implements ComparisonStore {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async saveComparisonReport(report: ComparisonReport): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(report.buildId)}/comparison-report`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report }),
    });
    if (!response.ok) {
      throw new Error(`Comparison report upload failed with ${response.status}: ${await response.text()}`);
    }
  }

  async getComparisonReport(buildId: string): Promise<ComparisonReport | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(buildId)}/comparison-report`);
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Comparison report fetch failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { report?: ComparisonReport };
    return body.report;
  }
}
