import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AmbiguousItem, Manifest, MediaType, Part, ShowItem, UnmatchedItem } from "../report/types.ts";
import { episodeFileName, movieTargetPath, seasonTargetDir, showRoot } from "../report/naming.ts";
import { DEFAULT_LANGUAGES, searchMovie, searchTv } from "../tmdb/client.ts";

export interface ResolveOptions {
  report: string;
}

function parseResolveArgs(argv: string[]): ResolveOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
    },
  });

  if (!values.report) {
    throw new Error("Usage: jellyname resolve --report <manifest.json>");
  }

  return { report: values.report };
}

interface LoadedPart {
  fileName: string;
  path: string;
  part: Part;
}

function ensureWritablePart(parts: LoadedPart[], dir: string): LoadedPart {
  if (parts.length > 0) return parts[parts.length - 1]!;

  const fileName = "part-001.json";
  const loaded: LoadedPart = { fileName, path: join(dir, fileName), part: {} };
  parts.push(loaded);
  return loaded;
}

function findShow(parts: LoadedPart[], tmdbId: number): ShowItem | undefined {
  for (const { part } of parts) {
    const found = part.shows?.find((show) => show.tmdbId === tmdbId);
    if (found) return found;
  }
  return undefined;
}

interface ResolvableTarget {
  oldPath: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

interface ResolvedCandidate {
  tmdbId: number;
  title: string;
  year: number;
}

function applyResolution(
  parts: LoadedPart[],
  dir: string,
  type: MediaType,
  item: ResolvableTarget,
  chosen: ResolvedCandidate,
  libraryRoot: string,
): void {
  const ext = extname(item.oldPath);

  if (type === "movie") {
    const target = ensureWritablePart(parts, dir);
    target.part.movies ??= [];
    target.part.movies.push({
      title: chosen.title,
      year: chosen.year,
      tmdbId: chosen.tmdbId,
      oldPath: item.oldPath,
      newPath: movieTargetPath(libraryRoot, chosen.title, chosen.year, ext),
      status: "pending",
      error: null,
      appliedAt: null,
    });
    return;
  }

  if (item.season === undefined || item.episode === undefined) {
    throw new Error(`item sans saison/épisode: ${item.oldPath}`);
  }

  let show = findShow(parts, chosen.tmdbId);
  if (!show) {
    show = {
      title: chosen.title,
      year: chosen.year,
      tmdbId: chosen.tmdbId,
      targetRoot: showRoot(libraryRoot, chosen.title),
      seasons: [],
    };
    const target = ensureWritablePart(parts, dir);
    target.part.shows ??= [];
    target.part.shows.push(show);
  }

  let season = show.seasons.find((s) => s.season === item.season);
  if (!season) {
    season = { season: item.season, targetDir: seasonTargetDir(showRoot(libraryRoot, show.title), item.season), episodes: [] };
    show.seasons.push(season);
  }

  season.episodes.push({
    episode: item.episode,
    episodeTitle: item.episodeTitle ?? "",
    oldPath: item.oldPath,
    newPath: join(season.targetDir, episodeFileName(show.title, item.season, item.episode, item.episodeTitle ?? null, ext)),
    status: "pending",
    error: null,
    appliedAt: null,
  });
}

// For tv/anime, several episodes of the same show typically share an identical parsed title —
// group them so the user picks a candidate once per show instead of once per episode.
function groupAmbiguousItems(items: AmbiguousItem[], type: MediaType): AmbiguousItem[][] {
  if (type === "movie") {
    return items.map((item) => [item]);
  }

  const groups = new Map<string, AmbiguousItem[]>();
  for (const item of items) {
    const group = groups.get(item.parsedTitle) ?? [];
    group.push(item);
    groups.set(item.parsedTitle, group);
  }
  return [...groups.values()];
}

type AskFn = (prompt: string) => Promise<string>;

// searchMovie/searchTv query every configured language and concatenate raw results — fine for
// automatic scoring (which dedupes by picking the best-scoring title per tmdbId), but a manual
// search here shows the list as-is, so the same show would otherwise appear once per language.
function dedupeByTmdbId<T extends { tmdbId: number }>(candidates: T[]): T[] {
  const seen = new Set<number>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.tmdbId)) return false;
    seen.add(candidate.tmdbId);
    return true;
  });
}

