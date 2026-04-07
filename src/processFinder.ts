import { execFile } from 'child_process';
import { promisify } from 'util';
import { log, logError } from './logger';

const execFileAsync = promisify(execFile);

export type ProcessType = 'django' | 'celery';

export interface DjangoProcess {
  pid: number;
  command: string;
  pythonPath: string;
  arch: string;
  type: ProcessType;
  port?: number;
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

      // Resolve listening ports for each process
      await Promise.all(processes.map(async (p) => {
        p.port = this.extractPortFromCommand(p.command) ?? await this.findListeningPort(p.pid);
      }));

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
    // manage.py runserver [addr:]port
    const runserverMatch = command.match(/runserver\s+(?:\S+:)?(\d+)/);
    if (runserverMatch) {
      return parseInt(runserverMatch[1], 10);
    }

    // uvicorn --port PORT or --host X --port PORT
    const uvicornPortMatch = command.match(/--port\s+(\d+)/);
    if (uvicornPortMatch) {
      return parseInt(uvicornPortMatch[1], 10);
    }

    // gunicorn -b / --bind [addr:]port
    const gunicornMatch = command.match(/(?:-b|--bind)\s+(?:\S+:)?(\d+)/);
    if (gunicornMatch) {
      return parseInt(gunicornMatch[1], 10);
    }

    // daphne -p PORT or --port PORT
    const daphneMatch = command.match(/(?:-p|--port)\s+(\d+)/);
    if (daphneMatch) {
      return parseInt(daphneMatch[1], 10);
    }

    return undefined;
  }

  /**
   * Find the TCP listening port for a given PID using lsof.
   */
  private async findListeningPort(pid: number): Promise<number | undefined> {
    try {
      const { stdout } = await execFileAsync('lsof', [
        '-iTCP', '-sTCP:LISTEN', '-nP', '-p', String(pid),
      ]);
      // Parse lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      // NAME looks like *:8000 or 127.0.0.1:8000
      for (const line of stdout.split('\n')) {
        const match = line.match(/:(\d+)\s*$/);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    } catch {
      // lsof may fail for permission reasons — that's fine
    }
    return undefined;
  }
}
