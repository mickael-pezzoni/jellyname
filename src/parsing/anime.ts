import anitomyParse from "anitomyscript";
import type { ParsedEpisode } from "./types.ts";

let wasmInitialized = false;

async function ensureWasmInitialized(): Promise<void> {
  if (wasmInitialized) return;

  const realFetch = globalThis.fetch;
  // @ts-expect-error anitomyscript's emscripten loader sees Bun's native `fetch` and tries
  // `fetch(relativeWasmPath)`, which throws (invalid URL). Hiding it for this one-time init
  // forces the loader onto its Node.js fs-based path instead.
  delete globalThis.fetch;
  try {
    await anitomyParse("");
  } finally {
    globalThis.fetch = realFetch;
    wasmInitialized = true;
  }
}

// anitomyscript doesn't recognize every audio/language release tag (notably French-scene ones
// like "MULTi"); when it doesn't, it falls back to classifying the token as the episode title
// instead of dropping it. Filter out the ones we know aren't real episode titles.
const NON_TITLE_TAGS = new Set([
  "multi",
  "multi-audio",
  "vostfr",
  "vf",
  "vff",
  "vfq",
  "vo",
  "dual",
  "dual-audio",
  "subbed",
  "dubbed",
  "truefrench",
]);

// Matches a bit-depth tag once the leading digit is still attached (e.g. "8bits", "10bit") —
// safe to drop, the episode number itself is unaffected.
const BIT_DEPTH_TAG = /^\d{1,2}\s*bits?$/i;
// Matches a bare "bits"/"bit" with the digit missing — a sign anitomy split "8 bits" across
// episode_number/episode_title and mistook the "8" for the episode number itself.
const DANGLING_BIT_DEPTH = /^bits?$/i;

function cleanEpisodeTitle(rawTitle: string | undefined): string | null {
  if (!rawTitle) return null;
  const normalized = rawTitle.trim().toLowerCase();
  if (NON_TITLE_TAGS.has(normalized) || BIT_DEPTH_TAG.test(normalized)) return null;
  return rawTitle;
}

// anitomyscript doesn't always recognize a trailing season marker as such (e.g. "Shakugan no
// Shana S02"), leaving it stuck on anime_title instead of populating anime_season. Besides being
// wrong, the leftover "S02" breaks TMDB's search outright. Strip it and recover the season number
// from it when anime_season itself came back empty.
const TRAILING_SEASON_IN_TITLE = /\s+(?:saison|season)\s*0*(\d{1,3})$|\s+s0*(\d{1,3})$/i;

function stripTrailingSeasonFromTitle(title: string): { title: string; season: number | null } {
  const match = title.match(TRAILING_SEASON_IN_TITLE);
  if (!match) return { title, season: null };
  const season = Number(match[1] ?? match[2]);
  return { title: title.slice(0, match.index).trim(), season };
}

// Some release patterns ("S2.25.FIN(50)") aren't recognized by anitomy as a season/episode
// marker at all — it leaves "S2 25 FIN" stuck on the title and, worse, picks up the parenthesized
// absolute episode number (50) as episode_number instead of the real in-season one (25). This
// pattern is specific and reliable enough to just extract season+episode straight from the title
// text and override whatever anitomy came up with.
const SEASON_EPISODE_IN_TITLE = /\s+s(\d{1,3})[.\s]+(\d{1,3})\b.*$/i;

function extractSeasonEpisodeFromTitle(title: string): { title: string; season: number; episode: number } | null {
  const match = title.match(SEASON_EPISODE_IN_TITLE);
  if (!match) return null;
  return { title: title.slice(0, match.index).trim(), season: Number(match[1]), episode: Number(match[2]) };
}

export async function parseAnimeEpisodeFilename(fileName: string): Promise<ParsedEpisode | null> {
  await ensureWasmInitialized();
  const result = await anitomyParse(fileName);
  const single = Array.isArray(result) ? result[0] : result;

  if (!single?.anime_title) return null;

  // A bare "bits"/"bit" episode_title means the real digit went to episode_number instead
  // (e.g. "... 21 - FHD 8 bits" gets parsed as episode 8, not 21). The episode number can't be
  // trusted here — better to leave the file unparsed than silently rename it into the wrong slot.
  if (single.episode_title && DANGLING_BIT_DEPTH.test(single.episode_title.trim())) {
    return null;
  }

  const titleMatch = extractSeasonEpisodeFromTitle(single.anime_title);

  let title: string;
  let season: number;
  let episode: number;

  if (titleMatch) {
    title = titleMatch.title;
    season = titleMatch.season;
    episode = titleMatch.episode;
  } else {
    if (!single.episode_number) return null;
    episode = Number(single.episode_number);
    if (!Number.isFinite(episode)) return null;

    const stripped = stripTrailingSeasonFromTitle(single.anime_title);
    title = stripped.title;
    season = single.anime_season ? Number(single.anime_season) : (stripped.season ?? 1);
  }

  return {
    kind: "episode",
    title,
    year: single.anime_year ? Number(single.anime_year) : null,
    season,
    episode,
    episodeTitle: cleanEpisodeTitle(single.episode_title),
  };
}
