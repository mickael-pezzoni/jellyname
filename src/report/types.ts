export type MediaType = "movie" | "tv" | "anime";

export type ItemStatus = "pending" | "done" | "failed";

export interface Manifest {
  type: MediaType;
  generatedAt: string;
  libraryRoot: string;
  parts: string[];
  ambiguous: AmbiguousItem[];
  unmatched: UnmatchedItem[];
}

export interface Part {
  movies?: MovieItem[];
  shows?: ShowItem[];
}

export interface MovieItem {
  title: string;
  year: number;
  tmdbId: number;
  oldPath: string;
  newPath: string;
  status: ItemStatus;
  error: string | null;
  appliedAt: string | null;
}

export interface ShowItem {
  title: string;
  year: number;
  tmdbId: number;
  targetRoot: string;
  seasons: SeasonItem[];
}

export interface SeasonItem {
  season: number;
  targetDir: string;
  episodes: EpisodeItem[];
}

export interface EpisodeItem {
  episode: number;
  episodeTitle: string;
  oldPath: string;
  newPath: string;
  status: ItemStatus;
  error: string | null;
  appliedAt: string | null;
}

export interface AmbiguousCandidate {
  tmdbId: number;
  title: string;
  year: number;
  score: number;
}

export interface AmbiguousItem {
  oldPath: string;
  parsedTitle: string;
  parsedYear: number | null;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  candidates: AmbiguousCandidate[];
}

export interface UnmatchedItem {
  oldPath: string;
  reason: string;
  parsedTitle?: string;
  parsedYear?: number | null;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}
