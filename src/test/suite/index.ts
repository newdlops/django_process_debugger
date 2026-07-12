import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';
import { glob } from 'glob';
import { getPerf } from './perfReporter';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 60_000,
    reporter: 'spec',
  });

  const testsRoot = __dirname;
  const requestedFiles = new Set(
    (process.env.DPD_TEST_FILES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const invalidFiles = [...requestedFiles].filter((file) =>
    path.basename(file) !== file || !file.endsWith('.test.js'));
  if (invalidFiles.length > 0) {
    throw new Error(`DPD_TEST_FILES accepts test basenames only: ${invalidFiles.join(', ')}`);
  }
  const discoveredFiles = await glob('**/*.test.js', { cwd: testsRoot });
  const files = requestedFiles.size === 0
    ? discoveredFiles
    : discoveredFiles.filter((file) => requestedFiles.has(path.basename(file)));
  const matchedFiles = new Set(files.map((file) => path.basename(file)));
  const missingFiles = [...requestedFiles].filter((file) => !matchedFiles.has(file));
  if (missingFiles.length > 0) {
    throw new Error(`DPD_TEST_FILES did not match compiled tests: ${missingFiles.join(', ')}`);
  }
  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      try {
        writePerfReport();
      } catch (err) {
        console.error('[perf] report write failed:', err);
      }
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed`));
      } else {
        resolve();
      }
    });
  });
}

function writePerfReport(): void {
  const perf = getPerf();
  const entries = perf.snapshot();
  if (entries.length === 0) {
    return;
  }

  const outDir = path.resolve(__dirname, '../../../test-results');
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'perf-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    entries,
  }, null, 2));

  const mdPath = path.join(outDir, 'perf-report.md');
  fs.writeFileSync(mdPath, perf.toMarkdown());

  console.log(`\n[perf] Report written to:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
  console.log(perf.toConsoleSummary());
}
