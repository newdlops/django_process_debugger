import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { log, logError } from './logger';
import {
  TcpListeningEndpoint,
  formatEndpoint,
  normalizeListeningHost,
  parseLsofTcpListenLine,
} from './listeningEndpoint';

const execFileAsync = promisify(execFile);
const PORT_MANAGER_AGENT_REQUEST_TIMEOUT_MS = 1_000;
const CELERY_PIDFILE_SCAN_LIMIT = 64;

export type ProcessType = 'django' | 'celery';

export interface DjangoProcess {
  pid: number;
  command: string;
  pythonPath: string;
  arch: string;
  type: ProcessType;
  cwd?: string;
  processGroupId?: number;
  workerPids?: number[];
  host?: string;
  port?: number;
  endpoints?: TcpListeningEndpoint[];
}

export interface OwnedTcpListeningEndpoint {
  pid?: number;
  endpoint: TcpListeningEndpoint;
}

export interface PortManagerProcessRow {
  id?: string;
  pid?: number;
  name?: string;
  command?: string;
  cwd?: string;
  networkId?: string;
  terminalSessionId?: string;
  processGroupId?: number;
  requestedPort?: number;
  actualPort?: number;
  status?: string;
  url?: string;
  source?: string;
}

export interface PortManagerRouteRow {
  logicalPort?: number;
  actualPort?: number;
  routeDirection?: string;
  host?: string;
  processId?: string;
  processName?: string;
  status?: string;
  source?: string;
}

export interface PortManagerListenerRow {
  localAddress?: string;
  port?: number;
  pid?: number;
  processName?: string;
  command?: string;
}

export interface PortManagerSnapshot {
  processes?: PortManagerProcessRow[];
  routes?: PortManagerRouteRow[];
  listeners?: PortManagerListenerRow[];
}

interface PortManagerResponseMessage {
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: string;
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

/**
 * Port managers can own 127.0.0.1:PORT while the real server listens on a
 * 127.x loopback alias. Treat both sides as mergeable picker endpoints.
 */
export function isIpv4LoopbackEndpoint(endpoint: TcpListeningEndpoint): boolean {
  const host = normalizeListeningHost(endpoint.host).toLowerCase();
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseLsofPid(line: string): number | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] === 'COMMAND') {
    return undefined;
  }

  const pid = parseInt(parts[1], 10);
  return Number.isInteger(pid) ? pid : undefined;
}

function isValidPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) > 0 && (port as number) <= 65535;
}

function isPositivePid(pid: unknown): pid is number {
  return Number.isInteger(pid) && (pid as number) > 0;
}

function uniqueSortedPids(...pidLists: Array<ReadonlyArray<number | undefined> | undefined>): number[] {
  const pids = new Set<number>();
  for (const pidList of pidLists) {
    for (const pid of pidList ?? []) {
      if (isPositivePid(pid)) {
        pids.add(pid);
      }
    }
  }
  return [...pids].sort((a, b) => a - b);
}

function isPythonLikeText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const firstToken = text.trim().split(/\s+/, 1)[0] ?? '';
  const executableName = path.basename(firstToken).toLowerCase();
  return /^python(?:\d+(?:\.\d+)*)?$/.test(executableName);
}

function isInternalDebugProcessText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return [
    /(?:^|\s)\S*debugpy[\\/]adapter(?:\s|$)/i,
    /(?:^|\s)--for-server\s+\d+.*(?:^|\s)--server-access-token\s+/i,
    /(?:^|\s)\S*debugpy[\\/]launcher(?:\s|$)/i,
  ].some((pattern) => pattern.test(text));
}

export function isCeleryWorkerCommand(line: string | undefined): boolean {
  if (!line) {
    return false;
  }
  return [
    /(?:^|\s)(?:\S*\/)?celery(?:\s|$).*?\bworker\b/i,
    /(?:^|\s)-m\s+celery(?:\s|$).*?\bworker\b/i,
    /(?:^|\s)(?:\S*\/)?celery(?:\s|$).*?\bmulti\s+start\b/i,
    /(?:^|\s)(?:\S*\/)?celeryd(?:\s|$)/i,
  ].some((pattern) => pattern.test(line));
}

function isPortManagerPythonProcess(
  processRow: PortManagerProcessRow,
  routeRow?: PortManagerRouteRow,
): boolean {
  return (
    isPythonLikeText(processRow.command) ||
    isPythonLikeText(processRow.name) ||
    isPythonLikeText(routeRow?.processName)
  );
}

