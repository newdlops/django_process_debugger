/**
 * Pure filter used by the hot-reload `FileSystemWatcher` to drop events we
 * never want to reload. Kept as a standalone module so the rule is unit-testable
 * without needing to activate the full extension.
 *
 * The rule intentionally uses substring matches (not globs) because
 * `FileSystemWatcher` delivers OS-normalized absolute paths and we want
 * identical behavior on macOS/Linux/Windows.
 */
const EXCLUDE_SUBSTRINGS: readonly string[] = [
  'site-packages',
  '__pycache__',
  '.venv',
  '/venv/',
  'node_modules',
  '/migrations/',
  '/.django-shell/',
];

export function shouldIgnoreForHotReload(filePath: string): boolean {
  // Watcher paths use platform separators. Normalize once so directory-boundary
  // exclusions behave identically for POSIX and Windows-style paths.
  const normalizedPath = filePath.replace(/\\/g, '/');
  for (const needle of EXCLUDE_SUBSTRINGS) {
    if (normalizedPath.includes(needle)) {
      return true;
    }
  }
  return false;
}

export const HOT_RELOAD_EXCLUDE_SUBSTRINGS = EXCLUDE_SUBSTRINGS;
