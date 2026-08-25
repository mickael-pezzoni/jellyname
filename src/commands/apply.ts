import { parseArgs } from "node:util";
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import type { EpisodeItem, ItemStatus, Manifest, MovieItem, Part } from "../report/types.ts";
import { walkVideoFiles } from "../fs/walk.ts";

export interface ApplyOptions {
  report: string;
  yes: boolean;
  retryFailed: boolean;
}

function parseApplyArgs(argv: string[]): ApplyOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
      yes: { type: "boolean", default: false },
      "retry-failed": { type: "boolean", default: false },
    },
  });

  if (!values.report) {
    throw new Error("Usage: jellyname apply --report <manifest.json> [--yes] [--retry-failed]");
  }

  return { report: values.report, yes: values.yes ?? false, retryFailed: values["retry-failed"] ?? false };
}

interface Movable {
  oldPath: string;
  newPath: string;
  status: ItemStatus;
  error: string | null;
  appliedAt: string | null;
}

interface LoadedPart {
  fileName: string;
  path: string;
  part: Part;
}

interface QueuedItem {
  item: Movable;
  label: string;
  partFileName: string;
}

async function loadManifestAndParts(manifestPath: string): Promise<{ manifest: Manifest; parts: LoadedPart[] }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Manifest;
  const dir = dirname(manifestPath);

  const parts: LoadedPart[] = [];
  for (const fileName of manifest.parts) {
    const path = join(dir, fileName);
    const part = JSON.parse(await readFile(path, "utf-8")) as Part;
    parts.push({ fileName, path, part });
  }

  return { manifest, parts };
}

function collectItems(loadedPart: LoadedPart): QueuedItem[] {
  const items: QueuedItem[] = [];

  for (const movie of loadedPart.part.movies ?? []) {
    items.push({ item: movie as MovieItem, label: `${movie.title} (${movie.year})`, partFileName: loadedPart.fileName });
  }

  for (const show of loadedPart.part.shows ?? []) {
    for (const season of show.seasons) {
      for (const episode of season.episodes) {
        items.push({
          item: episode as EpisodeItem,
          label: `${show.title} S${String(season.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`,
          partFileName: loadedPart.fileName,
        });
      }
    }
  }

  return items;
}

interface ValidationResult {
  errors: string[];
  duplicateGroups: Map<string, QueuedItem[]>;
}

// Missing paths mean the report itself is corrupted — refuse to touch anything. A duplicate
// newPath is different: the report is otherwise fine, it's just that two items would land on
// the same file. Aborting the whole run over one collision is too harsh, so those items are
// marked failed and skipped instead, letting everything else proceed. Items already "done" are
// excluded from this grouping entirely — that path is legitimately taken by a prior successful
// move, not a same-report collision, and must never be flipped back to failed here. A pending
// item that happens to share a path with a done item isn't flagged as a duplicate either; it
// falls through to the normal move attempt, where moveFile reports the accurate, specific reason
// ("a file already exists at the destination") instead of the more generic duplicate message.
function validate(parts: LoadedPart[]): ValidationResult {
  const errors: string[] = [];
  const byNewPath = new Map<string, QueuedItem[]>();

  for (const loadedPart of parts) {
    for (const entry of collectItems(loadedPart)) {
      const { item, label } = entry;
      if (!item.oldPath || !item.newPath) {
        errors.push(`invalid item (missing path) in ${loadedPart.fileName}: ${label}`);
        continue;
      }
      if (item.status === "done") continue;
      const group = byNewPath.get(item.newPath) ?? [];
      group.push(entry);
      byNewPath.set(item.newPath, group);
    }
  }

  const duplicateGroups = new Map<string, QueuedItem[]>();
  for (const [newPath, group] of byNewPath) {
    if (group.length > 1) duplicateGroups.set(newPath, group);
  }

  return { errors, duplicateGroups };
}

async function askConfirmation(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return ["y", "yes", "o", "oui"].includes(answer.trim().toLowerCase());
}