function isPortManagerInternalDebugProcess(
  processRow: PortManagerProcessRow,
  routeRow: PortManagerRouteRow,
  listenerRows: PortManagerListenerRow[] = [],
): boolean {
  return [
    processRow.command,
    processRow.name,
    routeRow.processName,
    ...listenerRows.map((listener) => listener.command),
    ...listenerRows.map((listener) => listener.processName),
  ].some(isInternalDebugProcessText);
}

function portManagerRoutePort(route: PortManagerRouteRow): number | undefined {
  return isValidPort(route.actualPort)
    ? route.actualPort
    : isValidPort(route.logicalPort)
      ? route.logicalPort
      : undefined;
}

function portManagerProcessPorts(processRow: PortManagerProcessRow): number[] {
  return [
    processRow.actualPort,
    processRow.requestedPort,
  ].filter(isValidPort);
}

function portManagerProcessMatchesRoutePort(
  processRow: PortManagerProcessRow,
  routePort: number | undefined,
): boolean {
  if (!routePort) {
    return true;
  }
  const processPorts = portManagerProcessPorts(processRow);
  return processPorts.length === 0 || processPorts.includes(routePort);
}

function hasSamePortManagerExecutionScope(
  left: PortManagerProcessRow,
  right: PortManagerProcessRow,
): boolean {
  if (
    isPositivePid(left.processGroupId) &&
    isPositivePid(right.processGroupId) &&
    left.processGroupId === right.processGroupId
  ) {
    return true;
  }
  if (
    left.terminalSessionId &&
    right.terminalSessionId &&
    left.terminalSessionId === right.terminalSessionId
  ) {
    return true;
  }
  return !!(
    left.cwd &&
    right.cwd &&
    left.cwd === right.cwd &&
    left.networkId &&
    right.networkId &&
    left.networkId === right.networkId
  );
}

function addPortManagerCwdRoot(roots: Set<string>, cwd: string | undefined): void {
  if (!cwd || cwd.trim().length === 0) {
    return;
  }
  const resolved = path.resolve(cwd);
  if (resolved === path.parse(resolved).root) {
    return;
  }
  roots.add(resolved);
}

function addLikelyProjectRoots(roots: Set<string>, cwd: string | undefined): void {
  if (!cwd || cwd.trim().length === 0) {
    return;
  }

  const resolved = path.resolve(cwd);
  addPortManagerCwdRoot(roots, resolved);

  if (path.basename(resolved) === 'docker') {
    addPortManagerCwdRoot(roots, path.dirname(resolved));
  }

  const parent = path.dirname(resolved);
  if (path.basename(resolved) === 'client' && path.basename(parent) === 'zuzu') {
    addPortManagerCwdRoot(roots, path.dirname(parent));
  }
}

export function collectPortManagerCeleryScanRoots(snapshot: PortManagerSnapshot): string[] {
  const roots = new Set<string>();
  for (const processRow of snapshot.processes ?? []) {
    if (
      processRow.status !== 'running' ||
      processRow.source === 'detected' ||
      isInternalDebugProcessText(processRow.command) ||
      isInternalDebugProcessText(processRow.name)
    ) {
      continue;
    }
    addLikelyProjectRoots(roots, processRow.cwd);
  }
  return [...roots];
}

function endpointFromUrl(url: string | undefined): TcpListeningEndpoint | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    const port = parseInt(parsed.port, 10);
    if (!isValidPort(port)) {
      return undefined;
    }
    return {
      host: normalizeListeningHost(parsed.hostname),
      port,
    };
  } catch {
    return undefined;
  }
}

function endpointFromRoute(route: PortManagerRouteRow): TcpListeningEndpoint | undefined {
  const port = portManagerRoutePort(route);
  if (!port) {
    return undefined;
  }
  return {
    host: normalizeListeningHost(route.host && route.host.length > 0 ? route.host : '127.0.0.1'),
    port,
  };
}

function endpointFromListener(listener: PortManagerListenerRow): TcpListeningEndpoint | undefined {
  if (!isValidPort(listener.port)) {
    return undefined;
  }
  return {
    host: normalizeListeningHost(listener.localAddress && listener.localAddress.length > 0
      ? listener.localAddress
      : '127.0.0.1'),
    port: listener.port,
  };
}

