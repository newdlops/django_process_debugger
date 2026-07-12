import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { startMcpWindowHost } from '../../mcp/windowHost';

describe('Feature: MCP window host lifecycle', function () {
  it('publishes only a listening endpoint and removes discovery before shutdown completes', async function () {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-host-'));
    const host = await startMcpWindowHost({
      windowId: 'window-host-test',
      extensionPid: process.pid,
      extensionVersion: 'test',
      workspaceFolders: [{
        name: 'workspace',
        uri: 'file:///workspace',
        fsPath: '/workspace',
        canonicalPath: '/workspace',
      }],
      registryDir,
      backend: {
        listTools: () => [],
        callTool: async () => ({ structuredContent: {} }),
      },
    });

    try {
      const manifest = JSON.parse(await fs.readFile(host.manifestPath, 'utf-8'));
      assert.strictEqual(manifest.windowId, 'window-host-test');
      assert.strictEqual(manifest.url, host.url);
      assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    } finally {
      await host.dispose();
      await host.dispose();
      await assert.rejects(fs.access(host.manifestPath));
      await fs.rm(registryDir, { recursive: true, force: true });
    }
  });
});
