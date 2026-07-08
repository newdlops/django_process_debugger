import { execFile } from 'child_process';
import { promisify } from 'util';
import { log, logError } from './logger';
import {
  TcpListeningEndpoint,
  formatEndpoint,
  normalizeListeningHost,
  parseLsofTcpListenLine,
} from './listeningEndpoint';

const execFileAsync = promisify(execFile);

export type ProcessType = 'django' | 'celery';

export interface DjangoProcess {
  pid: number;
  command: string;
  pythonPath: string;
  arch: string;
  type: ProcessType;
  host?: string;
  port?: number;
  endpoints?: TcpListeningEndpoint[];
}

export interface OwnedTcpListeningEndpoint {
  pid?: number;
  endpoint: TcpListeningEndpoint;
}

function endpointKey(endpoint: TcpListeningEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

function mergeEndpoints(
  ...endpointLists: Array<ReadonlyArray<TcpListeningEndpoint | undefined> | undefined>
): TcpListeningEndpoint[] {
  const byKey = new Map<string, TcpListeningEndpoint>();
  for (const endpointList of endpointLists) {
    for (const endpoint of endpointList ?? []) {
      if (!endpoint) { continue; }
      byKey.set(endpointKey(endpoint), endpoint);
    }
  }
  return [...byKey.values()];
}

function isLoopbackAlias(endpoint: TcpListeningEndpoint): boolean {
  const host = normalizeListeningHost(endpoint.host).toLowerCase();
  return host.startsWith('127.') && host !== '127.0.0.1';
}

function parseLsofPid(line: string): number | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] === 'COMMAND') {
    return undefined;
  }

  const pid = parseInt(parts[1], 10);
  return Number.isInteger(pid) ? pid : undefined;
}

export function mergeLoopbackAliasEndpoints(
  processes: DjangoProcess[],
  aliasesByPort: ReadonlyMap<number, ReadonlyArray<OwnedTcpListeningEndpoint>>,
): void {
  const discoveredDjangoPids = new Set(processes.map((p) => p.pid));

  for (const processInfo of processes) {
    if (processInfo.type !== 'django' || !processInfo.endpoints?.length) {
      continue;
    }

    const aliases = processInfo.endpoints.flatMap((endpoint) =>
      (aliasesByPort.get(endpoint.port) ?? [])
        .filter((alias) =>
          alias.pid === processInfo.pid ||
          alias.pid === undefined ||
          !discoveredDjangoPids.has(alias.pid),
        )
        .map((alias) => alias.endpoint),
    );
    processInfo.endpoints = mergeEndpoints(processInfo.endpoints, aliases);
  }
}

export class DjangoProcessFinder {
  /**
   * Find running Django processes on the local machine.
   * Uses `ps` to locate python processes running manage.py or django commands.
   */
  async findDjangoProcesses(): Promise<DjangoProcess[]> {
    try {
      const { stdout } = await execFileAsync('ps', ['aux']);
      log(`[ProcessFinder] ps aux returned ${stdout.split('\n').length} lines`);

      const lines = stdout.split('\n');
      const processes: DjangoProcess[] = [];

      for (const line of lines) {
        if (!this.isDjangoProcess(line)) {
          continue;
        }

        log(`[ProcessFinder] Matched line: ${line.trim()}`);
        const parsed = this.parsePsLine(line);
        if (parsed) {
          processes.push(parsed);
        }
      }

      // Resolve listening endpoints for each process.
      await Promise.all(processes.map(async (p) => {
        const commandEndpoint = this.extractEndpointFromCommand(p.command);
        const lsofEndpoints = await this.findListeningEndpoints(p.pid, commandEndpoint?.port);
        p.endpoints = lsofEndpoints.length > 0
          ? mergeEndpoints(lsofEndpoints)
          : mergeEndpoints(commandEndpoint ? [commandEndpoint] : undefined);
      }));

      await this.addLoopbackAliasEndpoints(processes);

      for (const p of processes) {
        const endpoint = p.endpoints?.[0];
        p.host = endpoint?.host;
        p.port = endpoint?.port;
        if (p.endpoints && p.endpoints.length > 1) {
          log(`[ProcessFinder] PID=${p.pid} endpoints: ${p.endpoints.map(formatEndpoint).join(', ')}`);
        }
      }

      log(`[ProcessFinder] Found ${processes.length} Django process(es)`);
      return processes;
    } catch (err) {
      logError('[ProcessFinder] Failed to run ps', err);
      return [];
    }
  }

  private isDjangoProcess(line: string): boolean {
    return this.classifyProcess(line) !== null;
  }

