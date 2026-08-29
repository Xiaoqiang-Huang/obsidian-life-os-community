import type { App } from "obsidian";
import type {
  LifeOSAgentToolDescriptor,
  LifeOSAgentToolInputProperty
} from "../LifeOSAgentToolRegistry";
import { FileSystemService } from "../FileSystemService";
import { ensureFolder, readFile, writeFile } from "../../utils/vault";
import type { LifeOSAgentToolExecutionContext, LifeOSAgentToolResult } from "./LifeOSAgentTypes";

export interface LifeOSAgentToolRecipeStep {
  toolId: string;
  input: Record<string, unknown>;
}

export interface LifeOSAgentToolRecipe {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, LifeOSAgentToolInputProperty>;
  steps: LifeOSAgentToolRecipeStep[];
  channels: Array<"desktop" | "weixin">;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolRecipeDraft {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  steps: unknown[];
}

type PrimitiveRunner = (
  toolId: string,
  input: Record<string, unknown>,
  context: LifeOSAgentToolExecutionContext,
  stepIndex: number
) => Promise<LifeOSAgentToolResult>;

const MAX_RECIPES = 50;
const MAX_STEPS = 8;
const RECIPE_FILE_NAME = "recipes.json";
const BLOCKED_STEP_IDS = new Set(["tool-compose", "tool-delete"]);
const ALLOWED_PROPERTY_TYPES = new Set(["string", "number", "boolean", "array", "object"]);
const EXACT_TEMPLATE = /^\{\{(input\.[A-Za-z][A-Za-z0-9_-]*|context\.(?:userContent|projectScopeId)|steps\.\d+\.output)\}\}$/u;
const TEMPLATE_TOKEN = /\{\{([^{}]+)\}\}/gu;

/**
 * Persists safe, declarative Agent tools. A recipe can only orchestrate tools
 * already registered by Life OS; it never evaluates JavaScript or shell text.
 */
export class AgentToolRecipeService {
  constructor(
    private readonly app: App,
    private readonly fs: FileSystemService,
    private readonly resolveDescriptor: (id: string) => LifeOSAgentToolDescriptor | undefined
  ) {}

  get filePath(): string {
    return this.fs.path("AI", "Tools", RECIPE_FILE_NAME);
  }