function portManagerCommand(processRow: PortManagerProcessRow, route: PortManagerRouteRow): string {
  const command = processRow.command && processRow.command.length > 0
    ? processRow.command
    : processRow.name && processRow.name.length > 0
      ? processRow.name
      : route.processName && route.processName.length > 0
        ? route.processName
        : 'python3';
  const cwd = processRow.cwd && processRow.cwd.length > 0 ? processRow.cwd : undefined;
  const endpoint = endpointFromRoute(route);
  const details = [
    'Port Manager',
    cwd,
    endpoint ? `:${endpoint.port}` : undefined,
  ].filter((item): item is string => !!item);
  return `${command} (${details.join(', ')})`;
}

function portManagerPythonPath(
  processRow: PortManagerProcessRow,
  routeRow: PortManagerRouteRow,
  listenerRows: PortManagerListenerRow[],
): string {
  for (const text of [
    processRow.command,
    processRow.name,
    routeRow.processName,
    ...listenerRows.map((listener) => listener.command),
    ...listenerRows.map((listener) => listener.processName),
  ]) {
    if (isPythonLikeText(text)) {
      return text!.trim().split(/\s+/, 1)[0]!;
    }
  }
  return 'python3';
}

function isPortManagerListenRoute(route: PortManagerRouteRow): boolean {
  return (
    route.status === 'running' &&
    (route.routeDirection === undefined || route.routeDirection === 'listen') &&
    isValidPort(portManagerRoutePort(route)) &&
    typeof route.processId === 'string' &&
    route.processId.length > 0
  );
}

function findPortManagerWorkerPids(
  processRow: PortManagerProcessRow,
  route: PortManagerRouteRow,
  processRows: PortManagerProcessRow[],
  listenerRows: PortManagerListenerRow[],
): number[] {
  if (!isPositivePid(processRow.pid)) {
    return [];
  }

  const routePort = portManagerRoutePort(route);
  const siblingProcessPids = processRows
    .filter((candidate) =>
      candidate !== processRow &&
      candidate.status === 'running' &&
      candidate.source !== 'detected' &&
      isPositivePid(candidate.pid) &&
      candidate.pid !== processRow.pid &&
      isPortManagerPythonProcess(candidate) &&
      portManagerProcessMatchesRoutePort(candidate, routePort) &&
      hasSamePortManagerExecutionScope(processRow, candidate),
    )
    .map((candidate) => candidate.pid);

  const listenerPids = listenerRows
    .filter((listener) => {
      if (
        !isPositivePid(listener.pid) ||
        listener.pid === processRow.pid ||
        (routePort !== undefined && listener.port !== routePort) ||
        (!isPythonLikeText(listener.command) && !isPythonLikeText(listener.processName))
      ) {
        return false;
      }

      const listenerProcess = processRows.find((candidate) => candidate.pid === listener.pid);
      if (!listenerProcess) {
        return true;
      }

      return (
        listenerProcess.status === 'running' &&
        listenerProcess.source !== 'detected' &&
        isPortManagerPythonProcess(listenerProcess) &&
        portManagerProcessMatchesRoutePort(listenerProcess, routePort) &&
        hasSamePortManagerExecutionScope(processRow, listenerProcess)
      );
    })
    .map((listener) => listener.pid);

  return uniqueSortedPids(siblingProcessPids, listenerPids);
}

