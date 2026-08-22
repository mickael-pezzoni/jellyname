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

export async function parseAnimeEpisodeFilename(fileName: string): Promise<ParsedEpisode | null> {
  await ensureWasmInitialized();
  const result = await anitomyParse(fileName);
  const single = Array.isArray(result) ? result[0] : result;

  if (!single?.anime_title || !single.episode_number) return null;

  // A bare "bits"/"bit" episode_title means the real digit went to episode_number instead
  // (e.g. "... 21 - FHD 8 bits" gets parsed as episode 8, not 21). The episode number can't be
  // trusted here — better to leave the file unparsed than silently rename it into the wrong slot.
  if (single.episode_title && DANGLING_BIT_DEPTH.test(single.episode_title.trim())) {
    return null;
  }

  const episode = Number(single.episode_number);
  if (!Number.isFinite(episode)) return null;

  return {
    kind: "episode",
    title: single.anime_title,
    year: single.anime_year ? Number(single.anime_year) : null,
    season: single.anime_season ? Number(single.anime_season) : 1,
    episode,
    episodeTitle: cleanEpisodeTitle(single.episode_title),
  };
}
