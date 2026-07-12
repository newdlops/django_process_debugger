import {
  McpServerInfo,
  McpTransportBackend,
  StartedMcpTransport,
  startMcpTransport,
} from './transport';
import {
  McpWindowRegistryPublisher,
  McpWorkspaceFolderManifest,
  publishMcpWindowManifest,
} from './windowRegistry';

export interface McpWindowHostOptions {
  windowId: string;
  extensionPid: number;
  extensionVersion: string;
  workspaceFolders: McpWorkspaceFolderManifest[];
  backend: McpTransportBackend;
  instructions?: string;
  serverInfo?: McpServerInfo;
  registryDir?: string;
}

export interface StartedMcpWindowHost {
  readonly windowId: string;
  readonly url: string;
  readonly manifestPath: string;
  dispose(): Promise<void>;
}

/** Start the endpoint first and publish it only after it is ready for clients. */
export async function startMcpWindowHost(
  options: McpWindowHostOptions,
): Promise<StartedMcpWindowHost> {
  let transport: StartedMcpTransport | undefined;
  let publisher: McpWindowRegistryPublisher | undefined;
  try {
    transport = await startMcpTransport({
      backend: options.backend,
      instructions: options.instructions,
      serverInfo: options.serverInfo ?? {
        name: 'django-process-debugger',
        title: 'Django Process Debugger',
        version: options.extensionVersion,
      },
      health: {
        windowId: options.windowId,
        workspaceFolders: options.workspaceFolders.map((folder) => ({
          name: folder.name,
          uri: folder.uri,
        })),
        serverVersion: options.extensionVersion,
      },
    });
    publisher = await publishMcpWindowManifest({
      windowId: options.windowId,
      extensionPid: options.extensionPid,
      url: transport.url,
      token: transport.token,
      workspaceFolders: options.workspaceFolders,
      extensionVersion: options.extensionVersion,
    }, {
      registryDir: options.registryDir,
    });
  } catch (error) {
    await Promise.allSettled([
      publisher?.dispose(),
      transport?.dispose(),
    ].filter((operation): operation is Promise<void> => operation !== undefined));
    throw error;
  }

  const activeTransport = transport;
  const activePublisher = publisher;
  let disposePromise: Promise<void> | undefined;
  return {
    windowId: options.windowId,
    url: activeTransport.url,
    manifestPath: activePublisher.manifestPath,
    dispose(): Promise<void> {
      disposePromise ??= (async () => {
        // Remove discovery first so new bridge processes cannot race shutdown.
        await activePublisher.dispose();
        await activeTransport.dispose();
      })();
      return disposePromise;
    },
  };
}