export function buildPortManagerDjangoProcesses(snapshot: PortManagerSnapshot): DjangoProcess[] {
  const processRows = snapshot.processes ?? [];
  const routeRows = snapshot.routes ?? [];
  const listenerRows = snapshot.listeners ?? [];
  const processesById = new Map<string, PortManagerProcessRow>();
  const listenersByPid = new Map<number, PortManagerListenerRow[]>();
  const candidatesByPid = new Map<number, DjangoProcess>();

  for (const processRow of processRows) {
    if (typeof processRow.id === 'string' && processRow.id.length > 0) {
      processesById.set(processRow.id, processRow);
    }
  }

  for (const listener of listenerRows) {
    if (!isPositivePid(listener.pid)) {
      continue;
    }
    const existing = listenersByPid.get(listener.pid) ?? [];
    existing.push(listener);
    listenersByPid.set(listener.pid, existing);
  }

  for (const route of routeRows) {
    if (!isPortManagerListenRoute(route)) {
      continue;
    }

    const processRow = processesById.get(route.processId!);
    if (
      !processRow ||
      processRow.status !== 'running' ||
      processRow.source === 'detected' ||
      !isPositivePid(processRow.pid) ||
      !isPortManagerPythonProcess(processRow, route)
    ) {
      continue;
    }

    const processListeners = listenersByPid.get(processRow.pid) ?? [];
    if (isPortManagerInternalDebugProcess(processRow, route, processListeners)) {
      continue;
    }

    const routeEndpoint = endpointFromRoute(route);
    const routePort = routeEndpoint?.port;
    const matchingListenerEndpoints = processListeners
      .filter((listener) => routePort === undefined || listener.port === routePort)
      .map(endpointFromListener)
      .filter((endpoint): endpoint is TcpListeningEndpoint => !!endpoint);
    const endpoints = mergeEndpoints(
      routeEndpoint ? [routeEndpoint] : undefined,
      endpointFromUrl(processRow.url) ? [endpointFromUrl(processRow.url)] : undefined,
      matchingListenerEndpoints,
    );

    if (endpoints.length === 0) {
      continue;
    }

    const existing = candidatesByPid.get(processRow.pid);
    if (existing) {
      existing.endpoints = mergeEndpoints(existing.endpoints, endpoints);
      existing.workerPids = uniqueSortedPids(
        existing.workerPids,
        findPortManagerWorkerPids(processRow, route, processRows, listenerRows),
      );
      continue;
    }

    candidatesByPid.set(processRow.pid, {
      pid: processRow.pid,
      command: portManagerCommand(processRow, route),
      pythonPath: portManagerPythonPath(processRow, route, processListeners),
      arch: process.arch,
      type: 'django',
      cwd: processRow.cwd,
      processGroupId: processRow.processGroupId,
      workerPids: findPortManagerWorkerPids(processRow, route, processRows, listenerRows),
      host: endpoints[0].host,
      port: endpoints[0].port,
      endpoints,
    });
  }

  return [...candidatesByPid.values()];
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
        const [lsofEndpoints, cwd] = await Promise.all([
          this.findListeningEndpoints(p.pid, commandEndpoint?.port),
          this.findProcessCwd(p.pid),
        ]);
        p.cwd = p.cwd ?? cwd;
        p.endpoints = lsofEndpoints.length > 0
          ? mergeEndpoints(lsofEndpoints)
          : mergeEndpoints(commandEndpoint ? [commandEndpoint] : undefined);
      }));

      const portManagerProcesses = await this.findPortManagerDjangoProcesses();
      this.mergeDiscoveredProcesses(processes, portManagerProcesses);

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

  private mergeDiscoveredProcesses(
    processes: DjangoProcess[],
    discoveredProcesses: DjangoProcess[],
  ): void {
    const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));

    for (const discovered of discoveredProcesses) {
      const existing = byPid.get(discovered.pid);
      if (!existing) {
        processes.push(discovered);
        byPid.set(discovered.pid, discovered);
        continue;
      }

      existing.endpoints = mergeEndpoints(existing.endpoints, discovered.endpoints);
      existing.host = existing.endpoints[0]?.host ?? existing.host;
      existing.port = existing.endpoints[0]?.port ?? existing.port;
      existing.cwd = existing.cwd ?? discovered.cwd;
      existing.processGroupId = existing.processGroupId ?? discovered.processGroupId;
      existing.workerPids = uniqueSortedPids(existing.workerPids, discovered.workerPids);
      if (!existing.pythonPath || existing.pythonPath === 'python') {
        existing.pythonPath = discovered.pythonPath;
      }
    }
  }

  private async findPortManagerDjangoProcesses(): Promise<DjangoProcess[]> {
    const snapshot = await this.queryPortManagerSnapshot();
    if (!snapshot) {
      return [];
    }

    const processes = buildPortManagerDjangoProcesses(snapshot);
    const celeryPidfileProcesses = await this.findPortManagerCeleryPidfileProcesses(snapshot);
    this.mergeDiscoveredProcesses(processes, celeryPidfileProcesses);
    if (processes.length > 0) {
      log(`[ProcessFinder] Port Manager snapshot contributed ${processes.length} runtime process candidate(s)`);
    }
    return processes;
  }

  private async findPortManagerCeleryPidfileProcesses(snapshot: PortManagerSnapshot): Promise<DjangoProcess[]> {
    const roots = collectPortManagerCeleryScanRoots(snapshot);
    if (roots.length === 0) {
      return [];
    }

    const celeryDirs = await this.findCeleryPidfileDirs(roots);
    const processes: DjangoProcess[] = [];
    const seenPids = new Set<number>();
    let scannedPidfiles = 0;

    for (const celeryDir of celeryDirs) {
      let entries: Array<{ name: string; isFile(): boolean; isSymbolicLink(): boolean }>;
      try {
        entries = await fs.readdir(celeryDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (
          scannedPidfiles >= CELERY_PIDFILE_SCAN_LIMIT ||
          !entry.name.endsWith('.pid') ||
          (!entry.isFile() && !entry.isSymbolicLink())
        ) {
          continue;
        }

        scannedPidfiles++;
        const pidFilePath = path.join(celeryDir, entry.name);
        const pid = await this.readPidFile(pidFilePath);
        if (!isPositivePid(pid) || seenPids.has(pid)) {
          continue;
        }

        const command = await this.findProcessCommand(pid);
        if (!isCeleryWorkerCommand(command)) {
          continue;
        }

        seenPids.add(pid);
        const cwd = await this.findProcessCwd(pid);
        const commandText = command!;
        const processCwd = cwd ?? this.rootFromCeleryDir(celeryDir);
        processes.push({
          pid,
          command: commandText,
          pythonPath: this.extractPythonPath(commandText),
          arch: process.arch,
          type: 'celery',
          cwd: processCwd,
          workerPids: await this.findCeleryChildPids(pid, commandText, processCwd),
        });
      }
    }

    if (processes.length > 0) {
      log(`[ProcessFinder] Celery pidfiles contributed ${processes.length} worker candidate(s)`);
    }
    return processes;
  }

  private async findCeleryPidfileDirs(roots: string[]): Promise<string[]> {
    const celeryDirs = new Set<string>();

    for (const root of roots) {
      const direct = path.join(root, '.celery');
      if (await this.isDirectory(direct)) {
        celeryDirs.add(direct);
      }

      const portManagerFilesDir = path.join(root, '.portmanager', 'files');
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = await fs.readdir(portManagerFilesDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const scopedCeleryDir = path.join(portManagerFilesDir, entry.name, '.celery');
        if (await this.isDirectory(scopedCeleryDir)) {
          celeryDirs.add(scopedCeleryDir);
        }
      }
    }

    return [...celeryDirs];
  }

  private async isDirectory(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async readPidFile(pidFilePath: string): Promise<number | undefined> {
    try {
      const content = await fs.readFile(pidFilePath, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      return isPositivePid(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private async findProcessCommand(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
      const command = stdout.trim();
      return command.length > 0 ? command : undefined;
    } catch {
      return undefined;
    }
  }

  private async findCeleryChildPids(
    masterPid: number,
    command: string,
    cwd: string | undefined,
  ): Promise<number[]> {
    const sharedPaths = await this.findCeleryMultiprocessingPaths(masterPid);
    const childPids = new Set<number>();

    for (const sharedPath of sharedPaths) {
      for (const pid of await this.findPythonPidsUsingPath(sharedPath, masterPid, cwd)) {
        childPids.add(pid);
      }
    }

    if (childPids.size === 0) {
      const logfile = this.extractCeleryLogfile(command);
      if (logfile) {
        for (const pid of await this.findPythonPidsUsingPath(logfile, masterPid, cwd)) {
          childPids.add(pid);
        }
      }
    }

    return uniqueSortedPids([...childPids]);
  }

  private async findCeleryMultiprocessingPaths(masterPid: number): Promise<string[]> {
    const paths = new Set<string>();
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', '-p', String(masterPid)]);
      for (const line of stdout.split('\n')) {
        const filePath = this.parseLsofName(line);
        if (filePath?.includes(`/pym-${masterPid}-`)) {
          paths.add(filePath);
        }
      }
    } catch {
      // lsof may fail for permission reasons; fall back to logfile sharing.
    }
    return [...paths];
  }

  private extractCeleryLogfile(command: string): string | undefined {
    const equalsMatch = command.match(/--logfile=(\S+)/);
    if (equalsMatch) {
      return equalsMatch[1];
    }
    const separatedMatch = command.match(/--logfile\s+(\S+)/);
    return separatedMatch?.[1];
  }

  private async findPythonPidsUsingPath(
    filePath: string,
    ownerPid: number,
    expectedCwd: string | undefined,
  ): Promise<number[]> {
    const pids = new Set<number>();
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', filePath]);
      for (const line of stdout.split('\n')) {
        const pid = parseLsofPid(line);
        if (!isPositivePid(pid) || pid === ownerPid) {
          continue;
        }

        const commandName = line.trim().split(/\s+/, 1)[0];
        if (!isPythonLikeText(commandName)) {
          continue;
        }

        if (expectedCwd) {
          const cwd = await this.findProcessCwd(pid);
          if (cwd && cwd !== expectedCwd) {
            continue;
          }
        }

        pids.add(pid);
      }
    } catch {
      // lsof may fail for permission reasons; worker pid discovery is best-effort.
    }
    return [...pids];
  }

  private parseLsofName(line: string): string | undefined {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9 || parts[0] === 'COMMAND') {
      return undefined;
    }
    const name = parts.slice(8).join(' ');
    return name.startsWith('/') ? name : undefined;
  }

  private rootFromCeleryDir(celeryDir: string): string | undefined {
    if (path.basename(celeryDir) !== '.celery') {
      return undefined;
    }
    const parent = path.dirname(celeryDir);
    if (path.basename(path.dirname(parent)) === 'files') {
      return path.dirname(path.dirname(path.dirname(parent)));
    }
    return parent;
  }

  private async queryPortManagerSnapshot(): Promise<PortManagerSnapshot | undefined> {
    const socketPath = this.getPortManagerAgentSocketPath();
    const requestId = `django-process-debugger-${process.pid}-${Date.now()}`;

    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let settled = false;

      const settle = (snapshot?: PortManagerSnapshot) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(snapshot);
      };

      const timer = setTimeout(() => {
        log(`[ProcessFinder] Port Manager agent snapshot timed out at ${socketPath}`);
        settle();
      }, PORT_MANAGER_AGENT_REQUEST_TIMEOUT_MS);

      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id: requestId, method: 'listSnapshot' })}\n`);
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          let message: PortManagerResponseMessage;
          try {
            message = JSON.parse(line) as PortManagerResponseMessage;
          } catch {
            continue;
          }
          if (message.id !== requestId) {
            continue;
          }
          if (message.ok === true && this.isPortManagerSnapshot(message.payload)) {
            settle(message.payload);
          } else {
            log(`[ProcessFinder] Port Manager agent snapshot failed: ${message.error ?? 'unknown response'}`);
            settle();
          }
        }
      });

      socket.once('error', (err) => {
        log(`[ProcessFinder] Port Manager agent unavailable at ${socketPath}: ${err.message}`);
        settle();
      });
    });
  }

  private getPortManagerAgentSocketPath(): string {
    if (process.env.PORT_MANAGER_AGENT_SOCKET) {
      return process.env.PORT_MANAGER_AGENT_SOCKET;
    }
    if (process.platform === 'win32') {
      return '\\\\.\\pipe\\newdlops-portmanager-agent';
    }
    const userId = typeof process.getuid === 'function'
      ? process.getuid()
      : os.userInfo().username;
    return path.join(os.tmpdir(), `newdlops-portmanager-agent-${userId}.sock`);
  }

  private isPortManagerSnapshot(value: unknown): value is PortManagerSnapshot {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const snapshot = value as PortManagerSnapshot;
    return (
      (snapshot.processes === undefined || Array.isArray(snapshot.processes)) &&
      (snapshot.routes === undefined || Array.isArray(snapshot.routes)) &&
      (snapshot.listeners === undefined || Array.isArray(snapshot.listeners))
    );
  }

  private isDjangoProcess(line: string): boolean {
    return this.classifyProcess(line) !== null;
  }

  classifyProcess(line: string): ProcessType | null {
    if (isCeleryWorkerCommand(line)) {
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

  private async findProcessCwd(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('lsof', [
        '-a', '-p', String(pid), '-d', 'cwd', '-Fn',
      ]);
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n') && line.length > 1) {
          return line.slice(1);
        }
      }
    } catch {
      // cwd lookup is best-effort; process discovery should still succeed.
    }
    return undefined;
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
        if (!endpoint || !ports.has(endpoint.port) || !isIpv4LoopbackEndpoint(endpoint)) {
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
