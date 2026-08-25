import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readReport } from "../report/reader.ts";
import { renderReportHtml } from "../html/render.ts";

export interface RenderOptions {
  report: string;
}

function parseRenderArgs(argv: string[]): RenderOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
    },
  });

  if (!values.report) {
    throw new Error("Usage: jellyname render --report <manifest.json>");
  }

  return { report: values.report };
}

export async function renderReport(manifestPath: string): Promise<string> {
  const report = await readReport(manifestPath);
  const html = renderReportHtml(report);

  const outputPath = join(dirname(manifestPath), "report.html");
  await writeFile(outputPath, html);

  return outputPath;
}

export async function runRender(argv: string[]): Promise<void> {
  const options = parseRenderArgs(argv);
  const outputPath = await renderReport(options.report);
  console.log(`Page generated: ${outputPath}`);
}
