import { App } from "obsidian";
import type PersonalLifeSystemPlugin from "../main";
import { formatDate, formatTime } from "../utils/dates";
import { LlmWikiCompilerService, type CompiledLlmWikiDraft, type CompileLlmWikiSourceInput } from "./LlmWikiCompilerService";
import { LlmWikiDuplicateService, type LlmWikiDuplicateResult } from "./LlmWikiDuplicateService";
import { LlmWikiSourceService, type SaveLlmWikiTextSourceInput, type SavedLlmWikiSource } from "./LlmWikiSourceService";
import {
  classifyLlmWikiIntake,
  classifyLlmWikiMaterialLength,
  slugifyLlmWikiTitle,
  type LlmWikiPrivacyLevel,
  type LlmWikiSourceKind
} from "./llm-wiki-logic";

const BATCH_SLUG_MAX_LENGTH = 48;

export interface LlmWikiSaveInput {
  title: string;
  content: string;
  instruction: string;
  sourceKind: LlmWikiSourceKind;
  originalUrl?: string;
  sourcePath?: string;
  privacyOverride?: LlmWikiPrivacyLevel;
  personalConfirmed?: boolean;
  duplicateDecision?: "skip" | "save-anyway" | "save-as-version";
}

export interface LlmWikiSaveResult {
  savedSource?: SavedLlmWikiSource;
  draftPath?: string;
  duplicate?: LlmWikiDuplicateResult;
  requiresPersonalConfirmation: boolean;
  requiresDuplicateDecision: boolean;
  requiresLongMaterialAction: boolean;
  undoTargets: string[];
  message: string;
  compileError?: string;
}

export interface LlmWikiIntakeServiceDependencies {
  sourceService?: Pick<LlmWikiSourceService, "saveTextSource" | "saveTextVersionSource">;
  duplicateService?: Pick<LlmWikiDuplicateService, "findDuplicate">;
  compiler?: Pick<LlmWikiCompilerService, "compileSourceToDraft">;
  dateNow?: () => Date;
}

type LlmWikiSourceSaver = Pick<LlmWikiSourceService, "saveTextSource" | "saveTextVersionSource">;
type LlmWikiDuplicateFinder = Pick<LlmWikiDuplicateService, "findDuplicate">;
type LlmWikiCompiler = Pick<LlmWikiCompilerService, "compileSourceToDraft">;

export class LlmWikiIntakeService {
  private sourceService: LlmWikiSourceSaver;
  private duplicateService: LlmWikiDuplicateFinder;
  private compiler: LlmWikiCompiler;
  private dateNow: () => Date;

  constructor(private app: App, private plugin: PersonalLifeSystemPlugin, dependencies: LlmWikiIntakeServiceDependencies = {}) {
    this.sourceService = dependencies.sourceService ?? new LlmWikiSourceService(app, plugin.settings.rootFolder, {
      directoryLanguage: plugin.settings.directoryLanguage
    });
    this.duplicateService = dependencies.duplicateService ?? new LlmWikiDuplicateService(app, plugin.settings.rootFolder, plugin.settings.directoryLanguage);
    this.compiler = dependencies.compiler ?? new LlmWikiCompilerService(app, plugin.settings, plugin.ai);
    this.dateNow = dependencies.dateNow ?? (() => new Date());
  }

