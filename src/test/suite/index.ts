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
  const files = await glob('**/*.test.js', { cwd: testsRoot });
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
