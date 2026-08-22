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

interface ValidationResult {
  errors: string[];
  duplicateGroups: Map<string, QueuedItem[]>;
}

// Missing paths mean the report itself is corrupted — refuse to touch anything. A duplicate
// newPath is different: the report is otherwise fine, it's just that two items would land on
// the same file. Aborting the whole run over one collision is too harsh, so those items are
// marked failed and skipped instead, letting everything else proceed.
function validate(parts: LoadedPart[]): ValidationResult {
  const errors: string[] = [];
  const byNewPath = new Map<string, QueuedItem[]>();

  for (const loadedPart of parts) {
    for (const entry of collectItems(loadedPart)) {
      const { item, label } = entry;
      if (!item.oldPath || !item.newPath) {
        errors.push(`item invalide (chemin manquant) dans ${loadedPart.fileName}: ${label}`);
        continue;
      }
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
  const partsByFileName = new Map(parts.map((p) => [p.fileName, p]));

  const { errors: validationErrors, duplicateGroups } = validate(parts);
  if (validationErrors.length > 0) {
    console.error("Rapport invalide, apply annulé :");
    for (const error of validationErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  if (duplicateGroups.size > 0) {
    console.log(`${duplicateGroups.size} newPath en double détecté(s), ignoré(s) :`);
    const touchedParts = new Set<string>();

    for (const [newPath, group] of duplicateGroups) {
      console.log(`  - ${newPath} (${group.length} fichiers)`);
      for (const { item, partFileName } of group) {
        item.status = "failed";
        item.error = "newPath en double avec un autre item du rapport";
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
