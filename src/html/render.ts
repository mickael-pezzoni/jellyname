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
  const label = { pending: "en attente", done: "fait", failed: "échec" }[status];
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
        <summary>Season ${String(season.season).padStart(2, "0")} &middot; ${season.episodes.length} épisode(s)</summary>
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
      <summary>${escapeHtml(show.title)} (${show.year}) &middot; ${episodeCount} épisode(s)</summary>
      ${seasons}
    </details>`;
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

export function renderReportHtml(report: AggregatedReport): string {
  const episodeCount = report.shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0);
  const matchedCount = report.movies.length + episodeCount;

  const matchedSection =
    report.type === "movie"
      ? `<div class="movies">${report.movies.map(renderMovieRow).join("")}</div>`
      : report.shows.sort((a, b) => a.title.localeCompare(b.title)).map(renderShow).join("");

  const ambiguousSection = report.ambiguous.length
    ? `<h2>Ambigus (${report.ambiguous.length})</h2>` +
      report.ambiguous
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
    : "";

  const unmatchedSection = report.unmatched.length
    ? `<h2>Non identifiés (${report.unmatched.length})</h2>` +
      report.unmatched
        .map(
          (item) => `
      <div class="unmatched-item">
        <div class="path" title="${escapeAttr(item.oldPath)}">${escapeHtml(basename(item.oldPath))}</div>
        <div class="meta">${escapeHtml(item.reason)}</div>
      </div>`,
        )
        .join("")
    : "";

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>jellyname — rapport</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Rapport jellyname</h1>
  <div class="meta">Type: ${report.type} &middot; généré le ${escapeHtml(report.generatedAt)} &middot; ${matchedCount} identifié(s), ${report.ambiguous.length} ambigu(s), ${report.unmatched.length} non identifié(s)</div>
  <input id="search" type="text" placeholder="Filtrer par titre...">
</header>
<section>${matchedSection}</section>
<section>${ambiguousSection}</section>
<section>${unmatchedSection}</section>
<script>${SEARCH_SCRIPT}</script>
</body>
</html>`;
}
