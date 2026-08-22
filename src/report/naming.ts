import { join } from "node:path";

const FILESYSTEM_RESERVED_CHARS = ["<", ">", ":", '"', "/", "\\", "|", "?", "*"];
const CONTROL_CHAR_CODES = Array.from({ length: 0x20 }, (_, code) => code);

const INVALID_CHARS = new Set([
  ...FILESYSTEM_RESERVED_CHARS,
  ...CONTROL_CHAR_CODES.map((code) => String.fromCharCode(code)),
]);

export function sanitizeSegment(segment: string): string {
  return Array.from(segment)
    .filter((char) => !INVALID_CHARS.has(char))
    .join("")
    .trim();
}

export function movieTargetPath(libraryRoot: string, title: string, year: number, ext: string): string {
  const name = `${sanitizeSegment(title)} (${year})`;
  return join(libraryRoot, name, `${name}${ext}`);
}

export function showRoot(libraryRoot: string, title: string): string {
  return join(libraryRoot, sanitizeSegment(title));
}

export function seasonTargetDir(showRootDir: string, season: number): string {
  return join(showRootDir, `Season ${String(season).padStart(2, "0")}`);
}

export function episodeFileName(
  title: string,
  season: number,
  episode: number,
  episodeTitle: string | null,
  ext: string,
): string {
  const code = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  const base = episodeTitle
    ? `${sanitizeSegment(title)} - ${code} - ${sanitizeSegment(episodeTitle)}`
    : `${sanitizeSegment(title)} - ${code}`;
  return `${base}${ext}`;
}