  async load(): Promise<LifeOSAgentToolRecipe[]> {
    if (typeof this.app.vault?.getAbstractFileByPath !== "function") return [];
    const raw = await readFile(this.app, this.filePath);
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as { recipes?: unknown } | unknown[];
      const candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed.recipes) ? parsed.recipes : [];
      const recipes: LifeOSAgentToolRecipe[] = [];
      for (const value of candidates.slice(0, MAX_RECIPES)) {
        if (!this.isStoredRecipe(value)) continue;
        try {
          // recipes.json is user-editable Vault data. Re-run the same validation
          // used at creation time so a tampered file cannot introduce recursion,
          // executable placeholders, unknown tools, or malformed schemas on reload.
          const normalized = this.validateDraft({
            name: value.name,
            description: value.description,
            inputSchema: value.inputSchema,
            steps: value.steps
          });
          recipes.push({
            id: value.id,
            ...normalized,
            channels: this.normalizeChannels(value.channels),
            createdAt: this.normalizeTimestamp(value.createdAt),
            updatedAt: this.normalizeTimestamp(value.updatedAt)
          });
        } catch {
          // Fail closed: invalid persisted recipes remain inert and are not
          // registered in the Agent runtime.
        }
      }
      return recipes;
    } catch {
      return [];
    }
  }

  async create(draft: AgentToolRecipeDraft): Promise<LifeOSAgentToolRecipe> {
    const recipes = await this.load();
    if (recipes.length >= MAX_RECIPES) throw new Error(`自定义工具最多保存 ${MAX_RECIPES} 个，请先删除不用的工具。`);
    const normalized = this.validateDraft(draft);
    const now = new Date().toISOString();
    const baseId = `custom-${this.slug(normalized.name) || this.hash(normalized.name)}`.slice(0, 71).replace(/-+$/u, "");
    let id = baseId;
    let suffix = 2;
    while (recipes.some((recipe) => recipe.id === id)) {
      id = `${baseId.slice(0, 66)}-${suffix}`;
      suffix += 1;
    }
    const recipe: LifeOSAgentToolRecipe = {
      id,
      name: normalized.name,
      description: normalized.description,
      inputSchema: normalized.inputSchema,
      steps: normalized.steps,
      channels: ["desktop", "weixin"],
      createdAt: now,
      updatedAt: now
    };
    await this.saveAll([...recipes, recipe]);
    return recipe;
  }

  async delete(id: string): Promise<boolean> {
    if (!id.startsWith("custom-")) throw new Error("只能删除 custom- 开头的自定义工具。");
    const recipes = await this.load();
    const next = recipes.filter((recipe) => recipe.id !== id);
    if (next.length === recipes.length) return false;
    await this.saveAll(next);
    return true;
  }

  descriptor(recipe: LifeOSAgentToolRecipe): LifeOSAgentToolDescriptor {
    const primitiveDescriptors = recipe.steps
      .map((step) => this.resolveDescriptor(step.toolId))
      .filter((descriptor): descriptor is LifeOSAgentToolDescriptor => Boolean(descriptor));
    const hasWrite = primitiveDescriptors.some((descriptor) => descriptor.mode === "write");
    const hasNetwork = primitiveDescriptors.some((descriptor) => descriptor.risk === "network");
    const requiresConfirmation = primitiveDescriptors.some((descriptor) => descriptor.confirmation === "always");
    return {
      id: recipe.id,
      mode: hasWrite ? "write" : "read",
      family: "tooling",
      description: `${recipe.description}（由 ${recipe.steps.length} 个受控步骤组成）`,
      channels: [...recipe.channels],
      input: { ...recipe.inputSchema },
      risk: hasWrite ? "local-write" : hasNetwork ? "network" : primitiveDescriptors.some((item) => item.risk === "local-read") ? "local-read" : "none",
      confirmation: requiresConfirmation ? "always" : "default"
    };
  }

  async execute(
    recipe: LifeOSAgentToolRecipe,
    args: Record<string, unknown>,
    context: LifeOSAgentToolExecutionContext,
    runPrimitive: PrimitiveRunner
  ): Promise<string> {
    const outputs: LifeOSAgentToolResult[] = [];
    for (let index = 0; index < recipe.steps.length; index += 1) {
      const step = recipe.steps[index];
      const input = this.resolveValue(step.input, args, context, outputs) as Record<string, unknown>;
      const result = await runPrimitive(step.toolId, input, context, index);
      outputs.push(result);
      if (!result.ok) throw new Error(`自定义工具第 ${index + 1} 步失败（${step.toolId}）：${result.error || "未知错误"}`);
    }
    const summary = outputs.map((result, index) => `${index + 1}. ${result.toolId}：${result.output}`).join("\n");
    return `自定义工具“${recipe.name}”已完成 ${outputs.length} 个步骤。${summary ? `\n${summary}` : ""}`;
  }

  private validateDraft(draft: AgentToolRecipeDraft): Pick<LifeOSAgentToolRecipe, "name" | "description" | "inputSchema" | "steps"> {
    const name = String(draft.name || "").trim().slice(0, 80);
    const description = String(draft.description || "").trim().slice(0, 500);
    if (!name) throw new Error("自定义工具缺少名称。");
    if (!description) throw new Error("自定义工具缺少用途说明。");
    if (!Array.isArray(draft.steps) || draft.steps.length === 0) throw new Error("自定义工具至少需要一个组合步骤。");
    if (draft.steps.length > MAX_STEPS) throw new Error(`单个自定义工具最多包含 ${MAX_STEPS} 个步骤。`);

    const inputSchema = this.normalizeInputSchema(draft.inputSchema || {});
    const steps = draft.steps.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`第 ${index + 1} 步格式无效。`);
      const record = raw as Record<string, unknown>;
      const toolId = String(record.toolId || "").trim();
      if (!toolId) throw new Error(`第 ${index + 1} 步缺少 toolId。`);
      if (BLOCKED_STEP_IDS.has(toolId) || toolId.startsWith("custom-")) {
        throw new Error("禁止递归组合工具或在工具配方中再次创建、删除工具。");
      }
      const descriptor = this.resolveDescriptor(toolId);
      if (!descriptor) throw new Error(`第 ${index + 1} 步引用了未知工具：${toolId}`);
      const input = record.input && typeof record.input === "object" && !Array.isArray(record.input)
        ? JSON.parse(JSON.stringify(record.input)) as Record<string, unknown>
        : {};
      this.validateTemplates(input, inputSchema);
      return { toolId, input };
    });
    return { name, description, inputSchema, steps };
  }

  private normalizeInputSchema(raw: Record<string, unknown>): Record<string, LifeOSAgentToolInputProperty> {
    const schema: Record<string, LifeOSAgentToolInputProperty> = {};
    for (const [key, value] of Object.entries(raw).slice(0, 20)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) throw new Error(`工具输入字段名无效：${key}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`工具输入字段 ${key} 定义无效。`);
      const record = value as Record<string, unknown>;
      const type = String(record.type || "string");
      if (!ALLOWED_PROPERTY_TYPES.has(type)) throw new Error(`工具输入字段 ${key} 类型无效。`);
      schema[key] = {
        type: type as LifeOSAgentToolInputProperty["type"],
        description: String(record.description || key).slice(0, 300),
        required: record.required === true
      };
    }
    return schema;
  }

  private validateTemplates(value: unknown, inputSchema: Record<string, LifeOSAgentToolInputProperty>): void {
    if (typeof value === "string") {
      if (!value.includes("{{")) return;
      const tokens = Array.from(value.matchAll(TEMPLATE_TOKEN));
      if (tokens.length === 0 || value.replace(TEMPLATE_TOKEN, "").includes("{{") || value.replace(TEMPLATE_TOKEN, "").includes("}}")) {
        throw new Error("工具模板包含无法识别的占位符或代码表达式。");
      }
      for (const token of tokens) {
        const expression = token[1].trim();
        if (!/^(?:input\.[A-Za-z][A-Za-z0-9_-]*|context\.(?:userContent|projectScopeId)|steps\.\d+\.output)$/u.test(expression)) {
          throw new Error(`工具模板占位符不受支持：{{${expression}}}`);
        }
        if (expression.startsWith("input.") && !inputSchema[expression.slice(6)]) {
          throw new Error(`工具模板引用了未声明的输入字段：${expression}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => this.validateTemplates(item, inputSchema));
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach((item) => this.validateTemplates(item, inputSchema));
    }
  }

  private resolveValue(
    value: unknown,
    args: Record<string, unknown>,
    context: LifeOSAgentToolExecutionContext,
    outputs: LifeOSAgentToolResult[]
  ): unknown {
    if (typeof value === "string") {
      const exact = value.match(EXACT_TEMPLATE);
      if (exact) return this.resolveExpression(exact[1], args, context, outputs);
      return value.replace(TEMPLATE_TOKEN, (_match, expression: string) => String(this.resolveExpression(expression.trim(), args, context, outputs) ?? ""));
    }
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item, args, context, outputs));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, this.resolveValue(item, args, context, outputs)]));
    }
    return value;
  }

  private resolveExpression(
    expression: string,
    args: Record<string, unknown>,
    context: LifeOSAgentToolExecutionContext,
    outputs: LifeOSAgentToolResult[]
  ): unknown {
    if (expression.startsWith("input.")) return args[expression.slice(6)];
    if (expression === "context.userContent") return context.userContent;
    if (expression === "context.projectScopeId") return context.projectScopeId;
    const stepMatch = expression.match(/^steps\.(\d+)\.output$/u);
    if (stepMatch) return outputs[Number(stepMatch[1])]?.output || "";
    throw new Error(`工具模板占位符不受支持：{{${expression}}}`);
  }

  private async saveAll(recipes: LifeOSAgentToolRecipe[]): Promise<void> {
    await ensureFolder(this.app, this.fs.path("AI", "Tools"));
    await writeFile(this.app, this.filePath, `${JSON.stringify({ version: 1, recipes }, null, 2)}\n`);
  }

  private isStoredRecipe(value: unknown): value is LifeOSAgentToolRecipe {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const recipe = value as Partial<LifeOSAgentToolRecipe>;
    return typeof recipe.id === "string"
      && recipe.id.startsWith("custom-")
      && typeof recipe.name === "string"
      && typeof recipe.description === "string"
      && Boolean(recipe.inputSchema && typeof recipe.inputSchema === "object")
      && Array.isArray(recipe.steps)
      && recipe.steps.length > 0
      && recipe.steps.length <= MAX_STEPS;
  }

  private normalizeChannels(value: unknown): Array<"desktop" | "weixin"> {
    if (!Array.isArray(value)) return ["desktop", "weixin"];
    const channels = value.filter((item): item is "desktop" | "weixin" => item === "desktop" || item === "weixin");
    return channels.length > 0 ? [...new Set(channels)] : ["desktop", "weixin"];
  }

  private normalizeTimestamp(value: unknown): string {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  }

  private slug(value: string): string {
    return value.toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 56);
  }

  private hash(value: string): string {
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
    return `tool-${(hash >>> 0).toString(36)}`;
  }
}