  classifyProcess(line: string): ProcessType | null {
    const celeryPatterns = [
      /celery\s+.*worker/,
      /-m\s+celery\s+worker/,
    ];
    if (celeryPatterns.some((p) => p.test(line))) {
      return 'celery';
    }

    const djangoPatterns = [
      /manage\.py\s+runserver/,
      /django.*runserver/i,
      /uvicorn.*\.asgi/,
      /gunicorn.*\.wsgi/,
      /daphne.*\.asgi/,
    ];
    if (djangoPatterns.some((p) => p.test(line))) {
      return 'django';
    }

    return null;
  }

  private parsePsLine(line: string): DjangoProcess | null {
    // ps aux format: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) {
      return null;
    }

    const pid = parseInt(parts[1], 10);
    if (isNaN(pid)) {
      return null;
    }

    const command = parts.slice(10).join(' ');

    const pythonPath = this.extractPythonPath(command);
    const type = this.classifyProcess(command) ?? 'django';

    return {
      pid,
      command,
      pythonPath,
      arch: process.arch, // arm64 on Apple Silicon
      type,
    };
  }

  private extractPythonPath(command: string): string {
    // Extract the python executable path from the command
    const match = command.match(/^(\S*python\S*)/);
    return match ? match[1] : 'python';
  }

  /**
   * Extract port from the command line arguments.
   * Handles: manage.py runserver 8080, manage.py runserver 0.0.0.0:8000,
   *          uvicorn --port 8080, gunicorn -b :8000, gunicorn --bind 0.0.0.0:8000
   */
  extractPortFromCommand(command: string): number | undefined {
    return this.extractEndpointFromCommand(command)?.port;
  }

  extractEndpointFromCommand(command: string): TcpListeningEndpoint | undefined {
    // manage.py runserver [addr:]port
    const runserverMatch = command.match(/runserver\s+(\S+)/);
    if (runserverMatch) {
      const endpoint = this.parseAddressEndpoint(runserverMatch[1]);
      if (endpoint) {
        return endpoint;
      }
    }

    // uvicorn --port PORT or --host X --port PORT
    const uvicornPortMatch = command.match(/--port\s+(\d+)/);
    if (uvicornPortMatch) {
      const hostMatch = command.match(/--host\s+(\S+)/);
      return this.endpoint(hostMatch?.[1], parseInt(uvicornPortMatch[1], 10));
    }

    // gunicorn -b / --bind [addr:]port  (addr can be empty, e.g. `-b :8000`)
    const gunicornMatch = command.match(/(?:-b|--bind)\s+(\S+)/);
    if (gunicornMatch) {
      const endpoint = this.parseAddressEndpoint(gunicornMatch[1]);
      if (endpoint) {
        return endpoint;
      }
    }

    // daphne -p PORT or --port PORT
    const daphneMatch = command.match(/(?:-p|--port)\s+(\d+)/);
    if (daphneMatch) {
      const hostMatch = command.match(/(?:-b|--bind)\s+(\S+)/);
      return this.endpoint(hostMatch?.[1], parseInt(daphneMatch[1], 10));
    }

    return undefined;
  }

  private endpoint(host: string | undefined, port: number): TcpListeningEndpoint | undefined {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    return {
      host: normalizeListeningHost(host && host.length > 0 ? host : '127.0.0.1'),
      port,
    };
  }

  private parseAddressEndpoint(address: string): TcpListeningEndpoint | undefined {
    if (!address || address.startsWith('unix:')) {
      return undefined;
    }

    const portOnly = address.match(/^(\d+)$/);
    if (portOnly) {
      return this.endpoint(undefined, parseInt(portOnly[1], 10));
    }

    const bracketed = address.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracketed) {
      return this.endpoint(bracketed[1], parseInt(bracketed[2], 10));
    }

    const emptyHost = address.match(/^:(\d+)$/);
    if (emptyHost) {
      return this.endpoint(undefined, parseInt(emptyHost[1], 10));
    }

    const hostPort = address.match(/^(.+):(\d+)$/);
    if (hostPort) {
      return this.endpoint(hostPort[1], parseInt(hostPort[2], 10));
    }

    return undefined;
  }

  /**
   * Find TCP listening endpoints for a given PID using lsof.
   */
  private async findListeningEndpoints(
    pid: number,
    expectedPort?: number,
  ): Promise<TcpListeningEndpoint[]> {
    const endpoints: TcpListeningEndpoint[] = [];
    try {
      const { stdout } = await execFileAsync('lsof', [
        '-a', '-iTCP', '-sTCP:LISTEN', '-nP', '-p', String(pid),
      ]);
      // Parse lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      // NAME looks like *:8000, 127.0.0.1:8000, or 127.x.x.x:8000 (LISTEN)
      for (const line of stdout.split('\n')) {
        const endpoint = parseLsofTcpListenLine(line);
        if (endpoint && (!expectedPort || endpoint.port === expectedPort)) {
          endpoints.push(endpoint);
        }
      }
    } catch {
      // lsof may fail for permission reasons — that's fine
    }
    return mergeEndpoints(endpoints);
  }

  private async addLoopbackAliasEndpoints(processes: DjangoProcess[]): Promise<void> {
    const ports = new Set<number>();

    for (const processInfo of processes) {
      if (processInfo.type !== 'django') { continue; }
      for (const endpoint of processInfo.endpoints ?? []) {
        ports.add(endpoint.port);
      }
    }

    if (ports.size === 0) {
      return;
    }

    const aliasesByPort = await this.findLoopbackAliasEndpointsByPort(ports);
    mergeLoopbackAliasEndpoints(processes, aliasesByPort);
  }

  private async findLoopbackAliasEndpointsByPort(
    ports: ReadonlySet<number>,
  ): Promise<Map<number, OwnedTcpListeningEndpoint[]>> {
    const byPort = new Map<number, OwnedTcpListeningEndpoint[]>();

    try {
      const { stdout } = await execFileAsync('lsof', [
        '-iTCP', '-sTCP:LISTEN', '-nP',
      ]);
      for (const line of stdout.split('\n')) {
        const endpoint = parseLsofTcpListenLine(line);
        if (!endpoint || !ports.has(endpoint.port) || !isLoopbackAlias(endpoint)) {
          continue;
        }

        const endpoints = byPort.get(endpoint.port) ?? [];
        endpoints.push({ pid: parseLsofPid(line), endpoint });
        byPort.set(endpoint.port, endpoints);
      }
    } catch {
      // lsof may fail for permission reasons — direct process endpoints still work.
    }

    return byPort;
  }

  /**
   * Given a selected PID, resolve to the actual debuggable Python process.
   *
   * Django process tree:
   *   uv run python manage.py runserver 8004     (wrapper — not Python)
   *     └─ .venv/bin/python3 manage.py runserver 8004  (parent — autoreloader)
   *          └─ .venv/bin/python3 manage.py runserver 8004  (child — actual server)
   *
   * We want the deepest Python child that matches the same server pattern.
   * If the selected PID is already the leaf, return it as-is.
   */
  async resolveDebuggablePid(pid: number): Promise<{ pid: number; pythonPath: string }> {
    // Build a map of pid -> { command, children }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid,command']);
    const lines = stdout.trim().split('\n').slice(1); // skip header

    interface ProcInfo { pid: number; ppid: number; command: string }
    const procs: ProcInfo[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const p = parseInt(parts[0], 10);
      const pp = parseInt(parts[1], 10);
      const cmd = parts.slice(2).join(' ');
      if (!isNaN(p) && !isNaN(pp)) {
        procs.push({ pid: p, ppid: pp, command: cmd });
      }
    }

    const childrenOf = (parentPid: number): ProcInfo[] =>
      procs.filter((p) => p.ppid === parentPid);

    const isPythonProcess = (cmd: string): boolean =>
      /python\d?(\.\d+)*\s/.test(cmd) || /\/python\d?(\.\d+)*$/.test(cmd);

    const extractPython = (cmd: string): string => {
      const m = cmd.match(/(\S*python\S*)/);
      return m ? m[1] : 'python3';
    };

    // Walk down from selected PID to find the deepest Python child
    let current = pid;
    let bestPid = pid;
    let bestPythonPath = 'python3';

    // First, check the selected process itself
    const selectedProc = procs.find((p) => p.pid === pid);
    if (selectedProc && isPythonProcess(selectedProc.command)) {
      bestPythonPath = extractPython(selectedProc.command);
    }

    // Walk down the tree (max 5 levels to avoid infinite loops)
    for (let depth = 0; depth < 5; depth++) {
      const children = childrenOf(current);
      // Find a Python child that matches our server patterns
      const pythonChild = children.find((c) =>
        isPythonProcess(c.command) && this.classifyProcess(c.command) !== null
      );
      if (!pythonChild) { break; }

      bestPid = pythonChild.pid;
      bestPythonPath = extractPython(pythonChild.command);
      current = pythonChild.pid;
    }

    log(`[ProcessFinder] resolveDebuggablePid: ${pid} → ${bestPid} (${bestPythonPath})`);
    return { pid: bestPid, pythonPath: bestPythonPath };
  }
}
