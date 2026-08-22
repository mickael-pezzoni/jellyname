import { parse as pttParse } from "parse-torrent-title";
import type { ParsedEpisode, ParsedMovie } from "./types.ts";

export function parseMovieFilename(fileName: string): ParsedMovie | null {
  const result = pttParse(fileName);
  if (!result.title) return null;

  return {
    kind: "movie",
    title: result.title,
    year: result.year ?? null,
  };
}

export function parseTvEpisodeFilename(fileName: string): ParsedEpisode | null {
  const result = pttParse(fileName);
  if (!result.title || result.episode === undefined) return null;

  return {
    kind: "episode",
    title: result.title,
    year: result.year ?? null,
    season: result.season ?? 1,
    episode: result.episode,
    episodeTitle: null,
  };
}
