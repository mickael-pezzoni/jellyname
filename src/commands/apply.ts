import { parseArgs } from "node:util";

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

export async function runApply(argv: string[]): Promise<void> {
  const options = parseApplyArgs(argv);
  console.log(`apply: report=${options.report} yes=${options.yes} retryFailed=${options.retryFailed}`);
  throw new Error("apply: pas encore implémenté");
}
