import { basename } from "node:path";
import type { AggregatedReport } from "../report/reader.ts";
import type { EpisodeItem, ItemStatus, MovieItem, ShowItem } from "../report/types.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).toLowerCase();
}

function statusBadge(status: ItemStatus, error: string | null): string {
  const label = { pending: "pending", done: "done", failed: "failed" }[status];
  const title = error ? ` title="${escapeAttr(error)}"` : "";
  return `<span class="status status-${status}"${title}>${label}</span>`;
}

function renderMovieRow(movie: MovieItem): string {
  const search = escapeAttr(`${movie.title} ${movie.year}`);
  return `
    <div class="row" data-search="${search}">
      ${statusBadge(movie.status, movie.error)}
      <div class="paths">
        <div class="old" title="${escapeAttr(movie.oldPath)}">${escapeHtml(basename(movie.oldPath))}</div>
        <div class="arrow">&rarr;</div>
        <div class="new" title="${escapeAttr(movie.newPath)}">${escapeHtml(basename(movie.newPath))}</div>
      </div>
    </div>`;
}

function renderEpisodeRow(episode: EpisodeItem): string {
  const search = escapeAttr(`S${episode.episode} ${episode.episodeTitle}`);
  return `
    <li class="row" data-search="${search}">
      ${statusBadge(episode.status, episode.error)}
      <div class="paths">
        <div class="old" title="${escapeAttr(episode.oldPath)}">${escapeHtml(basename(episode.oldPath))}</div>
        <div class="arrow">&rarr;</div>
        <div class="new" title="${escapeAttr(episode.newPath)}">${escapeHtml(basename(episode.newPath))}</div>
      </div>
    </li>`;
}

function renderShow(show: ShowItem): string {
  const episodeCount = show.seasons.reduce((n, s) => n + s.episodes.length, 0);
  const search = escapeAttr(`${show.title} ${show.year}`);

  const seasons = show.seasons
    .sort((a, b) => a.season - b.season)
    .map(
      (season) => `
      <details class="season" open>
        <summary>Season ${String(season.season).padStart(2, "0")} &middot; ${season.episodes.length} episode(s)</summary>
        <ul class="episodes">
          ${season.episodes
            .sort((a, b) => a.episode - b.episode)
            .map(renderEpisodeRow)
            .join("")}
        </ul>
      </details>`,
    )
    .join("");

  return `
    <details class="show" data-search="${search}" open>
      <summary>${escapeHtml(show.title)} (${show.year}) &middot; ${episodeCount} episode(s)</summary>
      ${seasons}
    </details>`;
}

interface FailedEntry {
  label: string;
  oldPath: string;
  newPath: string;
  error: string | null;
}

function collectFailedEntries(report: AggregatedReport): FailedEntry[] {
  const entries: FailedEntry[] = [];

  for (const movie of report.movies) {
    if (movie.status === "failed") {
      entries.push({ label: `${movie.title} (${movie.year})`, oldPath: movie.oldPath, newPath: movie.newPath, error: movie.error });
    }
  }

  for (const show of report.shows) {
    for (const season of show.seasons) {
      for (const episode of season.episodes) {
        if (episode.status === "failed") {
          entries.push({
            label: `${show.title} S${String(season.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`,
            oldPath: episode.oldPath,
            newPath: episode.newPath,
            error: episode.error,
          });
        }
      }
    }
  }

  return entries;
}

