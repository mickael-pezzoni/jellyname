import { parseArgs } from "node:util";
import { basename, extname, join, relative } from "node:path";
import type { MediaType } from "../report/types.ts";
import type { AmbiguousItem, EpisodeItem, MovieItem, SeasonItem, ShowItem, UnmatchedItem } from "../report/types.ts";
import { walkVideoFiles } from "../fs/walk.ts";
import { parseFile } from "../parsing/index.ts";
import { searchMovie, searchTv } from "../tmdb/client.ts";
import type { Candidate } from "../tmdb/types.ts";
import { matchTitle } from "../tmdb/match.ts";
import { episodeFileName, movieTargetPath, seasonTargetDir, showRoot } from "../report/naming.ts";
import { writeReport } from "../report/writer.ts";

export interface ScanOptions {
  dir: string;
  type: MediaType;
  out: string;
  dest: string;
  lang: string;
}

function parseScanArgs(argv: string[]): ScanOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      type: { type: "string" },
      out: { type: "string" },
      dest: { type: "string" },
      lang: { type: "string" },
    },
  });

  if (!values.dir || !values.type || !values.out) {
    throw new Error("Usage: jellyname scan --dir <path> --type <movie|tv|anime> --out <path> [--dest <path>] [--lang <fr-FR>]");
  }

  if (values.type !== "movie" && values.type !== "tv" && values.type !== "anime") {
    throw new Error(`--type invalide: "${values.type}" (attendu: movie, tv ou anime)`);
  }

  return {
    dir: values.dir,
    type: values.type,
    out: values.out,
    dest: values.dest ?? values.dir,
    lang: values.lang ?? "fr-FR",
  };
}

function getOrCreateShow(
  showsByTmdbId: Map<number, ShowItem>,
  candidate: Candidate,
  libraryRoot: string,
): ShowItem {
  let show = showsByTmdbId.get(candidate.tmdbId);
  if (!show) {
    show = {
      title: candidate.title,
      year: candidate.year ?? 0,
      tmdbId: candidate.tmdbId,
      targetRoot: showRoot(libraryRoot, candidate.title),
      seasons: [],
    };
    showsByTmdbId.set(candidate.tmdbId, show);
  }
  return show;
}

function getOrCreateSeason(show: ShowItem, season: number, libraryRoot: string): SeasonItem {
  let seasonItem = show.seasons.find((s) => s.season === season);
  if (!seasonItem) {
    seasonItem = { season, targetDir: seasonTargetDir(showRoot(libraryRoot, show.title), season), episodes: [] };
    show.seasons.push(seasonItem);
  }
  return seasonItem;
}

export async function runScan(argv: string[]): Promise<void> {
  const options = parseScanArgs(argv);

  const files = await walkVideoFiles(options.dir);
  console.log(`${files.length} fichier(s) vidéo trouvé(s) dans ${options.dir}`);

  const languages = options.lang === "en-US" ? ["en-US"] : [options.lang, "en-US"];

  const movies: MovieItem[] = [];
  const showsByTmdbId = new Map<number, ShowItem>();
  const ambiguous: AmbiguousItem[] = [];
  const unmatched: UnmatchedItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const oldPath = files[i]!;
    const label = relative(options.dir, oldPath);
    process.stdout.write(`[${i + 1}/${files.length}] ${label} ... `);

    const parsed = await parseFile(basename(oldPath), options.type);
    if (!parsed) {
      console.log("✗ non parsable");
      unmatched.push({ oldPath, reason: "impossible d'extraire le titre/l'épisode du nom de fichier" });
      continue;
    }

    const candidates =
      options.type === "movie"
        ? await searchMovie(parsed.title, parsed.year, languages)
        : await searchTv(parsed.title, parsed.year, languages);

    const result = matchTitle(parsed.title, parsed.year, candidates);

    if (result.kind === "unmatched") {
      console.log("✗ aucun match TMDB");
      unmatched.push({ oldPath, reason: "aucun résultat TMDB" });
      continue;
    }

    if (result.kind === "ambiguous") {
      console.log(`? ambigu (${result.candidates.length} candidats)`);
      ambiguous.push({
        oldPath,
        parsedTitle: parsed.title,
        parsedYear: parsed.year,
        candidates: result.candidates.map((scored) => ({
          tmdbId: scored.candidate.tmdbId,
          title: scored.candidate.title,
          year: scored.candidate.year ?? 0,
          score: Math.round(scored.score * 1000) / 1000,
        })),
      });
      continue;
    }

    const ext = extname(oldPath);

    if (parsed.kind === "movie") {
      const year = result.candidate.year ?? parsed.year ?? 0;
      movies.push({
        title: result.candidate.title,
        year,
        tmdbId: result.candidate.tmdbId,
        oldPath,
        newPath: movieTargetPath(options.dest, result.candidate.title, year, ext),
        status: "pending",
        error: null,
        appliedAt: null,
      });
      console.log(`✓ ${result.candidate.title} (${year})`);
    } else {
      const show = getOrCreateShow(showsByTmdbId, result.candidate, options.dest);
      const season = getOrCreateSeason(show, parsed.season, options.dest);
      const episodeTitle = parsed.episodeTitle ?? "";
      const episodeItem: EpisodeItem = {
        episode: parsed.episode,
        episodeTitle,
        oldPath,
        newPath: join(season.targetDir, episodeFileName(show.title, parsed.season, parsed.episode, parsed.episodeTitle, ext)),
        status: "pending",
        error: null,
        appliedAt: null,
      };
      season.episodes.push(episodeItem);
      console.log(`✓ ${show.title} S${String(parsed.season).padStart(2, "0")}E${String(parsed.episode).padStart(2, "0")}`);
    }
  }

  const shows = [...showsByTmdbId.values()];
  const manifestPath = await writeReport(options.out, { type: options.type, movies, shows, ambiguous, unmatched });

  const episodeCount = shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0);
  const matchedCount = movies.length + episodeCount;

  console.log(`\nRapport écrit : ${manifestPath}`);
  console.log(`${matchedCount} identifié(s), ${ambiguous.length} ambigu(s), ${unmatched.length} non identifié(s)`);
}
