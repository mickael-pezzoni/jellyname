import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AmbiguousItem, Manifest, MediaType, MovieItem, Part, ShowItem, UnmatchedItem } from "./types.ts";

export interface AggregatedReport {
  type: MediaType;
  generatedAt: string;
  movies: MovieItem[];
  shows: ShowItem[];
  ambiguous: AmbiguousItem[];
  unmatched: UnmatchedItem[];
}

export async function readReport(manifestPath: string): Promise<AggregatedReport> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Manifest;
  const dir = dirname(manifestPath);

  const movies: MovieItem[] = [];
  const shows: ShowItem[] = [];

  for (const partName of manifest.parts) {
    const part = JSON.parse(await readFile(join(dir, partName), "utf-8")) as Part;
    if (part.movies) movies.push(...part.movies);
    if (part.shows) shows.push(...part.shows);
  }

  return {
    type: manifest.type,
    generatedAt: manifest.generatedAt,
    movies,
    shows,
    ambiguous: manifest.ambiguous,
    unmatched: manifest.unmatched,
  };
}
