import type { Candidate, TmdbMovieResult, TmdbSearchResponse, TmdbTvResult } from "./types.ts";

const BASE_URL = "https://api.themoviedb.org/3";
const MIN_INTERVAL_MS = 40;

export const DEFAULT_LANGUAGES = ["fr-FR", "en-US"];

let lastRequestAt = 0;

function getApiKey(): string {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    throw new Error("TMDB_API_KEY manquante — copie .env.example vers .env et renseigne-la");
  }
  return key;
}

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

async function tmdbFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  await throttle();

  const url = new URL(BASE_URL + path);
  url.searchParams.set("api_key", getApiKey());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return tmdbFetch<T>(path, params);
  }

  if (response.status === 401) {
    throw new Error("TMDB a rejeté la clé API (401) — vérifie TMDB_API_KEY dans .env");
  }

  if (!response.ok) {
    throw new Error(`TMDB ${path}: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function movieToCandidate(movie: TmdbMovieResult): Candidate {
  return {
    tmdbId: movie.id,
    title: movie.title,
    year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : null,
    popularity: movie.popularity,
  };
}

function tvToCandidate(show: TmdbTvResult): Candidate {
  return {
    tmdbId: show.id,
    title: show.name,
    year: show.first_air_date ? Number(show.first_air_date.slice(0, 4)) : null,
    popularity: show.popularity,
  };
}

// TMDB's search endpoint sometimes returns zero results when a lone number sits mid-title
// (e.g. "Harry Potter 5 et l'Ordre du Phénix", where parse-torrent-title kept the franchise
// entry number as part of the title). Retrying once without that token recovers the match
// without affecting scoring, which still compares against the original parsed title.
function stripLoneNumberToken(query: string): string | null {
  const tokens = query.split(/\s+/);
  const index = tokens.findIndex((token) => /^\d+$/.test(token));
  if (index === -1) return null;

  const stripped = [...tokens.slice(0, index), ...tokens.slice(index + 1)].join(" ").trim();
  return stripped.length > 0 ? stripped : null;
}

async function rawSearchMovie(query: string, year?: number | null, language?: string): Promise<Candidate[]> {
  const params: Record<string, string> = { query };
  if (year) params.year = String(year);
  if (language) params.language = language;
  const data = await tmdbFetch<TmdbSearchResponse<TmdbMovieResult>>("/search/movie", params);
  return data.results.map(movieToCandidate);
}

async function rawSearchTv(query: string, year?: number | null, language?: string): Promise<Candidate[]> {
  const params: Record<string, string> = { query };
  if (year) params.first_air_date_year = String(year);
  if (language) params.language = language;
  const data = await tmdbFetch<TmdbSearchResponse<TmdbTvResult>>("/search/tv", params);
  return data.results.map(tvToCandidate);
}

type RawSearch = (query: string, year?: number | null, language?: string) => Promise<Candidate[]>;

// Queries every language in turn (not just until one succeeds) and concatenates all results,
// duplicates included — matchTitle/scoreCandidates picks whichever localized title of a given
// movie/show scores best against the parsed filename, since we don't know upfront which
// language the filename itself was named in. Within each language: a lone mid-title number (see
// stripLoneNumberToken) is retried once if the plain query comes back empty, and if a year was
// given and still nothing comes back, one more retry drops the year entirely — a parsed year can
// itself be wrong (e.g. an episode literally titled "2010" misread as a release year), and TMDB's
// year filter is strict enough that a wrong one suppresses the correct result outright rather
// than just ranking it lower.
async function searchAllLanguages(
  raw: RawSearch,
  query: string,
  year: number | null | undefined,
  languages: string[],
): Promise<Candidate[]> {
  const results: Candidate[] = [];

  for (const language of languages) {
    let candidates = await raw(query, year, language);

    if (candidates.length === 0) {
      const stripped = stripLoneNumberToken(query);
      if (stripped) candidates = await raw(stripped, year, language);
    }

    if (candidates.length === 0 && year) {
      candidates = await raw(query, null, language);
    }

    results.push(...candidates);
  }

  return results;
}

export async function searchMovie(
  query: string,
  year: number | null | undefined,
  languages: string[],
): Promise<Candidate[]> {
  return searchAllLanguages(rawSearchMovie, query, year, languages);
}

export async function searchTv(
  query: string,
  year: number | null | undefined,
  languages: string[],
): Promise<Candidate[]> {
  return searchAllLanguages(rawSearchTv, query, year, languages);
}
