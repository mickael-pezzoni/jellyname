import { parse as pttParse } from "parse-torrent-title";
import type { ParsedEpisode, ParsedMovie } from "./types.ts";

// parse-torrent-title correctly extracts season/episode from a leading "S03E10 ..." filename, but
// leaves that same code stuck on the title field too (e.g. "S03E10 SG-1 Le jour sans fin") instead
// of stripping it — applies to any show named this way, not a specific title.
const LEADING_SEASON_EPISODE = /^s\d{1,3}e\d{1,4}\s*/i;

function stripLeadingSeasonEpisode(title: string): string {
  return title.replace(LEADING_SEASON_EPISODE, "").trim();
}

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

  const title = stripLeadingSeasonEpisode(result.title);
  if (!title) return null;

  return {
    kind: "episode",
    title,
    year: result.year ?? null,
    season: result.season ?? 1,
    episode: result.episode,
    episodeTitle: null,
  };
}
