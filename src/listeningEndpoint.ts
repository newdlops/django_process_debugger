export interface TcpListeningEndpoint {
  host: string;
  port: number;
}

export function normalizeListeningHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === '*' || trimmed === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (trimmed === '::' || trimmed === '[::]') {
    return '::1';
  }
  return trimmed;
}

/**
 * Parse a single `lsof -nP -iTCP -sTCP:LISTEN` output line.
 *
 * macOS port routing can bind local services to loopback aliases such as
 * 127.83.116.219 instead of 127.0.0.1, so callers must preserve the host.
 */
export function parseLsofTcpListenLine(line: string): TcpListeningEndpoint | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('COMMAND ')) {
    return null;
  }

  const withoutState = trimmed.replace(/\s+\(LISTEN\)\s*$/, '');
  const bracketMatch = withoutState.match(/\sTCP\s+\[([^\]]+)\]:(\d+)$/);
  const plainMatch = bracketMatch ? null : withoutState.match(/\sTCP\s+(\S+):(\d+)$/);
  const match = bracketMatch ?? plainMatch;
  if (!match) {
    return null;
  }

  const port = parseInt(match[2], 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  return {
    host: normalizeListeningHost(match[1]),
    port,
  };
}

export function formatEndpoint(endpoint: TcpListeningEndpoint): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${endpoint.port}`;
}
