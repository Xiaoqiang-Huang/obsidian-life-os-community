/** Run a raw archive transaction without invoking a text parser or creating Markdown. */
export async function archiveOriginalFiles<T>(
  files: T[],
  save: (file: T) => Promise<string>,
  report?: (index: number, count: number, file: T, stage: "saving" | "completed") => void
): Promise<string[]> {
  const paths: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    report?.(index + 1, files.length, file, "saving");
    paths.push(await save(file));
    report?.(index + 1, files.length, file, "completed");
  }
  return paths;
}