// A source directory is only ever worth keeping around for the video files it might still hold
// (e.g. an unmatched OAV) — leftover posters, .nfo, or other non-video sidecar files aren't. Once
// the last video is out, remove the directory and whatever non-video junk remains in it, then
// check its parent too, and keep climbing as long as each ancestor is itself left with no video
// files — e.g. a messy wrapper folder ("Show.Integrale.1080p.../Show.S01.../file.mkv") that only
// empties out once every season subfolder inside it has already been individually removed. This
// is safe to cascade (unlike the single-level cleanup this replaces) precisely because it has a
// hard, known boundary to climb toward: manifest.sourceRoot. A sibling folder with unrelated
// content anywhere in the chain naturally stops the climb, since walkVideoFiles on that ancestor
// would then find its videos and abort right there.
//
// The scan root itself (manifest.sourceRoot) is never removed this way, even if it ends up
// holding no video files — that happens whenever a file sat directly at the root of --dir (no
// subfolder), since dirname(oldPath) is then the root itself. Without this guard, moving the
// last root-level file out (e.g. to a separate --dest) deletes the entire directory the user
// pointed --dir at, along with anything unrelated to jellyname that happened to be in it.
// Verified this destroys the directory before adding the guard — this is not a hypothetical.
//
// sourceRoot is missing on reports generated before this field existed; with no way to know
// where the scan root was, cleanup is skipped entirely for those rather than risk the same
// destruction — never proceed on the assumption that a directory isn't the root.
async function removeIfNoVideoFiles(startDir: string, sourceRoot: string | undefined): Promise<void> {
  if (sourceRoot === undefined) return;

  let dir = startDir;

  while (resolve(dir) !== resolve(sourceRoot)) {
    try {
      const videoFiles = await walkVideoFiles(dir);
      if (videoFiles.length > 0) return;
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Directory already gone, inaccessible, or a race added a video back — not fatal either way.
      return;
    }

    const parent = dirname(dir);
    if (parent === dir) return; // reached the filesystem root — should be unreachable, but never loop forever
    dir = parent;
  }
}

async function moveFile(
  oldPath: string,
  newPath: string,
  sourceRoot: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await Bun.file(oldPath).exists())) {
    return { ok: false, error: "source file not found" };
  }

  if (await Bun.file(newPath).exists()) {
    return { ok: false, error: "a file already exists at the destination" };
  }

  await mkdir(dirname(newPath), { recursive: true });

  try {
    await rename(oldPath, newPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(oldPath, newPath);
      await unlink(oldPath);
    } else {
      return { ok: false, error: (err as Error).message };
    }
  }

  await removeIfNoVideoFiles(dirname(oldPath), sourceRoot);

  return { ok: true };
}

export async function runApply(argv: string[]): Promise<void> {
  const options = parseApplyArgs(argv);

  const { manifest, parts } = await loadManifestAndParts(options.report);
  const partsByFileName = new Map(parts.map((p) => [p.fileName, p]));

  const { errors: validationErrors, duplicateGroups } = validate(parts);
  if (validationErrors.length > 0) {
    console.error("Invalid report, apply aborted:");
    for (const error of validationErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  if (duplicateGroups.size > 0) {
    console.log(`${duplicateGroups.size} duplicate newPath(s) detected, skipped:`);
    const touchedParts = new Set<string>();

    for (const [newPath, group] of duplicateGroups) {
      console.log(`  - ${newPath} (${group.length} files)`);
      for (const { item, partFileName } of group) {
        item.status = "failed";
        item.error = "newPath duplicated with another item in the report";
        touchedParts.add(partFileName);
      }
    }

    for (const fileName of touchedParts) {
      const loadedPart = partsByFileName.get(fileName)!;
      await writeFile(loadedPart.path, JSON.stringify(loadedPart.part, null, 2));
    }
  }

  const duplicateItems = new Set([...duplicateGroups.values()].flat().map(({ item }) => item));

  const allItems = parts.flatMap(collectItems);
  const toProcess = allItems.filter(({ item }) => {
    // Never retry a duplicate within this same run, even with --retry-failed — that flag is for
    // retrying transient failures from a previous run, not items just marked failed above.
    if (duplicateItems.has(item)) return false;
    if (item.status === "done") return false;
    if (item.status === "failed" && !options.retryFailed) return false;
    return true;
  });

  if (toProcess.length === 0) {
    console.log("Nothing to apply (everything already done, or failed without --retry-failed).");
    notifyAmbiguous(manifest.ambiguous.length, options.report);
    return;
  }

  console.log(
    `${toProcess.length} file(s) to process (${allItems.length - toProcess.length} already done/skipped out of ${allItems.length} total).`,
  );

  if (!options.yes) {
    const confirmed = await askConfirmation(`Confirm applying ${toProcess.length} rename(s)? [y/N] `);
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  let done = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { item, label, partFileName } = toProcess[i]!;
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${label} ... `);

    const result = await moveFile(item.oldPath, item.newPath, manifest.sourceRoot);

    if (result.ok) {
      item.status = "done";
      item.error = null;
      item.appliedAt = new Date().toISOString();
      done++;
      console.log("✓");
    } else {
      item.status = "failed";
      item.error = result.error;
      failed++;
      console.log(`✗ ${result.error}`);
    }

    const loadedPart = partsByFileName.get(partFileName)!;
    await writeFile(loadedPart.path, JSON.stringify(loadedPart.part, null, 2));
  }

  console.log(`\nDone: ${done} succeeded, ${failed} failed.`);
  notifyAmbiguous(manifest.ambiguous.length, options.report);
}

function notifyAmbiguous(count: number, reportPath: string): void {
  if (count === 0) return;
  console.log(
    `\n${count} ambiguous file(s) were not processed. Run "jellyname resolve --report ${reportPath}" to resolve them.`,
  );
}
