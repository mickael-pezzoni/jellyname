export interface TmdbMovieResult {
  id: number;
  title: string;
  release_date: string;
  popularity: number;
  vote_count: number;
}

export interface TmdbTvResult {
  id: number;
  name: string;
  first_air_date: string;
  popularity: number;
  vote_count: number;
}

export interface TmdbSearchResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

export interface Candidate {
  tmdbId: number;
  title: string;
  year: number | null;
  popularity: number;
}
