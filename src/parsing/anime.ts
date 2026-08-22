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
    episodeTitle: single.episode_title ?? null,
  };
}
