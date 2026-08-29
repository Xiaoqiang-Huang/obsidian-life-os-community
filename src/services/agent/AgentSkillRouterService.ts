import {
  createImportedAiSkills,
  getAvailableAiSkills,
  type AiSkill
} from "../AiSkillService";
import type { PersonalLifeSystemSettings } from "../../settings";
import type { LifeOSAgentSkillRoute } from "./LifeOSAgentTypes";

interface IndexedSkill {
  skill: AiSkill;
  aliases: string[];
  tokens: string[];
}

const GENERIC_SKILL_IDS = new Set(["lifeos-general"]);
const STOP_TOKENS = new Set(["方法", "思路", "分析", "资料", "技能", "skill", "视角", "回答", "问题", "使用"]);

/** Metadata-first Skill router. Full Skill bodies are loaded only after routing. */
export class AgentSkillRouterService {
  constructor(private getSettings: () => PersonalLifeSystemSettings) {}

  route(query: string, explicitIds: string[] = [], defaultSkillId = "lifeos-general"): LifeOSAgentSkillRoute {
    const index = this.index();
    const known = new Set(index.map((item) => item.skill.id));
    const explicit = Array.from(new Set(explicitIds.filter((id) => known.has(id))));
    const normalizedQuery = this.normalize(query);
    const named = index.filter((item) => item.aliases.some((alias) => alias.length >= 2 && normalizedQuery.includes(alias)));
    if (named.length > 0) {
      const ranked = named.sort((a, b) => this.namedScore(b, normalizedQuery) - this.namedScore(a, normalizedQuery));
      const best = this.namedScore(ranked[0], normalizedQuery);
      const selected = ranked.filter((item) => this.namedScore(item, normalizedQuery) >= best - 2).slice(0, 3).map((item) => item.skill.id);
      return {
        selectedIds: selected,
        matchedIds: selected,
        confidence: best >= 20 ? 0.99 : 0.9,
        reason: "named",
        indexSummary: this.summary(index, selected)
      };
    }

    const explicitSpecific = explicit.filter((id) => !GENERIC_SKILL_IDS.has(id));
    if (explicitSpecific.length > 0) {
      return {
        selectedIds: explicit,
        matchedIds: explicitSpecific,
        confidence: 1,
        reason: "explicit",
        indexSummary: this.summary(index, explicit)
      };
    }

    const queryTokens = this.tokens(query);
    const scored = index
      .filter((item) => !GENERIC_SKILL_IDS.has(item.skill.id))
      .map((item) => ({ item, score: item.tokens.reduce((sum, token) => sum + (queryTokens.has(token) ? Math.min(6, token.length) : 0), 0) }))
      .filter((entry) => entry.score >= 8)
      .sort((a, b) => b.score - a.score || a.item.skill.name.localeCompare(b.item.skill.name));
    if (scored.length > 0 && (!scored[1] || scored[0].score - scored[1].score >= 2)) {
      const selected = [scored[0].item.skill.id];
      return {
        selectedIds: selected,
        matchedIds: selected,
        confidence: Math.min(0.88, 0.58 + scored[0].score / 40),
        reason: "semantic",
        indexSummary: this.summary(index, selected)
      };
    }

    const fallback = known.has(defaultSkillId) ? defaultSkillId : "lifeos-general";
    return {
      selectedIds: [fallback],
      matchedIds: [],
      confidence: 1,
      reason: "default",
      indexSummary: this.summary(index, [fallback])
    };
  }

  catalogSummary(maxChars = 6_000): string {
    return this.summary(this.index(), []).slice(0, maxChars);
  }

  available(): AiSkill[] {
    return this.index().map((item) => item.skill);
  }

  private index(): IndexedSkill[] {
    const settings = this.getSettings();
    return getAvailableAiSkills(
      createImportedAiSkills(settings.importedAiSkills),
      settings.aiSkillOverrides
    ).map((skill) => ({
      skill,
      aliases: this.aliases(skill),
      tokens: Array.from(this.tokens([skill.name, skill.id, skill.description, skill.lens, skill.category].join(" ")))
    }));
  }

  private aliases(skill: AiSkill): string[] {
    const values = new Set<string>();
    const add = (value: string) => {
      const normalized = this.normalize(value);
      if (normalized.length >= 2) values.add(normalized);
    };
    add(skill.name);
    add(skill.id);
    add(skill.id.replace(/(?:-skill|-perspective)$/iu, ""));
    add(skill.name.replace(/(?:资料分析|方法论|方法|老师|名师|skill)$/giu, ""));
    for (const part of skill.name.split(/[·•()（）/\s_-]+/u)) add(part);
    const normalized = this.normalize(skill.name);
    if (/小p/iu.test(normalized)) ["小p", "小P"].forEach(add);
    if (/正道/iu.test(normalized)) ["正道哥", "正道"].forEach(add);
    if (/花生十三/iu.test(normalized)) ["花生十三", "花生"].forEach(add);
    return Array.from(values).sort((a, b) => b.length - a.length);
  }

  private namedScore(item: IndexedSkill, query: string): number {
    return item.aliases.reduce((best, alias) => query.includes(alias) ? Math.max(best, 10 + alias.length * 2) : best, 0);
  }

  private summary(index: IndexedSkill[], selectedIds: string[]): string {
    const selected = new Set(selectedIds);
    return index.map(({ skill }) => [
      selected.has(skill.id) ? "*" : "-",
      `${skill.name} (${skill.id})`,
      skill.description ? `：${skill.description.slice(0, 90)}` : ""
    ].join(" ")).join("\n");
  }

  private tokens(value: string): Set<string> {
    const normalized = this.normalize(value);
    const tokens = new Set<string>();
    for (const token of normalized.split(/[^a-z0-9\u3400-\u9fff]+/giu)) {
      if (token.length >= 2 && !STOP_TOKENS.has(token)) tokens.add(token);
      if (/^[\u3400-\u9fff]{4,}$/u.test(token)) {
        for (let size = Math.min(6, token.length); size >= 2; size -= 1) {
          for (let i = 0; i + size <= token.length && tokens.size < 160; i += 1) {
            const part = token.slice(i, i + size);
            if (!STOP_TOKENS.has(part)) tokens.add(part);
          }
        }
      }
    }
    return tokens;
  }

  private normalize(value: string): string {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s._·•()（）【】\[\]{}《》<>：:，,。.!！?？/\\_-]+/gu, "");
  }
}
