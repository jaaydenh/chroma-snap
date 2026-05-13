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
    section { margin-top: 2rem; }
    h2 { text-transform: capitalize; }
    article { border: 1px solid #334155; border-radius: .75rem; margin: 1rem 0; padding: 1rem; background: #111827; }
    .meta { color: #94a3b8; font-size: .875rem; }
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
    <div class="summary">${STATUS_ORDER.map((status) => `<span class="pill">${status}: ${report.summary[status] ?? 0}</span>`).join("")}</div>
    ${report.warnings.length ? `<ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
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
    ${comparison.message ? `<p>${escapeHtml(comparison.message)}</p>` : ""}
    ${comparison.diff ? `<p>Diff pixels: ${comparison.diff.stats.diffPixels} / ${comparison.diff.stats.totalPixels} (${(comparison.diff.stats.diffPixelRatio * 100).toFixed(4)}%)</p>` : ""}
    <div class="images">
      ${renderImage("Baseline", comparison.baseline?.imagePath)}
      ${renderImage("Current", comparison.current?.image?.path)}
      ${renderImage("Diff", comparison.diff?.path)}
    </div>
  </article>`;
}

function renderImage(label: string, path?: string): string {
  if (!path) {
    return "";
  }
  return `<figure><figcaption>${escapeHtml(label)}</figcaption><img src="${escapeAttribute(path)}" alt="${escapeAttribute(label)}" loading="lazy" /></figure>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
