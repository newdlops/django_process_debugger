import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import {
  MCP_MANIFEST_SCHEMA_VERSION,
  McpRegistrySecurityError,
  McpWindowIdCollisionError,
  createMcpWindowId,
  defaultMcpRegistryDir,
  publishMcpWindowManifest,
} from '../../mcp/windowRegistry';

describe('Feature: MCP window discovery registry', function () {
  it('uses a stable per-user default namespace instead of a shared /tmp path', function () {
    const registryDir = defaultMcpRegistryDir();
    assert.strictEqual(path.basename(registryDir), 'mcp');
    if (typeof process.getuid === 'function') {
      assert.strictEqual(
        path.basename(path.dirname(registryDir)),
        `django-process-debugger-uid-${process.getuid()}`,
      );
    } else {
      assert.match(path.basename(path.dirname(registryDir)), /^django-process-debugger-user-[a-f0-9]{16}$/);
    }
    assert.notStrictEqual(
      registryDir,
      path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'django-process-debugger', 'mcp'),
    );
  });

  it('publishes a private leased manifest and removes only its own record', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-registry-'));
    const registryDir = path.join(root, 'registry');
    const windowId = createMcpWindowId();
    const publisher = await publishMcpWindowManifest({
      windowId,
      extensionPid: process.pid,
      url: 'http://127.0.0.1:43210/mcp',
      token: 'a'.repeat(64),
      workspaceFolders: [{
        name: 'fixture',
        uri: 'file:///fixture',
        fsPath: '/fixture',
        canonicalPath: '/fixture',
      }],
      extensionVersion: 'test',
    }, {
      registryDir,
      heartbeatMs: 20,
      leaseMs: 100,
    });
    const lockPath = path.join(path.dirname(publisher.manifestPath), `${windowId}.lock`);

    try {
      const first = JSON.parse(await fs.readFile(publisher.manifestPath, 'utf-8'));
      await fs.access(lockPath);
      assert.strictEqual(first.schemaVersion, MCP_MANIFEST_SCHEMA_VERSION);
      assert.strictEqual(first.windowId, windowId);
      assert.strictEqual(first.extensionPid, process.pid);
      assert.ok(Date.parse(first.leaseExpiresAt) > Date.parse(first.updatedAt));

      if (process.platform !== 'win32') {
        const directoryMode = (await fs.stat(registryDir)).mode & 0o777;
        const fileMode = (await fs.stat(publisher.manifestPath)).mode & 0o777;
        assert.strictEqual(directoryMode, 0o700);
        assert.strictEqual(fileMode, 0o600);
      }

      await new Promise((resolve) => setTimeout(resolve, 35));
      const refreshed = JSON.parse(await fs.readFile(publisher.manifestPath, 'utf-8'));
      assert.ok(Date.parse(refreshed.updatedAt) >= Date.parse(first.updatedAt));
    } finally {
      await publisher.dispose();
      await assert.rejects(fs.access(publisher.manifestPath));
      await assert.rejects(fs.access(lockPath));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not remove a manifest replaced by another owner', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-registry-owner-'));
    const publisher = await publishMcpWindowManifest({
      windowId: 'window-owner-test',
      extensionPid: process.pid,
      url: 'http://127.0.0.1:43210/mcp',
      token: 'b'.repeat(64),
      workspaceFolders: [],
      extensionVersion: 'test',
    }, {
      registryDir: root,
      heartbeatMs: 60_000,
      leaseMs: 120_000,
    });

    try {
      await fs.writeFile(publisher.manifestPath, JSON.stringify({
        windowId: 'window-owner-test',
        extensionPid: process.pid,
        token: 'replacement-owner',
      }), 'utf-8');
      await publisher.dispose();
      await fs.access(publisher.manifestPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('recovers after a transient heartbeat write failure', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-registry-recovery-'));
    const publisher = await publishMcpWindowManifest({
      windowId: 'window-heartbeat-recovery',
      extensionPid: process.pid,
      url: 'http://127.0.0.1:43210/mcp',
      token: 'c'.repeat(64),
      workspaceFolders: [],
      extensionVersion: 'test',
    }, {
      registryDir: root,
      heartbeatMs: 20,
      leaseMs: 100,
    });

    try {
      const first = JSON.parse(await fs.readFile(publisher.manifestPath, 'utf-8'));
      // A directory at the destination makes atomic rename fail independently
      // of the current user's filesystem permissions.
      await fs.unlink(publisher.manifestPath);
      await fs.mkdir(publisher.manifestPath);
      await new Promise((resolve) => setTimeout(resolve, 45));
      await fs.rm(publisher.manifestPath, { recursive: true, force: true });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const recovered = JSON.parse(await fs.readFile(publisher.manifestPath, 'utf-8'));
      assert.ok(Date.parse(recovered.updatedAt) > Date.parse(first.updatedAt));
      assert.strictEqual(recovered.windowId, 'window-heartbeat-recovery');
    } finally {
      await publisher.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects pre-existing registry directories with unsafe permissions', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-registry-mode-'));
    const registryDir = path.join(root, 'registry');
    await fs.mkdir(registryDir, { mode: 0o755 });
    await fs.chmod(registryDir, 0o755);
    try {
      await assert.rejects(
        publishMcpWindowManifest({
          windowId: 'unsafe-mode-window',
          extensionPid: process.pid,
          url: 'http://127.0.0.1:43210/mcp',
          token: 'd'.repeat(64),
          workspaceFolders: [],
          extensionVersion: 'test',
        }, { registryDir }),
        (error: unknown) => error instanceof McpRegistrySecurityError
          && error.code === 'UNSAFE_MCP_REGISTRY'
          && error.reason.includes('mode must be 0700'),
      );
      assert.strictEqual((await fs.stat(registryDir)).mode & 0o777, 0o755);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link component instead of following it', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-registry-link-'));
    const realDirectory = path.join(root, 'real-registry');
    const linkedDirectory = path.join(root, 'linked-registry');
    await fs.mkdir(realDirectory, { mode: 0o700 });
    await fs.symlink(realDirectory, linkedDirectory, 'dir');
    try {
      await assert.rejects(
        publishMcpWindowManifest({
          windowId: 'unsafe-link-window',
          extensionPid: process.pid,
          url: 'http://127.0.0.1:43210/mcp',
          token: 'e'.repeat(64),
          workspaceFolders: [],
          extensionVersion: 'test',
        }, { registryDir: linkedDirectory }),
        (error: unknown) => error instanceof McpRegistrySecurityError
          && error.reason.includes('symbolic-link component'),
      );
      assert.deepStrictEqual(await fs.readdir(realDirectory), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('holds an owner-specific lifetime lock across manifest loss and refresh', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-registry-lock-'));
    const registryDir = path.join(root, 'registry');
    const common = {
      windowId: 'lifetime-lock-window',
      extensionPid: process.pid,
      url: 'http://127.0.0.1:43210/mcp',
      workspaceFolders: [],
      extensionVersion: 'first',
    };
    let announceRefreshChecked!: () => void;
    let releaseRefreshCommit!: () => void;
    const refreshChecked = new Promise<void>((resolve) => { announceRefreshChecked = resolve; });
    const refreshCommitReleased = new Promise<void>((resolve) => { releaseRefreshCommit = resolve; });
    let blockFirstRefresh = true;
    const first = await publishMcpWindowManifest({
      ...common,
      token: 'first-lifetime-owner',
    }, {
      registryDir,
      heartbeatMs: 20,
      leaseMs: 100,
      beforeRefreshCommit: async () => {
        if (blockFirstRefresh) {
          blockFirstRefresh = false;
          announceRefreshChecked();
          await refreshCommitReleased;
        }
      },
    });
    try {
      // Pause the old owner after its read/owner check but before its atomic
      // rename, then remove the manifest exactly as a new owner would observe it.
      await refreshChecked;
      await fs.unlink(first.manifestPath);
      await assert.rejects(
        publishMcpWindowManifest({
          ...common,
          token: 'second-lifetime-owner',
          extensionVersion: 'second',
        }, {
          registryDir,
          heartbeatMs: 60_000,
          leaseMs: 120_000,
        }),
        (error: unknown) => error instanceof McpWindowIdCollisionError,
      );
      releaseRefreshCommit();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const restored = JSON.parse(await fs.readFile(first.manifestPath, 'utf8')) as {
        token: string;
        extensionVersion: string;
      };
      assert.strictEqual(restored.token, 'first-lifetime-owner');
      assert.strictEqual(restored.extensionVersion, 'first');
    } finally {
      releaseRefreshCommit();
      await first.dispose();
    }

    const next = await publishMcpWindowManifest({
      ...common,
      token: 'owner-after-release',
      extensionVersion: 'after-release',
    }, {
      registryDir,
      heartbeatMs: 60_000,
      leaseMs: 120_000,
    });
    await next.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects window ids that could escape the registry directory', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-registry-id-'));
    try {
      await assert.rejects(
        publishMcpWindowManifest({
          windowId: '../outside',
          extensionPid: process.pid,
          url: 'http://127.0.0.1:43210/mcp',
          token: 'f'.repeat(64),
          workspaceFolders: [],
          extensionVersion: 'test',
        }, { registryDir: path.join(root, 'registry') }),
        /windowId must contain only/,
      );
      assert.deepStrictEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
