import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    // TypeScript emits this file under out/test while fixtures stay under src.
    // Point VS Code at the real fixture instead of a non-existent out/test path.
    const workspacePath = path.resolve(__dirname, '../../src/test/fixtures/workspace');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-extensions',
        '--disable-workspace-trust',
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
