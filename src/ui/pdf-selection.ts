/** Read only the text layer of one owning PDF view; never guess from the active file. */
export function capturePdfTextSelection<T>(views: Array<{ file: T | null; containerEl: HTMLElement }>, selection: Selection | null): { file: T; text: string; element: HTMLElement } | null {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || selection.rangeCount === 0) return null;
  const element = (node: Node) => node.nodeType === 1 ? node as HTMLElement : node.parentElement;
  const anchor = element(selection.anchorNode), focus = element(selection.focusNode);
  if (!anchor?.closest(".textLayer, .text-layer") || !focus?.closest(".textLayer, .text-layer")) return null;
  const text = selection.toString(); if (text.trim().length < 2) return null;
  const view = views.find(v => v.file && v.containerEl.contains(anchor) && v.containerEl.contains(focus));
  return view?.file ? { file: view.file, text, element: anchor } : null;
}
