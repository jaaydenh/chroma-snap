import type { AuditEvent, ComparisonReport, ComparisonStatus, ReviewDecision, SnapshotComparison } from "@chroma-snap/shared";

const STATUS_ORDER: ComparisonStatus[] = ["changed", "new", "deleted", "errored", "pending", "unchanged"];
const REVIEWABLE_STATUSES = new Set<ComparisonStatus>(["changed", "new", "deleted"]);

export interface RenderReportHtmlOptions {
  decisions?: ReviewDecision[];
  auditEvents?: AuditEvent[];
  artifactUrls?: Record<string, string | { url: string; expiresAt?: string }>;
  decisionEndpoint?: string;
  devReviewer?: {
    githubLogin: string;
    githubUserId?: number;
    repositoryPermission: "write" | "maintain" | "admin";
  };
}

interface RenderableArtifact {
  path?: string;
  imagePath?: string;
  objectKey?: string;
}

export function renderReportHtml(report: ComparisonReport, options: RenderReportHtmlOptions = {}): string {
  const decisions = latestDecisionMap(options.decisions ?? []);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chroma Snap report ${escapeHtml(report.buildId)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0f172a; color: #e2e8f0; }
    a { color: #93c5fd; }
    header { padding: 2rem; background: #111827; border-bottom: 1px solid #334155; }
    main { padding: 1.5rem 2rem 3rem; }
    .summary { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
    .pill { border: 1px solid #475569; border-radius: 999px; padding: .35rem .75rem; background: #1e293b; }
    .pill.approved { border-color: #22c55e; color: #bbf7d0; }
    .pill.rejected { border-color: #ef4444; color: #fecaca; }
    .workflow { background: #172033; border: 1px solid #334155; border-radius: .75rem; padding: 1rem; margin-top: 1rem; }
    .warning { border-left: 4px solid #f59e0b; padding-left: .75rem; color: #fde68a; }
    section { margin-top: 2rem; }
    h2 { text-transform: capitalize; }
    article { border: 1px solid #334155; border-radius: .75rem; margin: 1rem 0; padding: 1rem; background: #111827; }
    article:target { outline: 3px solid #38bdf8; }
    .meta { color: #94a3b8; font-size: .875rem; line-height: 1.6; }
    .details { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .5rem 1rem; margin: .75rem 0; }
    .message { white-space: pre-wrap; background: #020617; border: 1px solid #475569; padding: .75rem; border-radius: .5rem; overflow-x: auto; font-size: .8rem; line-height: 1.45; }
    .images { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .image-frame { max-height: 70vh; overflow: auto; border: 1px solid #475569; background: #020617; }
    figure { margin: 0; }
    figcaption { color: #cbd5e1; margin-bottom: .35rem; display: flex; justify-content: space-between; gap: .75rem; }
    img { max-width: 100%; background: #020617; image-rendering: auto; }
    code { background: #020617; border: 1px solid #334155; padding: .1rem .3rem; border-radius: .25rem; }
    .decision { border: 1px solid #334155; border-radius: .5rem; padding: .75rem; margin: .75rem 0; background: #0b1120; }
    .decision form { display: inline-flex; gap: .5rem; flex-wrap: wrap; margin-top: .5rem; }
    .decision button { border: 0; border-radius: .4rem; padding: .45rem .75rem; font-weight: 700; cursor: pointer; }
    .decision button[value="approved"] { background: #16a34a; color: white; }
    .decision button[value="rejected"] { background: #dc2626; color: white; }
    .audit { border-top: 1px solid #334155; margin-top: .75rem; padding-top: .75rem; }
    .audit li { margin: .25rem 0; }
  </style>
</head>
<body>
  <header>
    <h1>Chroma Snap visual review</h1>
    <p>Build <code>${escapeHtml(report.buildId)}</code> on <code>${escapeHtml(report.headBranch)}</code> against <code>${escapeHtml(report.baseBranch)}</code>.</p>
    <p>Check conclusion: <strong>${escapeHtml(report.checkConclusion)}</strong></p>
    <div class="workflow"><strong>Workflow:</strong> changed, new, and deleted snapshots require authorized review. Approved PR snapshots promote only after the approved commit lands on <code>${escapeHtml(report.baseBranch)}</code> and a base-branch run confirms them.</div>
    <div class="summary">${STATUS_ORDER.map((status) => `<span class="pill">${status}: ${report.summary[status] ?? 0}</span>`).join("")}${renderDecisionSummary(decisions)}</div>
    ${report.warnings.length ? `<div class="warning"><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
  </header>
  <main>
    ${STATUS_ORDER.map((status) => renderStatusSection(status, report.comparisons.filter((comparison) => comparison.status === status), options, decisions)).join("\n")}
  </main>
</body>
</html>`;
}

export function renderReportListHtml(reports: ComparisonReport[]): string {
  const sortedReports = [...reports].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chroma Snap reports</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0f172a; color: #e2e8f0; }
    main { padding: 2rem; }
    table { width: 100%; border-collapse: collapse; background: #111827; border: 1px solid #334155; }
    th, td { text-align: left; padding: .75rem; border-bottom: 1px solid #334155; }
    a { color: #93c5fd; }
    code { background: #020617; border: 1px solid #334155; padding: .1rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <main>
    <h1>Chroma Snap reports</h1>
    ${sortedReports.length ? `<table><thead><tr><th>Build</th><th>Head</th><th>Base</th><th>Conclusion</th><th>Generated</th><th>Changed/New/Deleted</th></tr></thead><tbody>${sortedReports.map(renderReportListRow).join("")}</tbody></table>` : "<p>No reports have been generated yet.</p>"}
  </main>
</body>
</html>`;
}

function renderReportListRow(report: ComparisonReport): string {
  const reviewable = report.summary.changed + report.summary.new + report.summary.deleted;
  return `<tr><td><a href="/report?buildId=${encodeURIComponent(report.buildId)}"><code>${escapeHtml(report.buildId)}</code></a></td><td>${escapeHtml(report.headBranch)}</td><td>${escapeHtml(report.baseBranch)}</td><td>${escapeHtml(report.checkConclusion)}</td><td>${escapeHtml(report.generatedAt)}</td><td>${reviewable}</td></tr>`;
}

function renderDecisionSummary(decisions: Map<string, ReviewDecision>): string {
  const counts = { approved: 0, rejected: 0 };
  for (const decision of decisions.values()) {
    counts[decision.state] += 1;
  }
  return `<span class="pill approved">approved: ${counts.approved}</span><span class="pill rejected">rejected: ${counts.rejected}</span>`;
}

function renderStatusSection(
  status: ComparisonStatus,
  comparisons: SnapshotComparison[],
  options: RenderReportHtmlOptions,
  decisions: Map<string, ReviewDecision>,
): string {
  if (!comparisons.length) {
    return "";
  }
  return `<section><h2>${escapeHtml(status)} (${comparisons.length})</h2>${comparisons.map((comparison) => renderComparison(comparison, options, decisions)).join("\n")}</section>`;
}

function renderComparison(comparison: SnapshotComparison, options: RenderReportHtmlOptions, decisions: Map<string, ReviewDecision>): string {
  const storyName = comparison.story?.title && comparison.story.name ? `${comparison.story.title} / ${comparison.story.name}` : comparison.story?.id ?? comparison.identityKey;
  const decision = comparison.reviewDecision ?? decisions.get(comparison.identityKey);
  const auditEvents = (options.auditEvents ?? []).filter((event) => event.identityKey === comparison.identityKey);
  return `<article id="snapshot-${escapeAttribute(comparison.identityKey)}">
    <h3>${escapeHtml(storyName)}</h3>
    <p class="meta">identity <code>${escapeHtml(comparison.identityKey)}</code> · mode <code>${escapeHtml(comparison.mode?.name ?? "unknown")}</code> · ${comparison.requiresApproval ? "requires approval" : "no approval required"}</p>
    ${renderDecisionControls(comparison, decision, options)}
    <div class="details">
      ${renderDetail("Story ID", comparison.story?.id)}
      ${renderDetail("Viewport", comparison.mode ? `${comparison.mode.viewport.width}×${comparison.mode.viewport.height}@${comparison.mode.viewport.deviceScaleFactor ?? 1}` : undefined)}
      ${renderDetail("Theme", comparison.mode?.theme)}
      ${renderDetail("Globals", comparison.mode?.globals && Object.keys(comparison.mode.globals).length ? JSON.stringify(comparison.mode.globals) : undefined)}
      ${comparison.diff ? renderDetail("Diff", `${comparison.diff.stats.diffPixels} / ${comparison.diff.stats.totalPixels} pixels (${(comparison.diff.stats.diffPixelRatio * 100).toFixed(4)}%)`) : ""}
    </div>
    ${comparison.message ? `<pre class="message">${escapeHtml(comparison.message)}</pre>` : ""}
    <div class="images">
      ${renderImage("Baseline", comparison.baseline, options)}
      ${renderImage("Current", comparison.current?.image, options)}
      ${renderImage("Diff", comparison.diff, options)}
    </div>
    ${auditEvents.length ? renderAuditEvents(auditEvents) : ""}
  </article>`;
}

function renderDecisionControls(comparison: SnapshotComparison, decision: ReviewDecision | undefined, options: RenderReportHtmlOptions): string {
  const latest = decision
    ? `<p>Latest decision: <strong>${escapeHtml(decision.state)}</strong> by <code>${escapeHtml(decision.user.login)}</code> at <code>${escapeHtml(decision.createdAt)}</code>${decision.previousState ? `, previously ${escapeHtml(decision.previousState)}` : ""}.</p>`
    : "<p>No review decision yet.</p>";
  if (!REVIEWABLE_STATUSES.has(comparison.status)) {
    return `<div class="decision">${latest}<p class="meta">This status is not approvable as a visual change.</p></div>`;
  }
  if (!options.decisionEndpoint) {
    return `<div class="decision">${latest}<p class="meta">Approval controls are available when the hosted API decision endpoint is configured.</p></div>`;
  }
  return `<div class="decision">${latest}
    <form method="post" action="${escapeAttribute(options.decisionEndpoint)}">
      <input type="hidden" name="identityKey" value="${escapeAttribute(comparison.identityKey)}" />
      ${renderDevReviewerInputs(options)}
      <button type="submit" name="state" value="approved">Approve</button>
      <button type="submit" name="state" value="rejected">Reject</button>
    </form>
  </div>`;
}

function renderDevReviewerInputs(options: RenderReportHtmlOptions): string {
  if (!options.devReviewer) {
    return "";
  }
  const reviewer = options.devReviewer;
  return [
    `<input type="hidden" name="githubLogin" value="${escapeAttribute(reviewer.githubLogin)}" />`,
    reviewer.githubUserId === undefined ? "" : `<input type="hidden" name="githubUserId" value="${reviewer.githubUserId}" />`,
    `<input type="hidden" name="repositoryPermission" value="${escapeAttribute(reviewer.repositoryPermission)}" />`,
  ].join("");
}

function renderAuditEvents(events: AuditEvent[]): string {
  return `<div class="audit"><strong>Audit log</strong><ul>${events
    .map((event) => `<li><code>${escapeHtml(event.createdAt)}</code> ${escapeHtml(event.eventType)} by ${escapeHtml(event.actor?.login ?? "system")}</li>`)
    .join("")}</ul></div>`;
}

function renderDetail(label: string, value?: string): string {
  if (!value) {
    return "";
  }
  return `<div><span class="meta">${escapeHtml(label)}</span><br><code>${escapeHtml(value)}</code></div>`;
}

function renderImage(label: string, artifact: RenderableArtifact | undefined, options: RenderReportHtmlOptions): string {
  const url = artifactUrl(artifact, options);
  if (!url) {
    return "";
  }
  return `<figure><figcaption><span>${escapeHtml(label)}</span><a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">open</a></figcaption><div class="image-frame"><img src="${escapeAttribute(url)}" alt="${escapeAttribute(label)}" loading="lazy" /></div></figure>`;
}

function artifactUrl(artifact: RenderableArtifact | undefined, options: RenderReportHtmlOptions): string | undefined {
  if (!artifact) {
    return undefined;
  }
  if (artifact.objectKey) {
    const signed = options.artifactUrls?.[artifact.objectKey];
    if (typeof signed === "string") {
      return signed;
    }
    if (signed?.url) {
      return signed.url;
    }
  }
  const path = artifact.path ?? artifact.imagePath;
  if (!path) {
    return undefined;
  }
  if (/^(?:https?:|data:)/.test(path) || path.startsWith("/artifact?")) {
    return path;
  }
  return `/artifact?path=${encodeURIComponent(path)}`;
}

function latestDecisionMap(decisions: ReviewDecision[]): Map<string, ReviewDecision> {
  const latest = new Map<string, ReviewDecision>();
  for (const decision of decisions) {
    const existing = latest.get(decision.identityKey);
    if (!existing || Date.parse(existing.createdAt) <= Date.parse(decision.createdAt)) {
      latest.set(decision.identityKey, decision);
    }
  }
  return latest;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
