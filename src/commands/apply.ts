import { parseArgs } from "node:util";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import type { EpisodeItem, ItemStatus, Manifest, MovieItem, Part } from "../report/types.ts";

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

function validate(parts: LoadedPart[]): string[] {
  const errors: string[] = [];
  const seenNewPaths = new Set<string>();

  for (const loadedPart of parts) {
    for (const { item, label } of collectItems(loadedPart)) {
      if (!item.oldPath || !item.newPath) {
        errors.push(`item invalide (chemin manquant) dans ${loadedPart.fileName}: ${label}`);
        continue;
      }
      if (seenNewPaths.has(item.newPath)) {
        errors.push(`newPath en double: "${item.newPath}"`);
      }
      seenNewPaths.add(item.newPath);
    }
  }

  return errors;
}

async function askConfirmation(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return ["y", "yes", "o", "oui"].includes(answer.trim().toLowerCase());
}

async function moveFile(oldPath: string, newPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await Bun.file(oldPath).exists())) {
    return { ok: false, error: "fichier source introuvable" };
  }

  if (await Bun.file(newPath).exists()) {
    return { ok: false, error: "un fichier existe déjà à la destination" };
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

  return { ok: true };
}

export async function runApply(argv: string[]): Promise<void> {
  const options = parseApplyArgs(argv);

  const { manifest, parts } = await loadManifestAndParts(options.report);

  const validationErrors = validate(parts);
  if (validationErrors.length > 0) {
    console.error("Rapport invalide, apply annulé :");
    for (const error of validationErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const allItems = parts.flatMap(collectItems);
  const toProcess = allItems.filter(({ item }) => {
    if (item.status === "done") return false;
    if (item.status === "failed" && !options.retryFailed) return false;
    return true;
  });

  if (toProcess.length === 0) {
    console.log("Rien à appliquer (tout est déjà fait, ou en échec sans --retry-failed).");
    notifyAmbiguous(manifest.ambiguous.length, options.report);
    return;
  }

  console.log(
    `${toProcess.length} fichier(s) à traiter (${allItems.length - toProcess.length} déjà fait(s)/ignoré(s) sur ${allItems.length} au total).`,
  );

  if (!options.yes) {
    const confirmed = await askConfirmation(`Confirmer l'application de ${toProcess.length} renommage(s) ? [y/N] `);
    if (!confirmed) {
      console.log("Annulé.");
      return;
    }
  }

  const partsByFileName = new Map(parts.map((p) => [p.fileName, p]));

  let done = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { item, label, partFileName } = toProcess[i]!;
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${label} ... `);

    const result = await moveFile(item.oldPath, item.newPath);

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

  console.log(`\nTerminé : ${done} réussi(s), ${failed} échoué(s).`);
  notifyAmbiguous(manifest.ambiguous.length, options.report);
}

function notifyAmbiguous(count: number, reportPath: string): void {
  if (count === 0) return;
  console.log(
    `\n${count} fichier(s) ambigu(s) n'ont pas été traités. Lance "jellyname resolve --report ${reportPath}" pour les trancher.`,
  );
}
