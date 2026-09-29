/** Capture only text inside one DOCX preview's rendered document, not its toolbar or another tab. */
export function captureWordTextSelection<T>(
  views: Array<{ file: T | null; containerEl: HTMLElement }>,
  selection: Selection | null
): { file: T; text: string; element: HTMLElement } | null {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || selection.rangeCount === 0) return null;
  const element = (node: Node): HTMLElement | null => node.nodeType === 1 ? node as HTMLElement : node.parentElement;
  const anchor = element(selection.anchorNode), focus = element(selection.focusNode);
  const anchorBody = anchor?.closest<HTMLElement>(".lifeos-word-preview-document-body");
  const focusBody = focus?.closest<HTMLElement>(".lifeos-word-preview-document-body");
  if (!anchorBody || anchorBody !== focusBody) return null;
  const text = selection.toString();
  if (text.trim().length < 2) return null;
  const owner = views.find(view => view.file && view.containerEl.contains(anchorBody) && view.containerEl.contains(anchor!) && view.containerEl.contains(focus!));
  return owner?.file && anchor ? { file: owner.file, text, element: anchor } : null;
}
