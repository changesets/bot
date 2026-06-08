// Files in `.changeset` that should not be considered as changesets.
// Should match `@changesets/read`.
const ignoredMdFiles = [/^README\.md$/i, "AGENTS.md", "CLAUDE.md", "GEMINI.md"];

export function isChangeset(filename: string) {
  if (!filename.startsWith(".changeset/")) return false;

  const file = filename.slice(".changeset/".length);

  // Perform same check as `@changesets/read`
  return (
    !file.startsWith(".") &&
    file.endsWith(".md") &&
    !ignoredMdFiles.some((pattern) =>
      typeof pattern === "string" ? pattern === file : pattern.test(file),
    )
  );
}
