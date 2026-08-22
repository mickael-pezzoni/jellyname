import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AmbiguousItem,
  Manifest,
  MediaType,
  MovieItem,
  Part,
  ShowItem,
  UnmatchedItem,
} from "./types.ts";

const MAX_PART_BYTES = 5 * 1024 * 1024;

export interface ReportData {
  type: MediaType;
  movies: MovieItem[];
  shows: ShowItem[];
  ambiguous: AmbiguousItem[];
  unmatched: UnmatchedItem[];
}

function splitIntoParts(items: (MovieItem | ShowItem)[], type: MediaType, maxBytes: number): Part[] {
  const toPart = (chunk: (MovieItem | ShowItem)[]): Part =>
    type === "movie" ? { movies: chunk as MovieItem[] } : { shows: chunk as ShowItem[] };

  const parts: Part[] = [];
  let current: (MovieItem | ShowItem)[] = [];

  for (const item of items) {
    const candidate = [...current, item];
    const size = Buffer.byteLength(JSON.stringify(toPart(candidate)));

    if (size > maxBytes && current.length > 0) {
      parts.push(toPart(current));
      current = [item];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    parts.push(toPart(current));
  }

  return parts;
}

export async function writeReport(outDir: string, data: ReportData): Promise<string> {
  await mkdir(outDir, { recursive: true });

  const items: (MovieItem | ShowItem)[] = data.type === "movie" ? data.movies : data.shows;
  const parts = splitIntoParts(items, data.type, MAX_PART_BYTES);

  const partNames: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const name = `part-${String(i + 1).padStart(3, "0")}.json`;
    await writeFile(join(outDir, name), JSON.stringify(parts[i], null, 2));
    partNames.push(name);
  }

  const manifest: Manifest = {
    type: data.type,
    generatedAt: new Date().toISOString(),
    parts: partNames,
    ambiguous: data.ambiguous,
    unmatched: data.unmatched,
  };

  const manifestPath = join(outDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return manifestPath;
}
