import type { Candidate } from "./types.ts";

const SCORE_EPSILON = 0.001;

function normalize(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }

  return dp[rows - 1]![cols - 1]!;
}

function titleSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
}

export function scoreCandidates(
  parsedTitle: string,
  parsedYear: number | null,
  candidates: Candidate[],
): ScoredCandidate[] {
  const scored = candidates.map((candidate) => {
    const similarity = titleSimilarity(parsedTitle, candidate.title);
    const score =
      parsedYear === null
        ? similarity
        : similarity * 0.8 + (candidate.year === parsedYear ? 0.2 : 0);
    return { candidate, score };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > SCORE_EPSILON) return b.score - a.score;
    return b.candidate.popularity - a.candidate.popularity;
  });

  return scored;
}

export type MatchResult =
  | { kind: "matched"; candidate: Candidate }
  | { kind: "ambiguous"; candidates: ScoredCandidate[] }
  | { kind: "unmatched" };

export function matchTitle(
  parsedTitle: string,
  parsedYear: number | null,
  candidates: Candidate[],
  confidenceThreshold = 0.9,
): MatchResult {
  if (candidates.length === 0) {
    return { kind: "unmatched" };
  }

  const scored = scoreCandidates(parsedTitle, parsedYear, candidates);
  const best = scored[0]!;

  if (best.score >= confidenceThreshold) {
    return { kind: "matched", candidate: best.candidate };
  }

  return { kind: "ambiguous", candidates: scored.slice(0, 5) };
}
