// Path helpers for the renderer.
//
// `Task.folderPath` is built in main with the OS separator (`\` on Windows,
// `/` on macOS/Linux). The renderer sometimes needs a child path (a task's
// notes.md); building it with a hardcoded `\\` produced a literal filename
// containing a backslash on macOS — the wrong file.
//
// We infer the separator from the parent path so the result is byte-identical
// to main's `path.join` on each platform: a Windows folderPath keeps its
// backslash, a POSIX one keeps its forward slash. That matters because these
// strings are used as keys (e.g. a to-do's `source_file`), so a Windows path
// that suddenly changed spelling would look like a different file.

/** `folderPath` + a child file/segment, using the parent's own separator. */
export function childPath(folderPath: string, child: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${sep}${child}`
}

/** The last segment of a path, regardless of which separator built it. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}
