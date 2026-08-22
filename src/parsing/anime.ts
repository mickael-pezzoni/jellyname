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

function cleanEpisodeTitle(rawTitle: string | undefined): string | null {
  if (!rawTitle) return null;
  return NON_TITLE_TAGS.has(rawTitle.trim().toLowerCase()) ? null : rawTitle;
}

export async function parseAnimeEpisodeFilename(fileName: string): Promise<ParsedEpisode | null> {
  await ensureWasmInitialized();
  const result = await anitomyParse(fileName);
  const single = Array.isArray(result) ? result[0] : result;

  if (!single?.anime_title || !single.episode_number) return null;

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