function renderFailedRow(entry: FailedEntry): string {
  const search = escapeAttr(entry.label);
  return `
    <div class="unmatched-item" data-search="${search}">
      <div class="path">${escapeHtml(entry.label)}</div>
      <div class="paths">
        <div class="old" title="${escapeAttr(entry.oldPath)}">${escapeHtml(basename(entry.oldPath))}</div>
        <div class="arrow">&rarr;</div>
        <div class="new" title="${escapeAttr(entry.newPath)}">${escapeHtml(basename(entry.newPath))}</div>
      </div>
      <div class="meta">${escapeHtml(entry.error ?? "")}</div>
    </div>`;
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
    --card: #f9fafb; --pending: #9ca3af; --done: #16a34a; --failed: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161a; --fg: #e5e7eb; --muted: #9ca3af; --border: #2a2d33; --card: #1c1f24; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; }
  header { margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; }
  .meta { color: var(--muted); font-size: 13px; }
  #search { width: 100%; max-width: 420px; padding: 8px 12px; margin-top: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--fg); font-size: 14px; }
  details.show, details.season { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--card); }
  details.season { margin: 8px 0 8px 16px; }
  summary { cursor: pointer; padding: 10px 12px; font-weight: 600; }
  .movies { display: flex; flex-direction: column; gap: 6px; }
  .row, li.row { display: flex; align-items: center; gap: 10px; padding: 6px 12px; list-style: none; }
  ul.episodes { margin: 0; padding: 0 12px 8px; }
  .paths { display: flex; align-items: center; gap: 8px; overflow: hidden; font-size: 13px; }
  .old { color: var(--muted); text-decoration: line-through; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 38ch; }
  .new { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42ch; }
  .arrow { color: var(--muted); flex-shrink: 0; }
  .status { flex-shrink: 0; font-size: 11px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .03em; }
  .status-pending { background: color-mix(in srgb, var(--pending) 20%, transparent); color: var(--pending); }
  .status-done { background: color-mix(in srgb, var(--done) 20%, transparent); color: var(--done); }
  .status-failed { background: color-mix(in srgb, var(--failed) 20%, transparent); color: var(--failed); }
  .candidate { padding: 2px 0; color: var(--muted); }
  .ambiguous-item, .unmatched-item { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--card); }
  .ambiguous-item .path, .unmatched-item .path { font-weight: 500; margin-bottom: 4px; }
  .hidden { display: none !important; }
  .empty { color: var(--muted); padding: 12px 0; }
  .tabs { display: flex; gap: 4px; margin-top: 16px; border-bottom: 1px solid var(--border); }
  .tab-btn { appearance: none; border: none; background: none; color: var(--muted); font: inherit; font-weight: 600; padding: 8px 14px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab-btn:hover { color: var(--fg); }
  .tab-btn.active { color: var(--fg); border-bottom-color: var(--fg); }
  .tab-panel { display: none; margin-top: 16px; }
  .tab-panel.active { display: block; }
`;

const SEARCH_SCRIPT = `
  const input = document.getElementById("search");
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    document.querySelectorAll("[data-search]").forEach((el) => {
      const match = !query || el.dataset.search.includes(query);
      el.classList.toggle("hidden", !match);
      if (match) {
        let parent = el.closest("details");
        while (parent) {
          parent.open = true;
          parent = parent.parentElement ? parent.parentElement.closest("details") : null;
        }
      }
    });
  });
`;

const TABS_SCRIPT = `
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });
`;

export function renderReportHtml(report: AggregatedReport): string {
  const episodeCount = report.shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0);
  const matchedCount = report.movies.length + episodeCount;

  const matchedSection =
    report.type === "movie"
      ? report.movies.length
        ? `<div class="movies">${report.movies.map(renderMovieRow).join("")}</div>`
        : `<div class="empty">No movies identified.</div>`
      : report.shows.length
        ? report.shows.sort((a, b) => a.title.localeCompare(b.title)).map(renderShow).join("")
        : `<div class="empty">No shows identified.</div>`;

  const ambiguousSection = report.ambiguous.length
    ? report.ambiguous
        .map(
          (item) => `
      <div class="ambiguous-item">
        <div class="path" title="${escapeAttr(item.oldPath)}">${escapeHtml(basename(item.oldPath))}</div>
        ${item.candidates
          .map(
            (c) =>
              `<div class="candidate">#${c.tmdbId} &middot; ${escapeHtml(c.title)} (${c.year}) &middot; score ${c.score}</div>`,
          )
          .join("")}
      </div>`,
        )
        .join("")
    : `<div class="empty">No ambiguous items.</div>`;

  const unmatchedSection = report.unmatched.length
    ? report.unmatched
        .map(
          (item) => `
      <div class="unmatched-item">
        <div class="path" title="${escapeAttr(item.oldPath)}">${escapeHtml(basename(item.oldPath))}</div>
        <div class="meta">${escapeHtml(item.reason)}</div>
      </div>`,
        )
        .join("")
    : `<div class="empty">No unmatched files.</div>`;

  const failedEntries = collectFailedEntries(report);
  const failedSection = failedEntries.length
    ? failedEntries.map(renderFailedRow).join("")
    : `<div class="empty">No failed items.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>jellyname — report</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>jellyname report</h1>
  <div class="meta">Type: ${report.type} &middot; generated on ${escapeHtml(report.generatedAt)}</div>
  <input id="search" type="text" placeholder="Filter by title...">
  <div class="tabs">
    <button class="tab-btn active" data-tab="matched">Identified (${matchedCount})</button>
    <button class="tab-btn" data-tab="ambiguous">Ambiguous (${report.ambiguous.length})</button>
    <button class="tab-btn" data-tab="unmatched">Unmatched (${report.unmatched.length})</button>
    <button class="tab-btn" data-tab="failed">Failed (${failedEntries.length})</button>
  </div>
</header>
<div id="tab-matched" class="tab-panel active">${matchedSection}</div>
<div id="tab-ambiguous" class="tab-panel">${ambiguousSection}</div>
<div id="tab-unmatched" class="tab-panel">${unmatchedSection}</div>
<div id="tab-failed" class="tab-panel">${failedSection}</div>
<script>${SEARCH_SCRIPT}${TABS_SCRIPT}</script>
</body>
</html>`;
}
