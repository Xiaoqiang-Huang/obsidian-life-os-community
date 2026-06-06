export interface HeatmapDay {
  date: string;
  active: boolean;
  level?: 0 | 1 | 2 | 3 | 4;
  label?: string;
}

export function createHeatmap(parent: HTMLElement, dates: HeatmapDay[]): HTMLElement {
  const heatmap = parent.createDiv({ cls: "lifeos-heatmap" });
  for (const item of dates) {
    const level = item.level ?? (item.active ? 2 : 0);
    const cell = heatmap.createDiv({ cls: `lifeos-heatmap-cell level-${level}` });
    cell.setAttr("title", item.label ?? `${item.date}：${item.active ? "有记录" : "未记录"}`);
    cell.setAttr("aria-label", item.label ?? `${item.date}：${item.active ? "有记录" : "未记录"}`);
  }
  return heatmap;
}
