import type {
  BaselineBranchInput,
  BaselineLookupInput,
  BaselineRecord,
  BaselineStore,
  ComparisonReport,
  ComparisonReportListInput,
  ComparisonStore,
  AuditEvent,
  AuditEventListInput,
  ReviewDecision,
  ReviewDecisionListInput,
  ReviewStore,
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

  async listComparisonReports(input: ComparisonReportListInput = {}): Promise<ComparisonReport[]> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    const query = params.size ? `?${params}` : "";
    const response = await this.fetchImpl(`${this.baseUrl}/v1/reports${query}`, {
      headers: await requestHeaders(this.headers),
    });
    if (!response.ok) {
      throw new Error(`Comparison report list failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { reports?: ComparisonReport[] };
    return body.reports ?? [];
  }
}

export class ApiReviewStore implements ReviewStore {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly headers?: HeaderProvider,
  ) {}

  async saveReviewDecision(_decision: ReviewDecision): Promise<void> {
    throw new Error("Review decisions must be created through the API review endpoint so repository permissions are checked.");
  }

  async listReviewDecisions(input: ReviewDecisionListInput = {}): Promise<ReviewDecision[]> {
    const params = new URLSearchParams();
    if (input.buildId) {
      params.set("buildId", input.buildId);
    }
    if (input.identityKey) {
      params.set("identityKey", input.identityKey);
    }
    if (input.state) {
      params.set("state", input.state);
    }
    const query = params.size ? `?${params}` : "";
    const response = await this.fetchImpl(`${this.baseUrl}/v1/review-decisions${query}`, {
      headers: await requestHeaders(this.headers),
    });
    if (!response.ok) {
      throw new Error(`Review decision list failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { decisions?: ReviewDecision[] };
    return body.decisions ?? [];
  }

  async getLatestReviewDecision(input: ReviewDecisionListInput): Promise<ReviewDecision | undefined> {
    const decisions = await this.listReviewDecisions(input);
    return decisions.at(-1);
  }

  async saveAuditEvent(event: AuditEvent): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/audit-events`, {
      method: "POST",
      headers: await jsonHeaders(this.headers),
      body: JSON.stringify({ event }),
    });
    if (!response.ok) {
      throw new Error(`Audit event upload failed with ${response.status}: ${await response.text()}`);
    }
  }

  async listAuditEvents(input: AuditEventListInput = {}): Promise<AuditEvent[]> {
    const params = new URLSearchParams();
    if (input.repositoryFullName) {
      params.set("repositoryFullName", input.repositoryFullName);
    }
    if (input.buildId) {
      params.set("buildId", input.buildId);
    }
    if (input.identityKey) {
      params.set("identityKey", input.identityKey);
    }
    if (input.eventType) {
      params.set("eventType", input.eventType);
    }
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    const query = params.size ? `?${params}` : "";
    const response = await this.fetchImpl(`${this.baseUrl}/v1/audit-events${query}`, {
      headers: await requestHeaders(this.headers),
    });
    if (!response.ok) {
      throw new Error(`Audit event list failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { auditEvents?: AuditEvent[] };
    return body.auditEvents ?? [];
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
