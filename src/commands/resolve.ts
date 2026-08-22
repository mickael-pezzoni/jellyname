import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AmbiguousCandidate, AmbiguousItem, Manifest, MediaType, Part, ShowItem } from "../report/types.ts";
import { episodeFileName, movieTargetPath, seasonTargetDir, showRoot } from "../report/naming.ts";

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

function applyResolution(
  parts: LoadedPart[],
  dir: string,
  type: MediaType,
  item: AmbiguousItem,
  chosen: AmbiguousCandidate,
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
    throw new Error(`item ambigu sans saison/épisode: ${item.oldPath}`);
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

export async function runResolve(argv: string[]): Promise<void> {
  const options = parseResolveArgs(argv);
  const dir = dirname(options.report);

  const manifest = JSON.parse(await readFile(options.report, "utf-8")) as Manifest;

  if (typeof manifest.libraryRoot !== "string") {
    throw new Error(
      `${options.report} n'a pas de champ "libraryRoot" — ce rapport a été généré par une version plus ancienne de jellyname. Relance "jellyname scan" pour régénérer un rapport à jour avant de résoudre les ambigus.`,
    );
  }

  if (manifest.ambiguous.length === 0) {
    console.log("Aucun item ambigu à résoudre.");
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

  const groups = groupAmbiguousItems(manifest.ambiguous, manifest.type);
  const remaining: AmbiguousItem[] = [];
  let resolvedCount = 0;
  let skippedCount = 0;

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
      skippedCount += group.length;
      continue;
    }

    const chosen = first.candidates[Number(answer) - 1];
    if (!chosen) {
      console.log("  Choix invalide, groupe laissé de côté (relance resolve pour retenter).");
      remaining.push(...group);
      skippedCount += group.length;
      continue;
    }

    for (const item of group) {
      applyResolution(parts, dir, manifest.type, item, chosen, manifest.libraryRoot);
      resolvedCount++;
    }
  }

  rl.close();

  manifest.ambiguous = remaining;
  manifest.parts = parts.map((p) => p.fileName);

  for (const loaded of parts) {
    await writeFile(loaded.path, JSON.stringify(loaded.part, null, 2));
  }
  await writeFile(options.report, JSON.stringify(manifest, null, 2));

  console.log(`\n${resolvedCount} résolu(s), ${skippedCount} passé(s), ${remaining.length} ambigu(s) restant(s).`);
}
