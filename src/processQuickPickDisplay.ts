export function sanitizeQuickPickText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

export function selectDisplayCwd(
  preferred: string | undefined,
  alternatives: Array<string | undefined> = [],
): string | undefined {
  for (const candidate of [preferred, ...alternatives]) {
    if (candidate && sanitizeQuickPickText(candidate).length > 0) {
      return candidate;
    }
  }
  return undefined;
}

export function selectGroupedDisplayCwd(
  resolvedPid: number,
  preferred: string | undefined,
  candidates: Array<{ resolvedPid: number; cwd?: string }>,
): string | undefined {
  return selectDisplayCwd(
    preferred,
    candidates
      .filter((candidate) => candidate.resolvedPid === resolvedPid)
      .map((candidate) => candidate.cwd),
  );
}

export function cwdFolderName(cwd: string | undefined): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const sanitized = sanitizeQuickPickText(cwd);
  if (!sanitized) {
    return undefined;
  }
  const withoutTrailingSeparators = sanitized.replace(/[\\/]+$/, '');
  if (!withoutTrailingSeparators) {
    return sanitized;
  }
  const parts = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? withoutTrailingSeparators;
}

export function processQuickPickDescription(
  cwd: string | undefined,
  description: string,
): string {
  const folder = cwdFolderName(cwd);
  const sanitizedDescription = sanitizeQuickPickText(description);
  if (!folder) {
    return sanitizedDescription;
  }
  return sanitizedDescription
    ? `$(folder) ${folder}  •  ${sanitizedDescription}`
    : `$(folder) ${folder}`;
}

export function processQuickPickDetail(
  cwd: string | undefined,
  parts: Array<string | undefined>,
): string {
  const sanitizedCwd = cwd ? sanitizeQuickPickText(cwd) : '';
  return [
    sanitizedCwd ? `CWD: ${sanitizedCwd}` : undefined,
    ...parts.map((part) => part ? sanitizeQuickPickText(part) : undefined),
  ].filter((part): part is string => !!part).join('  |  ');
}
