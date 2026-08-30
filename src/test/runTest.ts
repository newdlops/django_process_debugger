import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  let profileRoot: string | undefined;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    // TypeScript emits this file under out/test while fixtures stay under src.
    // Point VS Code at the real fixture instead of a non-existent out/test path.
    const workspacePath = path.resolve(__dirname, '../../src/test/fixtures/workspace');
    // The default test profile lives below the checkout. On macOS CI that can
    // make VS Code's Unix-domain socket exceed the 103-character platform
    // limit, which prevents live debug sessions from starting. A fresh short
    // profile also keeps each run isolated from stale settings and extensions.
    const profileParent = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    profileRoot = await fs.mkdtemp(path.join(profileParent, 'dpd-vscode-'));

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        DPD_TEST_DIAGNOSTICS: '1',
      },
      launchArgs: [
        workspacePath,
        `--user-data-dir=${path.join(profileRoot, 'user-data')}`,
        `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
        '--disable-extensions',
        '--disable-telemetry',
        '--disable-workspace-trust',
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exitCode = 1;
  } finally {
    if (profileRoot) {
      await fs.rm(profileRoot, { recursive: true, force: true }).catch((err) => {
        console.warn(`Failed to remove temporary VS Code profile ${profileRoot}:`, err);
      });
    }
  }
}

main();
