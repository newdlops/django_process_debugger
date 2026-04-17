import { performance } from 'perf_hooks';

export interface PerfEntry {
  name: string;
  group: string;
  durationMs: number;
  ok: boolean;
  meta?: Record<string, unknown>;
}

export class PerfReporter {
  private entries: PerfEntry[] = [];

  async measure<T>(
    name: string,
    fn: () => Promise<T>,
    opts: { group?: string; meta?: Record<string, unknown> } = {},
  ): Promise<T> {
    const start = performance.now();
    let ok = true;
    try {
      return await fn();
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      const durationMs = performance.now() - start;
      this.entries.push({
        name,
        group: opts.group ?? 'default',
        durationMs,
        ok,
        meta: opts.meta,
      });
    }
  }

  snapshot(): PerfEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  toMarkdown(): string {
    if (this.entries.length === 0) {
      return '# Performance Report\n\nNo measurements recorded.\n';
    }

    const byGroup = new Map<string, PerfEntry[]>();
    for (const e of this.entries) {
      const bucket = byGroup.get(e.group) ?? [];
      bucket.push(e);
      byGroup.set(e.group, bucket);
    }

    const lines: string[] = [];
    lines.push('# Performance Report');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Platform: ${process.platform} / ${process.arch} / node ${process.version}`);
    lines.push('');

    for (const [group, list] of byGroup) {
      lines.push(`## ${group}`);
      lines.push('');
      lines.push('| # | Measurement | Duration (ms) | Status | Notes |');
      lines.push('|---|---|---:|---|---|');
      const sorted = [...list].sort((a, b) => b.durationMs - a.durationMs);
      sorted.forEach((e, idx) => {
        const meta = e.meta ? JSON.stringify(e.meta) : '';
        lines.push(`| ${idx + 1} | ${e.name} | ${e.durationMs.toFixed(2)} | ${e.ok ? 'ok' : 'fail'} | ${meta} |`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  toConsoleSummary(): string {
    const lines: string[] = [];
    lines.push('\n[perf] Top measurements:');
    const top = [...this.entries]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10);
    for (const e of top) {
      lines.push(`  ${e.durationMs.toFixed(1).padStart(8)} ms  [${e.group}] ${e.name}`);
    }
    return lines.join('\n');
  }
}

let singleton: PerfReporter | undefined;

export function getPerf(): PerfReporter {
  if (!singleton) {
    singleton = new PerfReporter();
  }
  return singleton;
}