  async save(input: LlmWikiSaveInput): Promise<LlmWikiSaveResult> {
    const nowDate = this.dateNow();
    const capturedAt = `${formatDate(nowDate)} ${formatTime(nowDate)}`;
    const batchId = this.buildBatchId(capturedAt, input.title);
    const decision = classifyLlmWikiIntake(input.content, input.instruction);
    const privacyLevel = input.privacyOverride || decision.privacyLevel;
    const aiProcessingAllowed = true;
    const requiresPersonalConfirmation = decision.requiresConfirmation;

    if (requiresPersonalConfirmation && !input.personalConfirmed) {
      return {
        requiresPersonalConfirmation: true,
        requiresDuplicateDecision: false,
        requiresLongMaterialAction: false,
        undoTargets: [],
        message: "这份资料可能包含个人或敏感内容，请确认后再保存。"
      };
    }

    const duplicate = await this.duplicateService.findDuplicate(input.title, input.content, input.originalUrl || "");
    if (duplicate.kind === "exact" || duplicate.kind === "similar") {
      if (input.duplicateDecision === "skip") {
        return {
          duplicate,
          requiresPersonalConfirmation,
          requiresDuplicateDecision: false,
          requiresLongMaterialAction: false,
          undoTargets: [],
          message: "已跳过重复资料。"
        };
      }

      if (!input.duplicateDecision) {
        return {
          duplicate,
          requiresPersonalConfirmation,
          requiresDuplicateDecision: true,
          requiresLongMaterialAction: false,
          undoTargets: [],
          message: "这份资料可能已经存在，请选择跳过、仍然保存或作为新版保存。"
        };
      }
    }
    const duplicateContext = duplicate.kind === "none" ? undefined : duplicate;

    const sourceInput = {
      title: input.title,
      content: input.content,
      sourceKind: input.sourceKind,
      originalUrl: input.originalUrl,
      sourcePath: input.sourcePath,
      capturedAt,
      privacyLevel,
      aiProcessingAllowed,
      batchId,
      duplicateOf: duplicateContext && input.duplicateDecision === "save-anyway" ? duplicateContext.existingPath : undefined,
      versionOf: duplicateContext && input.duplicateDecision === "save-as-version" ? duplicateContext.existingPath : undefined,
      status: duplicateContext && input.duplicateDecision === "save-as-version" ? "versioned" as const : "inbox" as const
    } satisfies SaveLlmWikiTextSourceInput;
    const savedSource = duplicateContext && input.duplicateDecision === "save-as-version"
      ? await this.sourceService.saveTextVersionSource({ ...sourceInput, versionOf: duplicateContext.existingPath })
      : await this.sourceService.saveTextSource(sourceInput);
    const undoTargets = [savedSource.path];
    const materialLength = classifyLlmWikiMaterialLength(input.content);
    const requiresLongMaterialAction = materialLength !== "short";

    if (materialLength === "short" && aiProcessingAllowed) {
      try {
        const draft = await this.compiler.compileSourceToDraft({
          sourceId: savedSource.id,
          title: input.title,
          rawContent: input.content,
          privacyLevel,
          capturedAt,
          batchId,
          compileDepth: this.plugin.settings.llmWikiShortCompileDepth,
          aiProcessingAllowed
        } satisfies CompileLlmWikiSourceInput);
        undoTargets.push(draft.path);
        return this.savedWithDraft(savedSource, draft, requiresPersonalConfirmation, undoTargets, duplicateContext);
      } catch (error) {
        return {
          savedSource,
          duplicate: duplicateContext,
          requiresPersonalConfirmation,
          requiresDuplicateDecision: false,
          requiresLongMaterialAction: false,
          undoTargets,
          message: "已保存资料，但生成草稿失败。",
          compileError: error instanceof Error ? error.message : String(error)
        };
      }
    }

    return {
      savedSource,
      duplicate: duplicateContext,
      requiresPersonalConfirmation,
      requiresDuplicateDecision: false,
      requiresLongMaterialAction,
      undoTargets,
      message: requiresLongMaterialAction ? "已保存长资料，等待你选择整理方式。" : "已本地保存。"
    };
  }

  private savedWithDraft(
    savedSource: SavedLlmWikiSource,
    draft: CompiledLlmWikiDraft,
    requiresPersonalConfirmation: boolean,
    undoTargets: string[],
    duplicate?: LlmWikiDuplicateResult
  ): LlmWikiSaveResult {
    return {
      savedSource,
      draftPath: draft.path,
      duplicate,
      requiresPersonalConfirmation,
      requiresDuplicateDecision: false,
      requiresLongMaterialAction: false,
      undoTargets,
      message: "已保存并生成草稿。"
    };
  }

  private buildBatchId(capturedAt: string, title: string): string {
    const digits = capturedAt.replace(/\D/g, "").slice(0, 12) || "unknown";
    const slug = slugifyLlmWikiTitle(title).slice(0, BATCH_SLUG_MAX_LENGTH);
    return `batch_${digits}_${slug}`;
  }
}
