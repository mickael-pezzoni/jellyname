import { parseArgs } from "node:util";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { MediaType } from "../report/types.ts";
import type { AmbiguousItem, EpisodeItem, MovieItem, SeasonItem, ShowItem, UnmatchedItem } from "../report/types.ts";
import { walkVideoFiles } from "../fs/walk.ts";
import { parseFile } from "../parsing/index.ts";
import type { ParsedFile } from "../parsing/index.ts";
import { DEFAULT_LANGUAGES, searchMovie, searchTv } from "../tmdb/client.ts";
import type { Candidate } from "../tmdb/types.ts";
import { matchTitle, scoreCandidates } from "../tmdb/match.ts";
import { episodeFileName, movieTargetPath, seasonTargetDir, showRoot } from "../report/naming.ts";
import { writeReport } from "../report/writer.ts";
import { renderReport } from "./render.ts";

// The season is sometimes only encoded in the containing folder ("Saison 3/", "Season 03/",
// "Show Name S02/"), not in the episode filename itself — this is common enough in this
// library's layout that the folder is treated as the authoritative source when it matches,
// overriding whatever the filename parser guessed (which defaults to season 1 when it finds
// nothing). Matched anywhere in the name (not just as the whole folder name), since the show's
// title is sometimes prefixed onto the season marker rather than living in its own folder.
function extractSeasonFromFolderName(folderName: string): number | null {
  const match =
    folderName.match(/(?:saison|season)[\s._-]*0*(\d{1,3})\b/i) ?? folderName.match(/\bs0*(\d{1,3})\b/i);
  return match ? Number(match[1]) : null;
}

// Some filenames carry no title at all — just "S01E04.mkv" — relying entirely on the folder
// structure ("Show/Saison N/S01E04.mkv", or "Show/S01E04.mkv" with episodes loose directly in the
// show's folder) for identification. Detect that case and fall back to folderBasedTitle.
function looksLikeBareEpisodeCode(title: string): boolean {
  return /^s\d{1,3}e\d{1,4}$/i.test(title.trim());
}

function extractSeasonEpisodeFromFileName(fileName: string): { season: number; episode: number } | null {
  const match = fileName.match(/s(\d{1,3})e(\d{1,4})/i);
  return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
}

// Folder-based title fallbacks need to know which level actually holds the show name, which
// depends on whether a season subfolder exists: "Show/Saison N/file" (two levels up) vs. "Show/
// file" with episodes sitting loose directly in the show's own folder (one level up, no season
// subfolder at all). Decide by checking whether the immediate parent looks like a season folder;
// if it doesn't, treat it as the show folder itself instead of blindly going up one more level.
// Either way, never return the scan root itself as a "title" — that's the whole library's name,
// not a show, and would be wrongly shared across every file that hits this fallback.
function folderBasedTitle(oldPath: string, scanRoot: string): string | null {
  const parent = dirname(oldPath);
  if (resolve(parent) === resolve(scanRoot)) return null;

  const parentName = basename(parent);
  if (extractSeasonFromFolderName(parentName) === null) {
    return parentName;
  }

  const grandparent = dirname(parent);
  if (resolve(grandparent) === resolve(scanRoot)) return null;
  return basename(grandparent);
}

export interface ScanOptions {
  dir: string;
  type: MediaType;
  out: string;
  dest: string;
  render: boolean;
}

