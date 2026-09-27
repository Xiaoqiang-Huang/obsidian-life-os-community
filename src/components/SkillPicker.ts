import type { AiSkill } from "../services/AiSkillService";

export interface SkillPickerGroup { id: string; label: string; description: string; skills: AiSkill[] }
export function renderSkillPicker(parent: HTMLElement, options: {
  groups: SkillPickerGroup[]; selected: string[];
  save: (ids: string[]) => Promise<string[]>;
  inspect: (skill: AiSkill) => void;
}): void {
  const root = parent.createDiv({ cls: "lifeos-skill-picker" });
  const search = root.createEl("input", { attr: { type: "search", placeholder: "搜索 Skill 名称或用途", "aria-label": "搜索 Skill" } });
  const status = root.createDiv({ cls: "lifeos-setting-description", attr: { role: "status" } });
  let selected = new Set(options.selected), busy = false;
  const cards: Array<{ element: HTMLElement; input: HTMLInputElement; skill: AiSkill }> = [];
  const groups: Array<{ element: HTMLDetailsElement; cards: typeof cards }> = [];
  for (const category of options.groups.filter(g => g.skills.length)) {
    const group = root.createEl("details", { cls: "lifeos-settings-skill-category" });
    group.open = category.id === "system" || category.skills.some(s => selected.has(s.id));
    group.createEl("summary", { text: `${category.label} · ${category.skills.length}` });
    group.createDiv({ cls: "lifeos-setting-description", text: category.description });
    const list = group.createDiv({ cls: "lifeos-settings-skill-list" }), entries: typeof cards = [];
    for (const skill of category.skills) {
      const card = list.createDiv({ cls: "lifeos-settings-skill-option" });
      const label = card.createEl("label", { cls: "lifeos-settings-skill-copy" });
      const input = label.createEl("input", { attr: { type: "checkbox", "aria-label": `选择 ${skill.name}` } });
      label.createEl("strong", { text: skill.name });
      label.createSpan({ cls: "lifeos-settings-skill-desc", text: skill.description });
      const view = card.createEl("button", { text: "查看", attr: { type: "button", "aria-label": `查看 ${skill.name}` } });
      view.onclick = () => options.inspect(skill);
      const entry = { element: card, input, skill }; cards.push(entry); entries.push(entry);
      input.onchange = async () => {
        if (busy) { sync(); return; }
        const next = new Set(selected); input.checked ? next.add(skill.id) : next.delete(skill.id);
        busy = true; sync(); status.setText("正在保存 Skill 选择…");
        try { selected = new Set(await options.save([...next])); status.setText(`已保存，选择 ${selected.size} 个 Skill`); }
        catch (error) { status.setText(`未保存，已恢复原选择：${String(error)}`); }
        finally { busy = false; sync(); }
      };
    }
    groups.push({ element: group, cards: entries });
  }
  function sync(): void { for (const c of cards) { c.input.checked = selected.has(c.skill.id); c.input.disabled = busy; c.element.toggleClass("is-active", c.input.checked); } }
  search.oninput = () => {
    const term = search.value.trim().toLocaleLowerCase(); let visible = 0;
    for (const g of groups) {
      for (const c of g.cards) { c.element.hidden = !`${c.skill.name} ${c.skill.description}`.toLocaleLowerCase().includes(term); if (!c.element.hidden) visible++; }
      g.element.hidden = g.cards.every(c => c.element.hidden); if (term && !g.element.hidden) g.element.open = true;
    }
    status.setText(term ? `找到 ${visible} 个 Skill；已选 ${selected.size} 个` : `已选 ${selected.size} 个 Skill`);
  };
  sync(); status.setText(`已选 ${selected.size} 个 Skill`);
}
