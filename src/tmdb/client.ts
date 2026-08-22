import type { Candidate, TmdbMovieResult, TmdbSearchResponse, TmdbTvResult } from "./types.ts";

const BASE_URL = "https://api.themoviedb.org/3";
const MIN_INTERVAL_MS = 40;

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

export async function searchMovie(query: string, year?: number | null): Promise<Candidate[]> {
  const params: Record<string, string> = { query };
  if (year) params.year = String(year);
  const data = await tmdbFetch<TmdbSearchResponse<TmdbMovieResult>>("/search/movie", params);
  return data.results.map(movieToCandidate);
}

export async function searchTv(query: string, year?: number | null): Promise<Candidate[]> {
  const params: Record<string, string> = { query };
  if (year) params.first_air_date_year = String(year);
  const data = await tmdbFetch<TmdbSearchResponse<TmdbTvResult>>("/search/tv", params);
  return data.results.map(tvToCandidate);
}
