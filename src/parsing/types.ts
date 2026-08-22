export interface ParsedMovie {
  kind: "movie";
  title: string;
  year: number | null;
}

export interface ParsedEpisode {
  kind: "episode";
  title: string;
  year: number | null;
  season: number;
  episode: number;
  episodeTitle: string | null;
}

export type ParsedFile = ParsedMovie | ParsedEpisode;
