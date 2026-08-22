import type { MediaType } from "../report/types.ts";
import { parseAnimeEpisodeFilename } from "./anime.ts";
import { parseMovieFilename, parseTvEpisodeFilename } from "./movieTv.ts";
import type { ParsedFile } from "./types.ts";

export async function parseFile(fileName: string, type: MediaType): Promise<ParsedFile | null> {
  switch (type) {
    case "movie":
      return parseMovieFilename(fileName);
    case "tv":
      return parseTvEpisodeFilename(fileName);
    case "anime":
      return parseAnimeEpisodeFilename(fileName);
  }
}

export type { ParsedEpisode, ParsedFile, ParsedMovie } from "./types.ts";
