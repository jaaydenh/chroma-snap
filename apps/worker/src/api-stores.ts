import type {
  BaselineBranchInput,
  BaselineLookupInput,
  BaselineRecord,
  BaselineStore,
  ComparisonReport,
  ComparisonStore,
} from "@chroma-snap/shared";

type HeaderProvider = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export class ApiBaselineStore implements BaselineStore {
  constructor(
    private readonly baseUrl: string,
    private readonly buildId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly headers?: HeaderProvider,
  ) {}

  async lookupBaseline(input: BaselineLookupInput): Promise<BaselineRecord | undefined> {
    const params = new URLSearchParams({ branch: input.branch, identityKey: input.identityKey });
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(this.buildId)}/baselines?${params}`, {
      headers: await requestHeaders(this.headers),
    });
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
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(this.buildId)}/baselines?${params}`, {
      headers: await requestHeaders(this.headers),
    });
    if (!response.ok) {
      throw new Error(`Baseline list failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { baselines?: BaselineRecord[] };
    return body.baselines ?? [];
  }

  async promoteBaseline(record: BaselineRecord): Promise<void> {
    await this.promoteBaselines([record]);
  }

  async promoteBaselines(records: BaselineRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1/baselines`, {
      method: "PUT",
      headers: await jsonHeaders(this.headers),
      body: JSON.stringify({ baselines: records }),
    });
    if (!response.ok) {
      throw new Error(`Baseline promotion failed with ${response.status}: ${await response.text()}`);
    }
  }

  async deleteBaseline(input: BaselineLookupInput): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/baselines`, {
      method: "DELETE",
      headers: await jsonHeaders(this.headers),
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
    private readonly headers?: HeaderProvider,
  ) {}

  async saveComparisonReport(report: ComparisonReport): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(report.buildId)}/comparison-report`, {
      method: "PUT",
      headers: await jsonHeaders(this.headers),
      body: JSON.stringify({ report }),
    });
    if (!response.ok) {
      throw new Error(`Comparison report upload failed with ${response.status}: ${await response.text()}`);
    }
  }

  async getComparisonReport(buildId: string): Promise<ComparisonReport | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/builds/${encodeURIComponent(buildId)}/comparison-report`, {
      headers: await requestHeaders(this.headers),
    });
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

async function requestHeaders(provider: HeaderProvider | undefined): Promise<Headers> {
  return new Headers(typeof provider === "function" ? await provider() : provider);
}

async function jsonHeaders(provider: HeaderProvider | undefined): Promise<Headers> {
  const headers = await requestHeaders(provider);
  headers.set("content-type", "application/json");
  return headers;
}