function parseScanArgs(argv: string[]): ScanOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      type: { type: "string" },
      out: { type: "string" },
      dest: { type: "string" },
      render: { type: "boolean", default: false },
    },
  });

  if (!values.dir || !values.type || !values.out) {
    throw new Error(
      "Usage: jellyname scan --dir <path> --type <movie|tv|anime> --out <path> [--dest <path>] [--render]",
    );
  }

  if (values.type !== "movie" && values.type !== "tv" && values.type !== "anime") {
    throw new Error(`--type invalide: "${values.type}" (attendu: movie, tv ou anime)`);
  }

  return {
    dir: values.dir,
    type: values.type,
    out: values.out,
    dest: values.dest ?? values.dir,
    render: values.render ?? false,
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

  const movies: MovieItem[] = [];
  const showsByTmdbId = new Map<number, ShowItem>();
  const ambiguous: AmbiguousItem[] = [];
  const unmatched: UnmatchedItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const oldPath = files[i]!;
    const label = relative(options.dir, oldPath);
    process.stdout.write(`[${i + 1}/${files.length}] ${label} ... `);

    let parsed: ParsedFile | null = await parseFile(basename(oldPath), options.type);

    if (options.type !== "movie") {
      const bareCode = parsed?.kind === "episode" && looksLikeBareEpisodeCode(parsed.title);
      if (!parsed || bareCode) {
        const title = folderBasedTitle(oldPath, options.dir);
        const seasonEpisode =
          parsed?.kind === "episode"
            ? { season: parsed.season, episode: parsed.episode }
            : extractSeasonEpisodeFromFileName(basename(oldPath));

        if (title && seasonEpisode) {
          parsed = {
            kind: "episode",
            title,
            year: null,
            season: seasonEpisode.season,
            episode: seasonEpisode.episode,
            episodeTitle: null,
          };
        }
      }
    }

    if (!parsed) {
      console.log("✗ non parsable");
      unmatched.push({ oldPath, reason: "impossible d'extraire le titre/l'épisode du nom de fichier" });
      continue;
    }

    if (parsed.kind === "episode") {
      const folderSeason = extractSeasonFromFolderName(basename(dirname(oldPath)));
      if (folderSeason !== null) {
        parsed.season = folderSeason;
      }
    }

    const candidates =
      options.type === "movie"
        ? await searchMovie(parsed.title, parsed.year, DEFAULT_LANGUAGES)
        : await searchTv(parsed.title, parsed.year, DEFAULT_LANGUAGES);

    let result = matchTitle(parsed.title, parsed.year, candidates);

    // When the filename never names the show at all — just release-pack text like "Saison 2
    // L'Intégrale" — the parsed title is junk and TMDB predictably finds nothing for it. Retry
    // once against the grandparent folder name, where the real show name lives in this library's
    // layout (same fallback source as the bare-episode-code case above, just triggered here by
    // search failure instead of upfront, since this title looked plausible on its own).
    //
    // A folder name is often just the bare franchise word ("Stargate"), which can score a
    // deceptive near-perfect text match against an obscure/low-popularity decoy entry on TMDB
    // while the real, popular show ("Stargate SG-1") scores lower and gets passed over — a
    // wrong-but-confident silent match. Since this guess is inherently less trustworthy than a
    // match derived from the file's own name, never auto-accept it: always route it to
    // ambiguous for manual confirmation, regardless of score.
    if (result.kind === "unmatched" && options.type !== "movie" && parsed.kind === "episode") {
      const folderTitle = folderBasedTitle(oldPath, options.dir);
      if (folderTitle && folderTitle !== parsed.title) {
        const folderCandidates = await searchTv(folderTitle, parsed.year, DEFAULT_LANGUAGES);
        if (folderCandidates.length > 0) {
          const scored = scoreCandidates(folderTitle, parsed.year, folderCandidates);
          parsed = { ...parsed, title: folderTitle };
          result = { kind: "ambiguous", candidates: scored.slice(0, 5) };
        }
      }
    }

    if (result.kind === "unmatched") {
      console.log("✗ aucun match TMDB");
      unmatched.push({
        oldPath,
        reason: "aucun résultat TMDB",
        parsedTitle: parsed.title,
        parsedYear: parsed.year,
        ...(parsed.kind === "episode"
          ? { season: parsed.season, episode: parsed.episode, episodeTitle: parsed.episodeTitle ?? "" }
          : {}),
      });
      continue;
    }

    if (result.kind === "ambiguous") {
      console.log(`? ambigu (${result.candidates.length} candidats)`);
      ambiguous.push({
        oldPath,
        parsedTitle: parsed.title,
        parsedYear: parsed.year,
        ...(parsed.kind === "episode"
          ? { season: parsed.season, episode: parsed.episode, episodeTitle: parsed.episodeTitle ?? "" }
          : {}),
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
  const manifestPath = await writeReport(options.out, {
    type: options.type,
    libraryRoot: options.dest,
    sourceRoot: options.dir,
    movies,
    shows,
    ambiguous,
    unmatched,
  });

  const episodeCount = shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0);
  const matchedCount = movies.length + episodeCount;

  console.log(`\nRapport écrit : ${manifestPath}`);
  console.log(`${matchedCount} identifié(s), ${ambiguous.length} ambigu(s), ${unmatched.length} non identifié(s)`);

  if (options.render) {
    const htmlPath = await renderReport(manifestPath);
    console.log(`Page générée : ${htmlPath}`);
  }
}