// Unlike ambiguous items (which already have TMDB candidates to choose from), an unmatched item
// got zero results from its parsed title — so resolving one means letting the user type a
// corrected search query themselves, re-running the TMDB search against it, and picking from
// whatever comes back. Items from a total parse failure (no season/episode captured at scan
// time) additionally need those typed in manually for tv/anime before they can be applied.
async function resolveUnmatchedItems(
  items: UnmatchedItem[],
  type: MediaType,
  parts: LoadedPart[],
  dir: string,
  libraryRoot: string,
  ask: AskFn,
): Promise<{ remaining: UnmatchedItem[]; resolvedCount: number }> {
  const remaining: UnmatchedItem[] = [];
  let resolvedCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const rest = items.slice(i + 1);

    console.log(`\n[${i + 1}/${items.length}] ${basename(item.oldPath)}`);
    console.log(`  raison : ${item.reason}${item.parsedTitle ? ` — titre détecté : "${item.parsedTitle}"` : ""}`);

    let query = await ask('  Nouvelle recherche (titre, "s" pour passer, "q" pour quitter) : ');

    if (query === "q") {
      remaining.push(item, ...rest);
      return { remaining, resolvedCount };
    }
    if (query === "s" || query === "") {
      remaining.push(item);
      continue;
    }

    let candidates = dedupeByTmdbId(
      await (type === "movie"
        ? searchMovie(query, item.parsedYear, DEFAULT_LANGUAGES)
        : searchTv(query, item.parsedYear, DEFAULT_LANGUAGES)),
    );

    while (candidates.length === 0) {
      console.log("  Aucun résultat.");
      query = await ask('  Nouvelle recherche (ou "s" pour passer, "q" pour quitter) : ');
      if (query === "q") {
        remaining.push(item, ...rest);
        return { remaining, resolvedCount };
      }
      if (query === "s" || query === "") break;
      candidates = dedupeByTmdbId(
        await (type === "movie"
          ? searchMovie(query, item.parsedYear, DEFAULT_LANGUAGES)
          : searchTv(query, item.parsedYear, DEFAULT_LANGUAGES)),
      );
    }

    if (candidates.length === 0) {
      remaining.push(item);
      continue;
    }

    candidates.forEach((candidate, index) => {
      console.log(`  ${index + 1}. ${candidate.title} (${candidate.year ?? "?"}) — tmdb#${candidate.tmdbId}`);
    });

    const choice = await ask('  Choix (numéro, "s" pour passer, "q" pour quitter) : ');

    if (choice === "q") {
      remaining.push(item, ...rest);
      return { remaining, resolvedCount };
    }
    if (choice === "s" || choice === "") {
      remaining.push(item);
      continue;
    }

    const picked = candidates[Number(choice) - 1];
    if (!picked) {
      console.log("  Choix invalide, item laissé de côté.");
      remaining.push(item);
      continue;
    }

    let season = item.season;
    let episode = item.episode;

    if (type !== "movie" && (season === undefined || episode === undefined)) {
      const manual = await ask('  Saison et épisode (ex: 1x05), "s" pour passer : ');
      const match = manual.match(/^(\d+)x(\d+)$/i);
      if (!match) {
        console.log("  Format invalide, item laissé de côté.");
        remaining.push(item);
        continue;
      }
      season = Number(match[1]);
      episode = Number(match[2]);
    }

    applyResolution(
      parts,
      dir,
      type,
      { oldPath: item.oldPath, season, episode, episodeTitle: item.episodeTitle },
      { tmdbId: picked.tmdbId, title: picked.title, year: picked.year ?? 0 },
      libraryRoot,
    );
    resolvedCount++;
  }

  return { remaining, resolvedCount };
}

