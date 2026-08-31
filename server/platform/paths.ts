import path from 'path';

/**
 * Filesystem containment.
 *
 * The folder scanner (`exams/file-source.ts`) reads whatever the operator
 * points it at, then walks it recursively. This keeps that walk — and any
 * path derived from an entry it finds — inside the configured root, so a
 * symlink or a `..` segment can't reach the rest of the disk.
 */

export class PathEscapeError extends Error {
  constructor(candidate: string, root: string) {
    super(`Path "${candidate}" resolves outside "${root}".`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolves `candidate` (absolute, or relative to `root`) and asserts the
 * result is `root` itself or sits beneath it. Returns the resolved
 * absolute path.
 */
export function resolveWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);

  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new PathEscapeError(candidate, resolvedRoot);
  }

  return resolved;
}
