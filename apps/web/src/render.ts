import type { ComparisonReport, ComparisonStatus, SnapshotComparison } from "@chroma-snap/shared";

const STATUS_ORDER: ComparisonStatus[] = ["changed", "new", "deleted", "errored", "pending", "unchanged"];

export function renderReportHtml(report: ComparisonReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chroma Snap report ${escapeHtml(report.buildId)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0f172a; color: #e2e8f0; }
    header { padding: 2rem; background: #111827; border-bottom: 1px solid #334155; }
    main { padding: 1.5rem 2rem 3rem; }
    .summary { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
    .pill { border: 1px solid #475569; border-radius: 999px; padding: .35rem .75rem; background: #1e293b; }
    .workflow { background: #172033; border: 1px solid #334155; border-radius: .75rem; padding: 1rem; margin-top: 1rem; }
    .warning { border-left: 4px solid #f59e0b; padding-left: .75rem; color: #fde68a; }
    section { margin-top: 2rem; }
    h2 { text-transform: capitalize; }
    article { border: 1px solid #334155; border-radius: .75rem; margin: 1rem 0; padding: 1rem; background: #111827; }
    .meta { color: #94a3b8; font-size: .875rem; line-height: 1.6; }
    .details { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .5rem 1rem; margin: .75rem 0; }
    .message { white-space: pre-wrap; background: #020617; border: 1px solid #475569; padding: .75rem; border-radius: .5rem; overflow-x: auto; font-size: .8rem; line-height: 1.45; }
    .images { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-top: 1rem; }
    figure { margin: 0; }
    figcaption { color: #cbd5e1; margin-bottom: .35rem; }
    img { max-width: 100%; border: 1px solid #475569; background: #020617; }
    code { background: #020617; border: 1px solid #334155; padding: .1rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <header>
    <h1>Chroma Snap visual review</h1>
    <p>Build <code>${escapeHtml(report.buildId)}</code> on <code>${escapeHtml(report.headBranch)}</code> against <code>${escapeHtml(report.baseBranch)}</code>.</p>
    <p>Check conclusion: <strong>${escapeHtml(report.checkConclusion)}</strong></p>
    <div class="workflow"><strong>Workflow:</strong> changed, new, and deleted snapshots require authorized review. Approved PR snapshots promote only after the approved commit lands on <code>${escapeHtml(report.baseBranch)}</code> and a base-branch run confirms them.</div>
    <div class="summary">${STATUS_ORDER.map((status) => `<span class="pill">${status}: ${report.summary[status] ?? 0}</span>`).join("")}</div>
    ${report.warnings.length ? `<div class="warning"><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
  </header>
  <main>
    ${STATUS_ORDER.map((status) => renderStatusSection(status, report.comparisons.filter((comparison) => comparison.status === status))).join("\n")}
  </main>
</body>
</html>`;
}

function renderStatusSection(status: ComparisonStatus, comparisons: SnapshotComparison[]): string {
  if (!comparisons.length) {
    return "";
  }
  return `<section><h2>${escapeHtml(status)} (${comparisons.length})</h2>${comparisons.map(renderComparison).join("\n")}</section>`;
}

function renderComparison(comparison: SnapshotComparison): string {
  const storyName = comparison.story?.title && comparison.story.name ? `${comparison.story.title} / ${comparison.story.name}` : comparison.story?.id ?? comparison.identityKey;
  return `<article>
    <h3>${escapeHtml(storyName)}</h3>
    <p class="meta">identity <code>${escapeHtml(comparison.identityKey)}</code> · mode <code>${escapeHtml(comparison.mode?.name ?? "unknown")}</code> · ${comparison.requiresApproval ? "requires approval" : "no approval required"}</p>
    <div class="details">
      ${renderDetail("Story ID", comparison.story?.id)}
      ${renderDetail("Viewport", comparison.mode ? `${comparison.mode.viewport.width}×${comparison.mode.viewport.height}@${comparison.mode.viewport.deviceScaleFactor ?? 1}` : undefined)}
      ${renderDetail("Theme", comparison.mode?.theme)}
      ${renderDetail("Globals", comparison.mode?.globals && Object.keys(comparison.mode.globals).length ? JSON.stringify(comparison.mode.globals) : undefined)}
      ${comparison.diff ? renderDetail("Diff", `${comparison.diff.stats.diffPixels} / ${comparison.diff.stats.totalPixels} pixels (${(comparison.diff.stats.diffPixelRatio * 100).toFixed(4)}%)`) : ""}
    </div>
    ${comparison.message ? `<pre class="message">${escapeHtml(comparison.message)}</pre>` : ""}
    <div class="images">
      ${renderImage("Baseline", comparison.baseline?.imagePath)}
      ${renderImage("Current", comparison.current?.image?.path)}
      ${renderImage("Diff", comparison.diff?.path)}
    </div>
  </article>`;
}

function renderDetail(label: string, value?: string): string {
  if (!value) {
    return "";
  }
  return `<div><span class="meta">${escapeHtml(label)}</span><br><code>${escapeHtml(value)}</code></div>`;
}

function renderImage(label: string, path?: string): string {
  if (!path) {
    return "";
  }
  return `<figure><figcaption>${escapeHtml(label)}</figcaption><img src="${escapeAttribute(artifactUrl(path))}" alt="${escapeAttribute(label)}" loading="lazy" /></figure>`;
}

function artifactUrl(path: string): string {
  if (/^(?:https?:|data:)/.test(path) || path.startsWith("/artifact?")) {
    return path;
  }
  return `/artifact?path=${encodeURIComponent(path)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