export async function runResolve(argv: string[]): Promise<void> {
  const options = parseResolveArgs(argv);
  const dir = dirname(options.report);

  const manifest = JSON.parse(await readFile(options.report, "utf-8")) as Manifest;

  if (typeof manifest.libraryRoot !== "string") {
    throw new Error(
      `${options.report} n'a pas de champ "libraryRoot" — ce rapport a été généré par une version plus ancienne de jellyname. Relance "jellyname scan" pour régénérer un rapport à jour avant de résoudre les ambigus.`,
    );
  }

  if (manifest.ambiguous.length === 0 && manifest.unmatched.length === 0) {
    console.log("Rien à résoudre.");
    return;
  }

  const parts: LoadedPart[] = [];
  for (const fileName of manifest.parts) {
    const path = join(dir, fileName);
    const part = JSON.parse(await readFile(path, "utf-8")) as Part;
    parts.push({ fileName, path, part });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // rl.question() races with readline's own eager line buffering: a line that arrives before
  // the next question() call is silently dropped (no listener is attached yet), which loses
  // answers when resolving several items in one session. Pulling from the interface's async
  // iterator instead queues lines properly regardless of timing.
  const lines = rl[Symbol.asyncIterator]();

  async function ask(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? "q" : value.trim().toLowerCase();
  }

  let remainingAmbiguous: AmbiguousItem[] = manifest.ambiguous;
  let resolvedAmbiguousCount = 0;
  let skippedAmbiguousCount = 0;

  if (manifest.ambiguous.length > 0) {
    console.log("--- Ambigus ---");
    const groups = groupAmbiguousItems(manifest.ambiguous, manifest.type);
    const remaining: AmbiguousItem[] = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      const first = group[0]!;

      console.log(`\n[${i + 1}/${groups.length}] "${first.parsedTitle}"${first.parsedYear ? ` (${first.parsedYear})` : ""}`);
      console.log(group.length === 1 ? `  ${basename(first.oldPath)}` : `  ${group.length} épisodes concernés`);
      first.candidates.forEach((candidate, index) => {
        console.log(`  ${index + 1}. ${candidate.title} (${candidate.year}) — score ${candidate.score} — tmdb#${candidate.tmdbId}`);
      });

      const answer = await ask('  Choix (numéro, "s" pour passer, "q" pour quitter) : ');

      if (answer === "q") {
        remaining.push(...group, ...groups.slice(i + 1).flat());
        break;
      }

      if (answer === "s" || answer === "") {
        remaining.push(...group);
        skippedAmbiguousCount += group.length;
        continue;
      }

      const chosen = first.candidates[Number(answer) - 1];
      if (!chosen) {
        console.log("  Choix invalide, groupe laissé de côté (relance resolve pour retenter).");
        remaining.push(...group);
        skippedAmbiguousCount += group.length;
        continue;
      }

      for (const item of group) {
        applyResolution(parts, dir, manifest.type, item, chosen, manifest.libraryRoot);
        resolvedAmbiguousCount++;
      }
    }

    remainingAmbiguous = remaining;
  }

  let remainingUnmatched: UnmatchedItem[] = manifest.unmatched;
  let resolvedUnmatchedCount = 0;

  if (manifest.unmatched.length > 0) {
    console.log("\n--- Non identifiés ---");
    const result = await resolveUnmatchedItems(manifest.unmatched, manifest.type, parts, dir, manifest.libraryRoot, ask);
    remainingUnmatched = result.remaining;
    resolvedUnmatchedCount = result.resolvedCount;
  }

  rl.close();

  manifest.ambiguous = remainingAmbiguous;
  manifest.unmatched = remainingUnmatched;
  manifest.parts = parts.map((p) => p.fileName);

  for (const loaded of parts) {
    await writeFile(loaded.path, JSON.stringify(loaded.part, null, 2));
  }
  await writeFile(options.report, JSON.stringify(manifest, null, 2));

  const totalResolved = resolvedAmbiguousCount + resolvedUnmatchedCount;
  console.log(
    `\n${totalResolved} résolu(s) (${resolvedAmbiguousCount} ambigu(s), ${resolvedUnmatchedCount} non identifié(s)), ${skippedAmbiguousCount} passé(s), ${remainingAmbiguous.length} ambigu(s) restant(s), ${remainingUnmatched.length} non identifié(s) restant(s).`,
  );
}
