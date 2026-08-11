import type { App } from "obsidian";
import type { FileSystemService } from "./FileSystemService";
import type { LifeOSProject, LifeOSProjectDocument, LifeOSProjectSummary, LifeOSTask } from "../types";
import { formatDate } from "../utils/dates";
import { joinPath, normalizePath } from "../utils/vault";

export type ProjectWhiteboardStyle =
  | "knowledge-map"
  | "brainstorm"
  | "reading-breakdown"
  | "project-review"
  | "mind-map"
  | "flow-architecture"
  | "data-dashboard"
  | "file-board"
  | "planner-journal";

export interface ProjectWhiteboardStyleMeta {
  id: ProjectWhiteboardStyle;
  label: string;
  description: string;
  icon: string;
}

export interface ProjectWhiteboardGenerateOptions {
  style: ProjectWhiteboardStyle;
  includeDocuments?: boolean;
  includeRelatedTasks?: boolean;
  includeDataComponents?: boolean;
}

export interface ProjectWhiteboardGenerateInput {
  project: LifeOSProject;
  summary: LifeOSProjectSummary;
  documents?: LifeOSProjectDocument[];
  relatedTasks?: LifeOSTask[];
  options: ProjectWhiteboardGenerateOptions;
}

export interface ProjectWhiteboardResult {
  style: ProjectWhiteboardStyle;
  canvasPath: string;
  markdownPath: string;
  canvasFile: VaultFileLike;
  markdownFile: VaultFileLike;
  nodeCount: number;
  edgeCount: number;
  warnings: string[];
}

export interface ProjectWhiteboardAdjustmentInput {
  project: LifeOSProject;
  summary: LifeOSProjectSummary;
  documents?: LifeOSProjectDocument[];
  relatedTasks?: LifeOSTask[];
  prompt: string;
  latestCanvasPath?: string;
}

export interface ProjectWhiteboardAdjustmentResult extends ProjectWhiteboardResult {
  sourceCanvasPath?: string;
  adjustmentSummary: string;
}

interface CanvasTextNode {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color?: string;
}

interface CanvasFileNode {
  id: string;
  type: "file";
  x: number;
  y: number;
  width: number;
  height: number;
  file: string;
  color?: string;
}

type CanvasNode = CanvasTextNode | CanvasFileNode;

interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toNode: string;
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
  color?: string;
}

interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface CanvasBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface VaultFileLike {
  path: string;
  name: string;
  basename?: string;
  extension?: string;
  stat?: { mtime?: number };
  content?: string;
}

interface VaultFolderLike {
  path: string;
  name: string;
  children?: unknown[];
}

interface ProjectWhiteboardVault {
  getAbstractFileByPath(path: string): VaultFileLike | VaultFolderLike | null;
  getFiles?(): VaultFileLike[];
  read?(file: VaultFileLike): Promise<string>;
  createFolder(path: string): Promise<VaultFolderLike>;
  create(path: string, content: string): Promise<VaultFileLike>;
}

type NodeGroup =
  | "hub"
  | "task"
  | "done"
  | "document"
  | "section"
  | "concept"
  | "evidence"
  | "question"
  | "action"
  | "related"
  | "data"
  | "template"
  | "source";

type NodeInput = {
  id: string;
  title: string;
  body?: string;
  file?: string;
  group: NodeGroup;
  parentId?: string;
  relation?: string;
};

type StyleLayout = {
  name: string;
  summary: string;
  sections: Array<{ id: NodeGroup; title: string }>;
  place(index: number, total: number, node: NodeInput): { x: number; y: number; width: number; height: number };
  connect(hubId: string, node: NodeInput): Partial<CanvasEdge>;
};

type DocumentSection = {
  title: string;
  points: string[];
  level: number;
};

type DocumentAnalysis = {
  document: LifeOSProjectDocument;
  readableText: string;
  overview: string;
  sections: DocumentSection[];
  concepts: string[];
  evidence: string[];
  questions: string[];
  actions: string[];
};

export const PROJECT_WHITEBOARD_STYLES: ProjectWhiteboardStyleMeta[] = [
  {
    id: "knowledge-map",
    label: "知识地图",
    description: "按主题聚类资料、任务和项目概念，适合项目研究。",
    icon: "network"
  },
  {
    id: "brainstorm",
    label: "头脑风暴",
    description: "中心发散布局，适合快速展开想法和下一步。",
    icon: "sparkles"
  },
  {
    id: "reading-breakdown",
    label: "读书拆解",
    description: "按资料、观点、证据和行动拆解阅读材料。",
    icon: "book-open"
  },
  {
    id: "project-review",
    label: "项目复盘",
    description: "围绕目标、进展、阻塞、完成和下一步整理。",
    icon: "clipboard-check"
  },
  {
    id: "mind-map",
    label: "思维导图",
    description: "从项目文档标题、摘录和列表生成层级脑图。",
    icon: "git-branch"
  },
  {
    id: "flow-architecture",
    label: "流程 / 架构",
    description: "生成流程、模块、依赖和技术路线图。",
    icon: "workflow"
  },
  {
    id: "data-dashboard",
    label: "数据看板",
    description: "把任务进度、看板、统计和热力图放到白板。",
    icon: "bar-chart-3"
  },
  {
    id: "file-board",
    label: "文件预览板",
    description: "把 Markdown、PDF、图片和附件组织成资料墙。",
    icon: "files"
  },
  {
    id: "planner-journal",
    label: "手账模板",
    description: "周计划、路线、照片墙、习惯打卡等轻量模板。",
    icon: "calendar-check"
  }
];

const STYLE_LABELS: Record<ProjectWhiteboardStyle, string> = Object.fromEntries(
  PROJECT_WHITEBOARD_STYLES.map((style) => [style.id, style.label])
) as Record<ProjectWhiteboardStyle, string>;

export class ProjectWhiteboardService {
  constructor(private app: App, private fs: FileSystemService) {}

  static styles(): ProjectWhiteboardStyleMeta[] {
    return PROJECT_WHITEBOARD_STYLES;
  }

  projectRootPath(project: Pick<LifeOSProject, "id">): string {
    return joinPath(this.fs.path("Projects"), project.id);
  }

  whiteboardsPath(project: Pick<LifeOSProject, "id">): string {
    return joinPath(this.projectRootPath(project), "Whiteboards");
  }

  async generate(input: ProjectWhiteboardGenerateInput): Promise<ProjectWhiteboardResult> {
    const style = this.normalizeStyle(input.options.style);
    const folder = this.whiteboardsPath(input.project);
    await this.ensureFolder(folder);

    const baseName = `${formatDate()}-${this.slugify(input.project.name)}-${style}`;
    const canvasPath = this.uniquePath(folder, `${baseName}.canvas`);
    const markdownPath = this.uniquePath(folder, `${baseName}.md`);
    const warnings: string[] = [];

    const documents = this.selectedDocuments(input, style, warnings);
    const documentAnalyses = await this.analyzeDocuments(documents, warnings);
    const nodeInputs = this.buildNodeInputs(input, style, warnings, documentAnalyses);
    const canvas = this.buildCanvas(style, nodeInputs);
    const markdown = this.buildMarkdown(input, style, canvasPath, nodeInputs, warnings);

    const canvasFile = await this.vault().create(canvasPath, JSON.stringify(canvas, null, 2));
    const markdownFile = await this.vault().create(markdownPath, markdown);

    return {
      style,
      canvasPath,
      markdownPath,
      canvasFile,
      markdownFile,
      nodeCount: canvas.nodes.length,
      edgeCount: canvas.edges.length,
      warnings
    };
  }

  async adjustLatest(input: ProjectWhiteboardAdjustmentInput): Promise<ProjectWhiteboardAdjustmentResult> {
    const folder = this.whiteboardsPath(input.project);
    await this.ensureFolder(folder);

    const sourceFile = input.latestCanvasPath
      ? this.fileAtPath(input.latestCanvasPath)
      : this.latestCanvasFile(input.project);
    if (!sourceFile) {
      const generated = await this.generate({
        project: input.project,
        summary: input.summary,
        documents: input.documents,
        relatedTasks: input.relatedTasks,
        options: {
          style: "knowledge-map",
          includeDocuments: true,
          includeRelatedTasks: true,
          includeDataComponents: true
        }
      });
      return {
        ...generated,
        sourceCanvasPath: undefined,
        adjustmentSummary: "没有找到旧白板，已先生成一张新的知识地图白板。"
      };
    }

    const warnings: string[] = [];
    let sourceCanvas: CanvasDocument;
    try {
      sourceCanvas = this.normalizeCanvasDocument(JSON.parse(await this.readVaultFile(sourceFile)));
    } catch {
      warnings.push(`未能解析旧白板「${sourceFile.path}」，已基于项目内容生成调整版。`);
      sourceCanvas = this.buildCanvas("knowledge-map", this.buildNodeInputs({
        project: input.project,
        summary: input.summary,
        documents: input.documents,
        relatedTasks: input.relatedTasks,
        options: {
          style: "knowledge-map",
          includeDocuments: true,
          includeRelatedTasks: true,
          includeDataComponents: true
        }
      }, "knowledge-map", warnings, await this.analyzeDocuments(input.documents ?? [], warnings)));
    }

    const baseName = `${formatDate()}-${this.slugify(input.project.name)}-chat-adjustment`;
    const canvasPath = this.uniquePath(folder, `${baseName}.canvas`);
    const markdownPath = this.uniquePath(folder, `${baseName}.md`);
    const rebuildStyle = this.rebuildStyleFromAdjustmentPrompt(input.prompt);
    if (rebuildStyle) {
      const generated = await this.generate({
        project: input.project,
        summary: input.summary,
        documents: input.documents,
        relatedTasks: input.relatedTasks,
        options: {
          style: rebuildStyle,
          includeDocuments: true,
          includeRelatedTasks: true,
          includeDataComponents: true
        }
      });
      return {
        ...generated,
        sourceCanvasPath: sourceFile.path,
        adjustmentSummary: `已按对话要求重新生成「${STYLE_LABELS[rebuildStyle]}」版本，旧白板保持不变。`
      };
    }
    const adjustment = this.buildAdjustmentCanvas(sourceCanvas, input);
    const markdown = this.buildAdjustmentMarkdown(input, sourceFile.path, canvasPath, adjustment.addedNodes, warnings);

    const canvasFile = await this.vault().create(canvasPath, JSON.stringify(adjustment.canvas, null, 2));
    const markdownFile = await this.vault().create(markdownPath, markdown);

    return {
      style: "knowledge-map",
      canvasPath,
      markdownPath,
      canvasFile,
      markdownFile,
      nodeCount: adjustment.canvas.nodes.length,
      edgeCount: adjustment.canvas.edges.length,
      warnings,
      sourceCanvasPath: sourceFile.path,
      adjustmentSummary: `已按对话要求新增 ${adjustment.addedNodes.length} 个调整节点，旧白板保持不变。`
    };
  }

  private buildNodeInputs(
    input: ProjectWhiteboardGenerateInput,
    style: ProjectWhiteboardStyle,
    warnings: string[],
    documentAnalyses: DocumentAnalysis[]
  ): NodeInput[] {
    const nodes: NodeInput[] = [
      {
        id: "project-hub",
        title: input.project.name,
        group: "hub",
        body: [
          `风格：${STYLE_LABELS[style]}`,
          `状态：${input.project.status}`,
          `类型：${input.project.type}`,
          `进度：${input.summary.progress}%`,
          input.project.goal ? `目标：${input.project.goal}` : "目标：未填写"
        ].join("\n")
      }
    ];

    const isMindMap = style === "mind-map";
    const openTasks = input.summary.openTasks.slice(0, isMindMap ? 6 : 16);
    const doneTasks = input.summary.doneTasks.slice(isMindMap ? -3 : -8);
    const relatedTasks = input.options.includeRelatedTasks === false
      ? []
      : (input.relatedTasks ?? []).slice(0, isMindMap ? 4 : 10);

    if (openTasks.length === 0 && documentAnalyses.length === 0 && relatedTasks.length === 0) {
      warnings.push("项目目前缺少任务和资料，已生成 starter 白板。");
    }

    for (const [index, task] of openTasks.entries()) {
      nodes.push({
        id: `task-${index + 1}`,
        title: task.text,
        group: "task",
        parentId: "project-hub",
        relation: "待办",
        body: this.taskMeta(task, "待办")
      });
    }

    for (const [index, task] of doneTasks.entries()) {
      nodes.push({
        id: `done-${index + 1}`,
        title: task.text,
        group: "done",
        parentId: "project-hub",
        relation: "已完成",
        body: this.taskMeta(task, "已完成")
      });
    }

    for (const [index, analysis] of documentAnalyses.entries()) {
      const document = analysis.document;
      const sourceId = `document-source-${index + 1}`;
      const summaryId = `document-summary-${index + 1}`;
      nodes.push({
        id: summaryId,
        title: style === "mind-map" ? document.title : `${document.title} 摘要`,
        group: "document",
        parentId: "project-hub",
        relation: "资料拆解",
        body: analysis.overview
      });
      if (!isMindMap) {
        nodes.push({
          id: sourceId,
          title: document.title,
          group: "source",
          parentId: summaryId,
          relation: "原文",
          file: document.path
        });
      }

      const sectionLimit = style === "mind-map" ? 5 : style === "flow-architecture" ? 8 : style === "reading-breakdown" ? 5 : 3;
      const pointLimit = style === "mind-map" ? 2 : 3;
      const evidenceLimit = style === "mind-map" ? 0 : style === "reading-breakdown" ? 5 : 3;
      const conceptLimit = style === "mind-map" ? 0 : style === "knowledge-map" ? 6 : 4;
      const questionLimit = style === "mind-map" ? 0 : 3;
      const actionLimit = style === "mind-map" ? 0 : style === "project-review" || style === "flow-architecture" ? 4 : 2;

      for (const [sectionIndex, section] of analysis.sections.slice(0, sectionLimit).entries()) {
        const sectionId = `document-${index + 1}-section-${sectionIndex + 1}`;
        nodes.push({
          id: sectionId,
          title: section.title,
          group: "section",
          parentId: summaryId,
          relation: style === "mind-map" ? "结构" : "章节",
          body: this.sectionBody(section, document.title)
        });
        if (style === "mind-map") {
          for (const [pointIndex, point] of section.points.slice(0, pointLimit).entries()) {
            const pointTitle = this.truncate(this.firstPhrase(point), 42);
            nodes.push({
              id: `${sectionId}-point-${pointIndex + 1}`,
              title: pointTitle || `要点 ${pointIndex + 1}`,
              group: "concept",
              parentId: sectionId,
              relation: "要点",
              body: [`要点：${point}`, `来自：${document.title}`].join("\n")
            });
          }
        }
      }

      for (const [conceptIndex, concept] of analysis.concepts.slice(0, conceptLimit).entries()) {
        nodes.push({
          id: `document-${index + 1}-concept-${conceptIndex + 1}`,
          title: concept,
          group: "concept",
          parentId: summaryId,
          relation: "概念",
          body: `来自：${document.title}`
        });
      }

      for (const [evidenceIndex, evidence] of analysis.evidence.slice(0, evidenceLimit).entries()) {
        nodes.push({
          id: `document-${index + 1}-evidence-${evidenceIndex + 1}`,
          title: `证据 ${evidenceIndex + 1}`,
          group: "evidence",
          parentId: summaryId,
          relation: "证据",
          body: evidence
        });
      }

      for (const [questionIndex, question] of analysis.questions.slice(0, questionLimit).entries()) {
        nodes.push({
          id: `document-${index + 1}-question-${questionIndex + 1}`,
          title: question,
          group: "question",
          parentId: summaryId,
          relation: "问题",
          body: `来自：${document.title}`
        });
      }

      for (const [actionIndex, action] of analysis.actions.slice(0, actionLimit).entries()) {
        nodes.push({
          id: `document-${index + 1}-action-${actionIndex + 1}`,
          title: action,
          group: "action",
          parentId: summaryId,
          relation: style === "flow-architecture" ? "下一步" : "行动",
          body: `从资料「${document.title}」转化出的行动。`
        });
      }

      if (analysis.readableText.length === 0 && document.excerpt) {
        for (const child of this.extractMindMapChildren(document).slice(0, 3)) {
          nodes.push({
            id: `document-${index + 1}-${this.slugify(child).slice(0, 20)}`,
            title: child,
            group: "concept",
            parentId: summaryId,
            relation: "要点",
            body: `来自：${document.title}`
          });
        }
      }
    }

    for (const [index, task] of relatedTasks.entries()) {
      nodes.push({
        id: `related-${index + 1}`,
        title: task.text,
        group: "related",
        parentId: "project-hub",
        relation: "相关",
        body: this.taskMeta(task, "相关任务")
      });
    }

    if (input.options.includeDataComponents !== false) {
      const dataNodes: NodeInput[] = [
        {
          id: "data-progress",
          title: "任务进度",
          group: "data",
          parentId: "project-hub",
          relation: "统计",
          body: [
            `完成率：${input.summary.progress}%`,
            `已完成：${input.summary.doneCount}`,
            `未完成：${input.summary.openCount}`,
            `总任务：${input.summary.totalCount}`
          ].join("\n")
        },
        {
          id: "data-kanban",
          title: "看板快照",
          group: "data",
          parentId: "project-hub",
          relation: "统计",
          body: [
            `今日优先：${openTasks[0]?.text ?? "暂无"}`,
            `待办池：${input.summary.openCount}`,
            `最近完成：${doneTasks.length}`
          ].join("\n")
        },
        {
          id: "data-heatmap",
          title: "热力图占位",
          group: "data",
          parentId: "project-hub",
          relation: "统计",
          body: "后续可把复盘热力图、习惯打卡和任务节奏同步到这里。"
        }
      ];
      nodes.push(...(isMindMap ? dataNodes.slice(0, 1) : dataNodes));
    }

    nodes.push(...this.templateNodes(style));
    return nodes;
  }

  private buildCanvas(style: ProjectWhiteboardStyle, nodeInputs: NodeInput[]): CanvasDocument {
    if (style === "mind-map") return this.buildMindMapCanvas(nodeInputs);
    if (style === "flow-architecture") return this.buildFlowArchitectureCanvas(nodeInputs);

    const layout = this.layoutForStyle(style);
    const total = Math.max(1, nodeInputs.length - 1);
    const nodeIds = new Set(nodeInputs.map((node) => node.id));
    const groupTotals = new Map<NodeGroup, number>();
    const groupIndexes = new Map<NodeGroup, number>();
    for (const node of nodeInputs) {
      if (node.group === "hub") continue;
      groupTotals.set(node.group, (groupTotals.get(node.group) ?? 0) + 1);
    }
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

    for (let index = 0; index < nodeInputs.length; index += 1) {
      const source = nodeInputs[index];
      const groupIndex = groupIndexes.get(source.group) ?? 0;
      if (source.group !== "hub") groupIndexes.set(source.group, groupIndex + 1);
      const position = source.group === "hub"
        ? { x: 0, y: 0, ...this.nodeSize(source, 460, 260) }
        : layout.place(
          layout.name === "radial" ? index - 1 : groupIndex,
          layout.name === "radial" ? total : Math.max(1, groupTotals.get(source.group) ?? 1),
          source
        );
      nodes.push(this.toCanvasNode(source, position));
      if (source.group === "hub") continue;
      const fromNode = source.parentId && nodeIds.has(source.parentId) ? source.parentId : "project-hub";
      edges.push({
        id: `edge-${fromNode}-${source.id}`,
        fromNode,
        toNode: source.id,
        label: source.relation,
        ...layout.connect("project-hub", source)
      });
    }

    if (nodes.length === 1) {
      const starter = this.toCanvasNode({
        id: "starter-next-action",
        title: "下一步",
        group: "template",
        body: "补充目标、拖入资料，或新建第一条任务。"
      }, { x: 560, y: 0, width: 360, height: 180 });
      nodes.push(starter);
      edges.push({ id: "edge-project-hub-starter-next-action", fromNode: "project-hub", toNode: "starter-next-action" });
    }

    return this.polishGeneratedCanvas(style, { nodes, edges });
  }

  private buildFlowArchitectureCanvas(nodeInputs: NodeInput[]): CanvasDocument {
    const hub = nodeInputs.find((node) => node.group === "hub") ?? nodeInputs[0];
    if (!hub) return { nodes: [], edges: [] };

    const documentSummary = nodeInputs.find((node) => node.group === "document" && !this.isFlowNoiseNode(node));
    const mainPath = this.uniqueFlowNodes(
      nodeInputs
        .filter((node) => node.group === "section" || node.group === "action" || node.group === "task")
        .filter((node) => !this.isFlowNoiseNode(node))
    ).slice(0, 8);
    const supportNodes = this.uniqueFlowNodes(
      nodeInputs
        .filter((node) => node.group === "evidence" || node.group === "question")
        .filter((node) => !this.isFlowNoiseNode(node))
    ).slice(0, Math.min(8, Math.max(3, mainPath.length)));

    const compactHub = this.compactFlowNode(hub);
    const hubSize = this.nodeSize(compactHub, 460, 220);
    const hubPosition = { x: 0, y: 0, ...hubSize };
    const nodes: CanvasNode[] = [
      this.toCanvasNode(compactHub, hubPosition)
    ];
    const edges: CanvasEdge[] = [];

    if (documentSummary) {
      const summaryNode = this.compactFlowNode(documentSummary);
      const summarySize = this.nodeSize(summaryNode, 460, 190);
      nodes.push(this.toCanvasNode(summaryNode, { x: 0, y: -summarySize.height - 120, ...summarySize }));
      edges.push({
        id: `edge-${hub.id}-${documentSummary.id}`,
        fromNode: hub.id,
        fromSide: "top",
        toNode: documentSummary.id,
        toSide: "bottom",
        label: "资料摘要"
      });
    }

    if (mainPath.length === 0) {
      const starterSource: NodeInput = {
        id: "starter-next-action",
        title: "先补齐主路径",
        group: "template",
        body: "补充阶段、步骤、路线节点或模块依赖后，再生成流程白板。"
      };
      const starterSize = this.nodeSize(starterSource, 400, 170);
      const starter = this.toCanvasNode(starterSource, { x: hubPosition.x + hubPosition.width + 150, y: 0, ...starterSize });
      nodes.push(starter);
      edges.push({
        id: `edge-${hub.id}-starter-next-action`,
        fromNode: hub.id,
        fromSide: "right",
        toNode: "starter-next-action",
        toSide: "left",
        label: "开始"
      });
      return this.normalizeCanvasEdges({ nodes, edges });
    }

    const stagePositions = new Map<string, { x: number; y: number; width: number; height: number }>();
    const compactStages = mainPath.map((node, index) => this.compactFlowNode(node, `阶段 ${index + 1}`));
    let cursorX = hubPosition.x + hubPosition.width + 150;
    for (const [index, node] of mainPath.entries()) {
      const compactNode = compactStages[index];
      const size = this.nodeSize(compactNode, 380, 210);
      const position = {
        x: cursorX,
        y: -20,
        ...size
      };
      stagePositions.set(node.id, position);
      nodes.push(this.toCanvasNode(compactNode, position));
      edges.push(index === 0
        ? {
            id: `edge-${hub.id}-${node.id}`,
            fromNode: hub.id,
            fromSide: "right",
            toNode: node.id,
            toSide: "left",
            label: "开始"
          }
        : {
            id: `edge-flow-${mainPath[index - 1].id}-${node.id}`,
            fromNode: mainPath[index - 1].id,
            fromSide: "right",
            toNode: node.id,
            toSide: "left",
            label: "下一步"
          });
      cursorX += position.width + 260;
    }

    const supportCursorByAnchor = new Map<string, number>();
    for (const [index, node] of supportNodes.entries()) {
      const anchor = mainPath[index % mainPath.length];
      const anchorPosition = stagePositions.get(anchor.id) ?? { x: 560, y: -20, width: 360, height: 170 };
      const compactNode = this.compactFlowNode(node);
      const size = this.nodeSize(compactNode, Math.min(Math.max(anchorPosition.width, 340), 460), 180);
      const cursorY = supportCursorByAnchor.get(anchor.id) ?? anchorPosition.y + anchorPosition.height + 120;
      const position = {
        x: anchorPosition.x + Math.round((anchorPosition.width - size.width) / 2),
        y: cursorY,
        ...size
      };
      supportCursorByAnchor.set(anchor.id, cursorY + size.height + 90);
      nodes.push(this.toCanvasNode(compactNode, position));
      edges.push({
        id: `edge-support-${anchor.id}-${node.id}`,
        fromNode: anchor.id,
        fromSide: "bottom",
        toNode: node.id,
        toSide: "top",
        label: node.group === "question" ? "待核验" : "依据"
      });
    }

    return this.normalizeCanvasEdges({ nodes, edges });
  }

  private buildMindMapCanvas(nodeInputs: NodeInput[]): CanvasDocument {
    const hub = nodeInputs.find((node) => node.group === "hub") ?? nodeInputs[0];
    if (!hub) return { nodes: [], edges: [] };

    const nodeIds = new Set(nodeInputs.map((node) => node.id));
    const byId = new Map(nodeInputs.map((node) => [node.id, node]));
    const childrenByParent = new Map<string, NodeInput[]>();

    for (const node of nodeInputs) {
      if (node.id === hub.id || node.group === "source") continue;
      const parentId = node.parentId && nodeIds.has(node.parentId) ? node.parentId : hub.id;
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(node);
      childrenByParent.set(parentId, siblings);
    }

    for (const children of childrenByParent.values()) {
      children.sort((left, right) => this.mindMapGroupOrder(left.group) - this.mindMapGroupOrder(right.group));
    }

    const nodes: CanvasNode[] = [
      this.toCanvasNode(hub, { x: 0, y: -130, width: 480, height: 260 })
    ];
    const placed = new Set<string>([hub.id]);
    const rootChildren = childrenByParent.get(hub.id) ?? [];

    if (rootChildren.length === 0) {
      const starter = this.toCanvasNode({
        id: "starter-next-action",
        title: "下一步",
        group: "template",
        parentId: hub.id,
        relation: "开始",
        body: "补充目标、拖入资料，或新建第一条任务。"
      }, { x: 620, y: -90, width: 360, height: 180 });
      nodes.push(starter);
      return {
        nodes,
        edges: [{ id: "edge-project-hub-starter-next-action", fromNode: hub.id, fromSide: "right", toNode: "starter-next-action", toSide: "left", label: "开始" }]
      };
    }

    const rootGap = 96;
    const rootHeights = rootChildren.map((child) => this.mindMapSubtreeHeight(child, childrenByParent, 1));
    const totalHeight = rootHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rootChildren.length - 1) * rootGap;
    let cursorY = -totalHeight / 2;
    for (let index = 0; index < rootChildren.length; index += 1) {
      const child = rootChildren[index];
      const branchHeight = rootHeights[index];
      this.placeMindMapBranch(child, 1, cursorY + branchHeight / 2, childrenByParent, nodes, placed);
      cursorY += branchHeight + rootGap;
    }

    const canvasNodeIds = new Set(nodes.map((node) => node.id));
    const edges: CanvasEdge[] = [];
    for (const canvasNode of nodes) {
      if (canvasNode.id === hub.id) continue;
      const source = byId.get(canvasNode.id);
      const fromNode = source?.parentId && canvasNodeIds.has(source.parentId) ? source.parentId : hub.id;
      edges.push({
        id: `edge-${fromNode}-${canvasNode.id}`,
        fromNode,
        fromSide: "right",
        toNode: canvasNode.id,
        toSide: "left",
        label: source?.relation
      });
    }

    return { nodes, edges };
  }

  private placeMindMapBranch(
    node: NodeInput,
    depth: number,
    centerY: number,
    childrenByParent: Map<string, NodeInput[]>,
    nodes: CanvasNode[],
    placed: Set<string>
  ): void {
    if (placed.has(node.id)) return;
    placed.add(node.id);

    const size = this.mindMapNodeSize(node, depth);
    nodes.push(this.toCanvasNode(node, {
      x: 720 + (depth - 1) * 760,
      y: Math.round(centerY - size.height / 2),
      width: size.width,
      height: size.height
    }));

    const children = (childrenByParent.get(node.id) ?? []).filter((child) => !placed.has(child.id));
    if (children.length === 0) return;

    const childGap = depth === 1 ? 64 : 46;
    const childHeights = children.map((child) => this.mindMapSubtreeHeight(child, childrenByParent, depth + 1));
    const childrenHeight = childHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, children.length - 1) * childGap;
    let cursorY = centerY - childrenHeight / 2;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const childHeight = childHeights[index];
      this.placeMindMapBranch(child, depth + 1, cursorY + childHeight / 2, childrenByParent, nodes, placed);
      cursorY += childHeight + childGap;
    }
  }

  private mindMapSubtreeHeight(node: NodeInput, childrenByParent: Map<string, NodeInput[]>, depth: number): number {
    const size = this.mindMapNodeSize(node, depth);
    const children = childrenByParent.get(node.id) ?? [];
    if (children.length === 0) return size.height;
    const childGap = node.group === "document" ? 64 : 46;
    const childrenHeight = children
      .map((child) => this.mindMapSubtreeHeight(child, childrenByParent, depth + 1))
      .reduce((sum, height) => sum + height, 0) + Math.max(0, children.length - 1) * childGap;
    return Math.max(size.height, childrenHeight);
  }

  private mindMapNodeSize(node: NodeInput, depth: number): { width: number; height: number } {
    const fallbackWidth = node.group === "document" ? 420 : node.group === "section" ? 360 : 300;
    const fallbackHeight = depth <= 1 ? 180 : node.group === "concept" ? 120 : 150;
    return this.nodeSize(node, fallbackWidth, fallbackHeight);
  }

  private mindMapGroupOrder(group: NodeGroup): number {
    return {
      hub: 0,
      document: 1,
      section: 2,
      concept: 3,
      action: 4,
      question: 5,
      evidence: 6,
      task: 7,
      related: 8,
      data: 9,
      done: 10,
      template: 11,
      source: 12
    }[group];
  }

  private uniqueFlowNodes(nodes: NodeInput[]): NodeInput[] {
    const seen = new Set<string>();
    const result: NodeInput[] = [];
    for (const node of nodes) {
      const title = this.flowNodeTitle(node);
      const key = title.toLowerCase().replace(/\s+/g, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(node);
    }
    return result;
  }

  private compactFlowNode(node: NodeInput, fallbackTitle?: string): NodeInput {
    const snippets = this.markdownSnippets(node.body ?? "");
    const title = this.flowNodeTitle(node) || fallbackTitle || node.title;
    const bodyLines = snippets
      .filter((snippet) => !this.isFlowNoiseText(snippet))
      .slice(0, node.group === "hub" || node.group === "document" ? 4 : 3);
    return {
      ...node,
      file: undefined,
      title: this.truncate(title, node.group === "hub" || node.group === "document" ? 34 : 30),
      body: bodyLines.length > 0 ? bodyLines.map((line) => `- ${this.truncate(line, 80)}`).join("\n") : node.body
    };
  }

  private flowNodeTitle(node: NodeInput): string {
    const snippets = this.markdownSnippets(node.body ?? "");
    const genericEvidence = /^证据\s*\d+$/u.test(node.title.trim());
    const genericAction = /^行动\s*\d+$/u.test(node.title.trim());
    const genericQuestion = /^问题\s*\d+$/u.test(node.title.trim());
    const source = (genericEvidence || genericAction || genericQuestion) && snippets[0]
      ? snippets[0]
      : node.title;
    const clean = this.cleanInlineText(source);
    if (/^(第[一二三四五六七八九十\d]+阶段|阶段\s*\d+|step\s*\d+)[:：]/iu.test(clean)) {
      return this.truncate(clean, 48);
    }
    return this.cleanInlineText(this.firstPhrase(source));
  }

  private isFlowNoiseNode(node: NodeInput): boolean {
    if (node.file || node.group === "source" || node.group === "concept" || node.group === "template" || node.group === "data") return true;
    const title = this.flowNodeTitle(node);
    return this.isFlowNoiseText(title);
  }

  private isFlowNoiseText(text: string): boolean {
    const normalized = this.cleanInlineText(text).replace(/\s+/g, "");
    if (!normalized) return true;
    return /^(用户要求|白板提纲|白板内容|中心主题|关键节点|节点关系|关键关系|可放进白板的卡片|待核验问题|关键词双链|资料摘要|原文)$/u.test(normalized)
      || /^对话白板[-—]?/u.test(normalized);
  }

  private toCanvasNode(
    source: NodeInput,
    position: { x: number; y: number; width: number; height: number }
  ): CanvasNode {
    const color = this.colorForGroup(source.group);
    if (source.file) {
      return {
        id: source.id,
        type: "file",
        ...position,
        file: source.file,
        color
      };
    }
    return {
      id: source.id,
      type: "text",
      ...position,
      text: [`# ${source.title}`, source.body ?? ""].filter(Boolean).join("\n\n"),
      color
    };
  }

  private buildMarkdown(
    input: ProjectWhiteboardGenerateInput,
    style: ProjectWhiteboardStyle,
    canvasPath: string,
    nodes: NodeInput[],
    warnings: string[]
  ): string {
    const sections = this.layoutForStyle(style).sections;
    const lines = [
      "---",
      "type: lifeos-project-whiteboard",
      `project_id: ${yamlScalar(input.project.id)}`,
      `project_name: ${yamlScalar(input.project.name)}`,
      `whiteboard_style: ${style}`,
      `canvas: ${yamlScalar(canvasPath)}`,
      `generated: ${formatDate()}`,
      "---",
      "",
      `# ${input.project.name} · ${STYLE_LABELS[style]}`,
      "",
      `Canvas：[[${canvasPath}]]`,
      "",
      "## 项目概览",
      "",
      `- 状态：${input.project.status}`,
      `- 类型：${input.project.type}`,
      `- 进度：${input.summary.progress}%`,
      `- 待办：${input.summary.openCount}`,
      `- 已完成：${input.summary.doneCount}`,
      input.project.goal ? `- 目标：${input.project.goal}` : "- 目标：未填写",
      ""
    ];

    for (const section of sections) {
      const groupNodes = nodes.filter((node) => node.group === section.id);
      if (groupNodes.length === 0) continue;
      lines.push(`## ${section.title}`, "");
      for (const node of groupNodes) {
        if (node.group === "hub") continue;
        const target = node.file ? ` [[${node.file}]]` : "";
        lines.push(`- ${node.title}${target}`);
        if (!node.file && node.body) {
          for (const snippet of this.markdownSnippets(node.body).slice(0, 3)) {
            lines.push(`  - ${snippet}`);
          }
        }
      }
      lines.push("");
    }

    if (warnings.length > 0) {
      lines.push("## 生成说明", "", ...warnings.map((warning) => `- ${warning}`), "");
    }

    return lines.join("\n").trim() + "\n";
  }

  private layoutForStyle(style: ProjectWhiteboardStyle): StyleLayout {
    const sections = [
      { id: "task" as const, title: "待办任务" },
      { id: "document" as const, title: "项目资料" },
      { id: "source" as const, title: "来源文件" },
      { id: "section" as const, title: "内容拆解" },
      { id: "concept" as const, title: "关键概念" },
      { id: "evidence" as const, title: "证据与摘录" },
      { id: "question" as const, title: "待澄清问题" },
      { id: "action" as const, title: "资料转行动" },
      { id: "related" as const, title: "相关任务" },
      { id: "done" as const, title: "最近完成" },
      { id: "data" as const, title: "数据组件" },
      { id: "template" as const, title: "模板区" }
    ];

    if (style === "flow-architecture") {
      return {
        name: "flow",
        summary: "左到右的流程和依赖布局。",
        sections,
        place: (index, _total, node) => ({
          x: 560 + this.flowColumn(node.group) * 430,
          y: this.groupLane(node.group) * 250 + index * 210,
          ...this.nodeSize(node, 360, node.file ? 260 : 180)
        }),
        connect: () => ({ fromSide: "right", toSide: "left" })
      };
    }

    if (style === "mind-map") {
      return {
        name: "mind-tree",
        summary: "按项目、资料、章节和要点逐层展开。",
        sections,
        place: (_index, _total, node) => ({
          x: this.groupColumn(node) * 430,
          y: 360 + this.groupLane(node.group) * 220,
          ...this.nodeSize(node, node.group === "section" ? 360 : 300, 160)
        }),
        connect: () => ({ fromSide: "right", toSide: "left" })
      };
    }

    if (style === "brainstorm") {
      return {
        name: "radial",
        summary: "围绕项目中心发散。",
        sections,
        place: (index, total, node) => {
          const angle = (Math.PI * 2 * index) / Math.max(total, 1);
          const radius = 760;
          return {
            x: Math.round(Math.cos(angle) * radius),
            y: Math.round(Math.sin(angle) * radius),
            ...this.nodeSize(node, node.file ? 360 : 330, node.file ? 260 : 170)
          };
        },
        connect: () => ({})
      };
    }

    if (style === "data-dashboard") {
      return {
        name: "dashboard",
        summary: "按数据、任务和资料分区。",
        sections,
        place: (index, _total, node) => ({
          x: this.groupColumn(node) * 430,
          y: 360 + index * 220,
          ...this.nodeSize(node, node.group === "data" ? 400 : 340, node.file ? 250 : 170)
        }),
        connect: () => ({})
      };
    }

    if (style === "file-board") {
      return {
        name: "file-board",
        summary: "文件墙优先，任务和数据在侧边。",
        sections,
        place: (index, _total, node) => {
          const column = this.fileBoardColumn(node);
          return {
            x: column * 430,
            y: this.fileBoardBaseY(node.group) + index * this.fileBoardGap(node),
            ...this.nodeSize(node, node.file ? 360 : 340, node.file ? 280 : 170)
          };
        },
        connect: () => ({})
      };
    }

    return {
      name: "cluster",
      summary: "按主题分区的项目知识地图。",
      sections,
      place: (index, _total, node) => ({
        x: this.groupColumn(node) * 430,
        y: 360 + index * 220,
        ...this.nodeSize(node, node.file ? 300 : 340, node.file ? 180 : 170)
      }),
      connect: () => ({})
    };
  }

  private templateNodes(style: ProjectWhiteboardStyle): NodeInput[] {
    if (style === "planner-journal") {
      return [
        { id: "template-week-plan", title: "周计划", group: "template", body: "- 本周目标\n- 三个重点\n- 复盘问题" },
        { id: "template-habit", title: "习惯打卡", group: "template", body: "把打卡、阅读、运动或照片墙放在这里。" },
        { id: "template-route", title: "路线 / 时间线", group: "template", body: "适合旅行路线、会议流程和项目节奏。" }
      ];
    }
    if (style === "reading-breakdown") {
      return [
        { id: "template-viewpoint", title: "核心观点", group: "template", body: "从资料中抽取关键观点。" },
        { id: "template-evidence", title: "证据与摘录", group: "template", body: "把引用、页码和链接集中到这里。" },
        { id: "template-action", title: "行动化", group: "template", body: "这些资料能改变什么决策？" }
      ];
    }
    if (style === "project-review") {
      return [
        { id: "template-blockers", title: "阻塞", group: "template", body: "当前最影响推进的障碍。" },
        { id: "template-next", title: "下一步", group: "template", body: "明确一个最小行动。" }
      ];
    }
    return [];
  }

  private selectedDocuments(
    input: ProjectWhiteboardGenerateInput,
    style: ProjectWhiteboardStyle,
    warnings: string[]
  ): LifeOSProjectDocument[] {
    if (input.options.includeDocuments === false) return [];
    const limit = style === "mind-map" ? 5 : 18;
    const documents = input.documents ?? [];
    if (style === "mind-map" && documents.length > limit) {
      warnings.push(`思维导图已优先拆解前 ${limit} 份资料，完整文件关系可使用「文件预览板」风格。`);
    }
    return documents.slice(0, limit);
  }

  private async analyzeDocuments(
    documents: LifeOSProjectDocument[],
    warnings: string[]
  ): Promise<DocumentAnalysis[]> {
    const analyses: DocumentAnalysis[] = [];
    for (const document of documents) {
      analyses.push(await this.analyzeDocument(document, warnings));
    }
    return analyses;
  }

  private async analyzeDocument(document: LifeOSProjectDocument, warnings: string[]): Promise<DocumentAnalysis> {
    let raw = "";
    const file = this.vault().getAbstractFileByPath(document.path);
    if (this.isFile(file)) {
      try {
        raw = await this.readVaultFile(file);
      } catch (error) {
        warnings.push(`未能读取「${document.title}」正文，已使用摘要生成拆解节点。`);
      }
    }

    const readableText = this.extractReadableText(raw, document.excerpt ?? "");
    if (!readableText && !document.excerpt) {
      warnings.push(`「${document.title}」没有可拆解正文，只保留文件预览节点。`);
    }

    const sections = this.extractDocumentSections(readableText, document);
    const concepts = this.extractConcepts(sections, document);
    const evidence = this.extractEvidence(sections, readableText);
    const questions = this.extractQuestions(sections, readableText);
    const actions = this.extractActions(sections, readableText);

    return {
      document,
      readableText,
      overview: this.documentOverview(document, sections, concepts, evidence, questions, actions),
      sections,
      concepts,
      evidence,
      questions,
      actions
    };
  }

  private async readVaultFile(file: VaultFileLike): Promise<string> {
    const vault = this.vault();
    if (typeof vault.read === "function") return vault.read(file);
    return typeof file.content === "string" ? file.content : "";
  }

  private extractReadableText(raw: string, fallback: string): string {
    const fallbackText = this.cleanMarkdownBlock(fallback);
    if (!raw.trim()) return fallbackText;
    let text = raw.replace(/^\uFEFF/, "").replace(/^---[\s\S]*?---\s*/, "");
    const searchableMatch = text.match(/^##\s+可检索正文\s*$/m);
    if (searchableMatch?.index !== undefined) {
      text = text.slice(searchableMatch.index + searchableMatch[0].length);
    }
    return this.cleanMarkdownBlock(this.removeWrapperSections(text)) || fallbackText;
  }

  private removeWrapperSections(text: string): string {
    const lines = text.split(/\r?\n/);
    const kept: string[] = [];
    let skip = false;
    for (const line of lines) {
      const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
      if (heading) {
        skip = this.isNoiseHeading(heading[1]);
        if (skip) continue;
      }
      if (!skip) kept.push(line);
    }
    return kept.join("\n");
  }

  private extractDocumentSections(text: string, document: LifeOSProjectDocument): DocumentSection[] {
    const lines = text.split(/\r?\n/);
    const sections: DocumentSection[] = [];
    const loose: string[] = [];
    let current: DocumentSection | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const heading = line.match(/^(#{1,4})\s+(.+?)\s*$/);
      if (heading) {
        const title = this.cleanInlineText(heading[2]);
        if (!title || this.isNoiseHeading(title)) {
          current = null;
          continue;
        }
        current = { title, points: [], level: heading[1].length };
        sections.push(current);
        continue;
      }

      const point = this.cleanPoint(line);
      if (!point) continue;
      if (current && current.points.length < 6) {
        current.points.push(point);
      } else if (loose.length < 12) {
        loose.push(point);
      }
    }

    if (sections.length === 0) {
      const chunks = this.headinglessContentSections(text, document, loose);
      if (chunks.length > 0) return chunks;
      const title = document.title || "核心内容";
      return [{ title, points: loose.slice(0, 6), level: 2 }];
    }

    return sections
      .map((section) => ({
        ...section,
        points: section.points.length > 0 ? section.points : loose.slice(0, 4)
      }))
      .filter((section) => section.title.length > 0);
  }

  private headinglessContentSections(text: string, document: LifeOSProjectDocument, loose: string[]): DocumentSection[] {
    const candidates = this.uniqueStrings([
      ...loose,
      ...this.sentenceCandidates(text)
    ]).filter((item) => item.length >= 8);
    if (candidates.length === 0) return [];

    const sections: DocumentSection[] = [];
    const maxSections = Math.min(5, Math.max(2, Math.ceil(candidates.length / 4)));
    for (let index = 0; index < maxSections; index += 1) {
      const start = index * 4;
      const points = candidates.slice(start, start + 4);
      if (points.length === 0) continue;
      const title = this.contentChunkTitle(points[0], index, document);
      sections.push({ title, points, level: 2 });
    }
    return sections;
  }

  private contentChunkTitle(firstPoint: string, index: number, document: LifeOSProjectDocument): string {
    const phrase = this.firstPhrase(firstPoint)
      .replace(/^(本文|这个|该|本节|其中|同时|因此|所以)/, "")
      .trim();
    if (phrase.length >= 4 && phrase.length <= 28) return phrase;
    return `${document.title || "资料"} · 主题 ${index + 1}`;
  }

  private extractConcepts(sections: DocumentSection[], document: LifeOSProjectDocument): string[] {
    const candidates = [
      document.title,
      ...sections.map((section) => section.title),
      ...sections.flatMap((section) => section.points.map((point) => this.firstPhrase(point)))
    ];
    return this.uniqueStrings(candidates)
      .filter((item) => item.length >= 2 && item.length <= 36)
      .slice(0, 12);
  }

  private extractEvidence(sections: DocumentSection[], text: string): string[] {
    const candidates = [
      ...sections.flatMap((section) => section.points),
      ...this.sentenceCandidates(text)
    ];
    const keywordEvidence = candidates.filter((item) => /证据|数据|结论|结果|显示|表明|来源|引用|发现|实验|测试|要求|风险|问题|原因|影响|指标|趋势|样本|案例|支撑|证明|依据/.test(item));
    return this.uniqueStrings([...keywordEvidence, ...candidates.filter((item) => item.length >= 18)])
      .map((item) => this.truncate(item, 170))
      .slice(0, 10);
  }

  private extractQuestions(sections: DocumentSection[], text: string): string[] {
    const candidates = [
      ...sections.flatMap((section) => section.points),
      ...this.sentenceCandidates(text)
    ];
    return this.uniqueStrings(candidates)
      .filter((item) => /[?？]|为什么|如何|是否|什么|能否|怎样|哪/.test(item))
      .map((item) => this.truncate(item.replace(/[?？]\s*$/, ""), 48))
      .slice(0, 8);
  }

  private extractActions(sections: DocumentSection[], text: string): string[] {
    const candidates = [
      ...sections.flatMap((section) => section.points),
      ...this.sentenceCandidates(text)
    ];
    return this.uniqueStrings(candidates)
      .filter((item) => /待办|下一步|行动|计划|建议|需要|应当|应该|完成|实现|推进|整理|复盘|todo/i.test(item))
      .map((item) => this.truncate(item, 52))
      .slice(0, 8);
  }

  private documentOverview(
    document: LifeOSProjectDocument,
    sections: DocumentSection[],
    concepts: string[],
    evidence: string[],
    questions: string[],
    actions: string[]
  ): string {
    const themes = sections.slice(0, 4).map((section) => section.title).join("、") || document.title;
    const highlights = this.uniqueStrings([
      ...sections.flatMap((section) => section.points),
      ...evidence
    ]).slice(0, 4);
    return [
      `类型：${document.kind}`,
      `来源：[[${document.path}]]`,
      `主题：${themes}`,
      `拆解：${sections.length} 个章节 / ${concepts.length} 个概念 / ${evidence.length} 条证据`,
      questions.length > 0 ? `待澄清：${questions.slice(0, 2).join("；")}` : "",
      actions.length > 0 ? `可行动：${actions.slice(0, 2).join("；")}` : "",
      "",
      "关键要点：",
      ...(highlights.length > 0 ? highlights.map((item) => `- ${item}`) : ["- 暂无可提取要点"])
    ].filter(Boolean).join("\n");
  }

  private sectionBody(section: DocumentSection, sourceTitle: string): string {
    return [
      `来自：${sourceTitle}`,
      ...(section.points.length > 0 ? section.points.map((point) => `- ${point}`) : ["- 暂无正文要点"])
    ].join("\n");
  }

  private taskMeta(task: LifeOSTask, label: string): string {
    return [
      `状态：${label}`,
      task.date ? `日期：${task.date}` : "",
      task.tags.length > 0 ? `标签：${task.tags.join(", ")}` : "",
      `来源：${task.source}`
    ].filter(Boolean).join("\n");
  }

  private extractMindMapChildren(document: LifeOSProjectDocument): string[] {
    const source = `${document.title}\n${document.excerpt ?? ""}`;
    const fromBullets = Array.from(source.matchAll(/(?:^|\s)[-•]\s*([^。；;，,\n]{2,36})/g)).map((match) => match[1].trim());
    const fromSentences = (document.excerpt ?? "")
      .split(/[。；;\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4 && item.length <= 36);
    return [...new Set([...fromBullets, ...fromSentences])];
  }

  private markdownSnippets(body: string): string[] {
    return body
      .split(/\r?\n/)
      .map((line) => this.cleanPoint(line))
      .filter((line): line is string => Boolean(line))
      .filter((line) => !/^类型：|^来源：|^来自：/.test(line))
      .map((line) => this.truncate(line, 96));
  }

  private cleanMarkdownBlock(value: string): string {
    return value
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.replace(/\t/g, "  ").trimEnd())
      .join("\n")
      .trim();
  }

  private isNoiseHeading(title: string): boolean {
    return /^(原始文件|导入说明|可检索正文|笔记属性|附件|用户要求|白板提纲|metadata|frontmatter)$/i.test(title.trim());
  }

  private cleanInlineText(value: string): string {
    return this.truncate(
      value
        .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/[*_~#]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      64
    );
  }

  private cleanPoint(value: string): string | null {
    const clean = value
      .replace(/^>\s*/, "")
      .replace(/^\s*(?:[-*+•]|\d+[.)]|[一二三四五六七八九十]+[、.])\s*/, "")
      .replace(/^\[(?: |x|X)\]\s*/, "")
      .replace(/\!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/[*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length < 2) return null;
    if (/^https?:\/\//i.test(clean)) return null;
    return this.truncate(clean, 170);
  }

  private firstPhrase(value: string): string {
    return this.truncate(value.split(/[：:，,。；;、]/)[0]?.trim() ?? value, 36);
  }

  private sentenceCandidates(text: string): string[] {
    return this.uniqueStrings(
      this.cleanMarkdownBlock(text)
        .replace(/^#{1,6}\s+/gm, "")
        .split(/[。！？!?；;\n]+/)
        .map((item) => this.cleanPoint(item))
        .filter((item): item is string => Boolean(item))
    );
  }

  private uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const clean = this.cleanInlineText(value);
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      result.push(clean);
    }
    return result;
  }

  private truncate(value: string, maxLength: number): string {
    const clean = value.trim();
    return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 1))}…` : clean;
  }

  private nodeSize(node: NodeInput, fallbackWidth: number, fallbackHeight: number): { width: number; height: number } {
    const width = this.nodeWidth(node, fallbackWidth);
    return {
      width,
      height: this.nodeHeight(node, fallbackHeight, width)
    };
  }

  private nodeWidth(node: NodeInput, fallback: number): number {
    if (node.group === "source") return Math.min(Math.max(fallback, 320), 380);
    if (node.file) return Math.max(fallback, 360);
    const titleColumns = this.visualColumns(node.title);
    const bodyColumns = Math.max(
      0,
      ...(node.body ?? "")
        .split(/\r?\n/)
        .map((line) => this.visualColumns(this.cleanInlineText(line)))
    );
    const desired = 180 + Math.min(Math.max(titleColumns, bodyColumns), 54) * 7;
    const minimum = node.group === "hub" ? 460
      : node.group === "document" ? 430
        : node.group === "section" || node.group === "evidence" ? 420
          : node.group === "question" || node.group === "action" ? 400
            : fallback;
    const maximum = node.group === "hub" || node.group === "document" ? 640
      : node.group === "section" || node.group === "evidence" || node.group === "question" || node.group === "action" ? 560
        : 460;
    return Math.min(maximum, Math.max(fallback, minimum, desired));
  }

  private nodeHeight(node: NodeInput, fallback: number, width?: number): number {
    if (node.file) return Math.max(fallback, 240);
    const availableColumns = Math.max(18, Math.floor(((width ?? this.nodeWidth(node, 360)) - 56) / 7));
    const titleLines = Math.max(1, Math.ceil(this.visualColumns(node.title) / availableColumns));
    const bodyLines = (node.body ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(this.visualColumns(this.cleanInlineText(line)) / availableColumns)), 0);
    const estimated = 86 + titleLines * 30 + bodyLines * 22;
    const maximum = node.group === "hub" || node.group === "document" ? 620
      : node.group === "section" || node.group === "evidence" || node.group === "question" || node.group === "action" ? 520
        : 420;
    return Math.min(maximum, Math.max(fallback, estimated));
  }

  private visualColumns(value: string): number {
    return Array.from(value.replace(/\s+/g, " ").trim()).reduce((sum, char) => {
      return sum + (/[\u2e80-\u9fff\uff00-\uffef]/u.test(char) ? 2 : 1);
    }, 0);
  }

  private flowColumn(group: NodeGroup): number {
    return {
      hub: 0,
      task: 0,
      document: 0,
      source: 0,
      section: 1,
      concept: 2,
      evidence: 3,
      question: 4,
      action: 4,
      related: 1,
      done: 1,
      data: 2,
      template: 3
    }[group];
  }

  private fileBoardColumn(node: NodeInput): number {
    if (node.group === "source") return 0;
    return {
      hub: 0,
      task: -1,
      related: -1,
      done: -1,
      data: -1,
      template: -1,
      document: 1,
      source: 0,
      section: 2,
      concept: 3,
      evidence: 4,
      question: 4,
      action: 4
    }[node.group];
  }

  private fileBoardBaseY(group: NodeGroup): number {
    if (group === "task" || group === "related" || group === "done" || group === "data" || group === "template") return 340;
    if (group === "source") return 120;
    return -260;
  }

  private fileBoardGap(node: NodeInput): number {
    if (node.group === "source") return 220;
    return node.group === "document" ? 250 : 210;
  }

  private groupLane(group: NodeGroup): number {
    return {
      hub: 0,
      task: -1,
      document: 0,
      source: 0,
      section: 1,
      concept: 2,
      evidence: 3,
      question: 4,
      action: 4,
      related: 5,
      done: 6,
      data: 7,
      template: 8
    }[group];
  }

  private groupColumn(node: NodeInput): number {
    if (node.group === "source") return 0;
    return {
      hub: 0,
      task: -1,
      done: -1,
      document: 1,
      source: 0,
      section: 2,
      concept: 3,
      evidence: 4,
      question: 4,
      action: 4,
      related: 0,
      data: 0,
      template: 5
    }[node.group];
  }

  private colorForGroup(group: NodeGroup): string | undefined {
    return {
      hub: "1",
      task: "3",
      done: "4",
      document: "2",
      source: "1",
      section: "2",
      concept: "5",
      evidence: "4",
      question: "6",
      action: "3",
      related: "5",
      data: "6",
      template: "1"
    }[group];
  }

  private polishGeneratedCanvas(style: ProjectWhiteboardStyle, canvas: CanvasDocument): CanvasDocument {
    const resized: CanvasDocument = {
      nodes: this.resizeExistingCanvasNodes(canvas.nodes),
      edges: canvas.edges.map((edge) => ({ ...edge }))
    };
    if (style === "mind-map" || style === "flow-architecture") {
      return this.normalizeCanvasEdges(resized);
    }
    if (style === "brainstorm") {
      return this.normalizeCanvasEdges(this.layoutRadialCanvas(resized));
    }
    return this.normalizeCanvasEdges(this.layoutSemanticCanvas(style, resized));
  }

  private layoutSemanticCanvas(style: ProjectWhiteboardStyle, canvas: CanvasDocument): CanvasDocument {
    const nodes = canvas.nodes.map((node) => ({ ...node }));
    const hub = nodes.find((node) => node.id === "project-hub") ?? nodes.find((node) => this.canvasNodeGroup(node) === "hub");
    const grouped = new Map<number, CanvasNode[]>();
    for (const node of nodes) {
      const column = this.semanticCanvasColumn(style, node);
      const list = grouped.get(column) ?? [];
      list.push(node);
      grouped.set(column, list);
    }

    const laneGap = 760;
    const verticalGap = 92;
    for (const [column, columnNodes] of grouped.entries()) {
      columnNodes.sort((left, right) => {
        const leftGroup = this.canvasNodeGroup(left);
        const rightGroup = this.canvasNodeGroup(right);
        const order = this.semanticGroupOrder(leftGroup) - this.semanticGroupOrder(rightGroup);
        if (order !== 0) return order;
        return left.y - right.y || left.x - right.x || left.id.localeCompare(right.id);
      });

      const x = column * laneGap;
      if (column === 0 && hub && columnNodes.includes(hub)) {
        hub.x = 0;
        hub.y = 0;
        let cursorY = hub.y + hub.height + 150;
        for (const node of columnNodes) {
          if (node.id === hub.id) continue;
          node.x = x;
          node.y = cursorY;
          cursorY += node.height + verticalGap;
        }
        continue;
      }

      const totalHeight = columnNodes.reduce((sum, node) => sum + node.height, 0) + Math.max(0, columnNodes.length - 1) * verticalGap;
      let cursorY = Math.round(-totalHeight / 2);
      for (const node of columnNodes) {
        node.x = x;
        node.y = cursorY;
        cursorY += node.height + verticalGap;
      }
    }

    return this.resolveCanvasOverlaps({ nodes, edges: canvas.edges.map((edge) => ({ ...edge })) });
  }

  private layoutRadialCanvas(canvas: CanvasDocument): CanvasDocument {
    const nodes = canvas.nodes.map((node) => ({ ...node }));
    const hub = nodes.find((node) => node.id === "project-hub") ?? nodes[0];
    if (!hub) return { nodes, edges: canvas.edges.map((edge) => ({ ...edge })) };
    hub.x = 0;
    hub.y = 0;

    const others = nodes
      .filter((node) => node.id !== hub.id)
      .sort((left, right) => this.semanticGroupOrder(this.canvasNodeGroup(left)) - this.semanticGroupOrder(this.canvasNodeGroup(right)));
    const ringSize = 8;
    for (const [index, node] of others.entries()) {
      const ring = Math.floor(index / ringSize);
      const slot = index % ringSize;
      const count = Math.min(ringSize, others.length - ring * ringSize);
      const angle = -Math.PI / 2 + (Math.PI * 2 * slot) / Math.max(1, count);
      const radiusX = 860 + ring * 520;
      const radiusY = 560 + ring * 360;
      const centerX = hub.x + hub.width / 2 + Math.cos(angle) * radiusX;
      const centerY = hub.y + hub.height / 2 + Math.sin(angle) * radiusY;
      node.x = Math.round(centerX - node.width / 2);
      node.y = Math.round(centerY - node.height / 2);
    }

    return this.resolveCanvasOverlaps({ nodes, edges: canvas.edges.map((edge) => ({ ...edge })) });
  }

  private resolveCanvasOverlaps(canvas: CanvasDocument): CanvasDocument {
    const nodes = canvas.nodes.map((node) => ({ ...node }));
    const ordered = [...nodes].sort((left, right) => left.x - right.x || left.y - right.y || left.id.localeCompare(right.id));
    const gap = 48;
    for (let pass = 0; pass < 6; pass += 1) {
      let moved = false;
      for (let index = 0; index < ordered.length; index += 1) {
        const node = ordered[index];
        for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
          const previous = ordered[previousIndex];
          if (!this.canvasNodesOverlap(node, previous, gap)) continue;
          node.y = previous.y + previous.height + gap;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return { nodes, edges: canvas.edges.map((edge) => ({ ...edge })) };
  }

  private canvasNodesOverlap(left: CanvasNode, right: CanvasNode, gap: number): boolean {
    return left.x < right.x + right.width + gap
      && left.x + left.width + gap > right.x
      && left.y < right.y + right.height + gap
      && left.y + left.height + gap > right.y;
  }

  private normalizeCanvasEdges(canvas: CanvasDocument): CanvasDocument {
    const nodes = canvas.nodes.map((node) => ({ ...node }));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = canvas.edges
      .filter((edge) => nodeById.has(edge.fromNode) && nodeById.has(edge.toNode))
      .map((edge) => {
        const from = nodeById.get(edge.fromNode);
        const to = nodeById.get(edge.toNode);
        if (!from || !to) return { ...edge };
        const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
        const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
        const dx = toCenter.x - fromCenter.x;
        const dy = toCenter.y - fromCenter.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          const fromSide: NonNullable<CanvasEdge["fromSide"]> = dx >= 0 ? "right" : "left";
          const toSide: NonNullable<CanvasEdge["toSide"]> = dx >= 0 ? "left" : "right";
          return {
            ...edge,
            fromSide,
            toSide
          };
        }
        const fromSide: NonNullable<CanvasEdge["fromSide"]> = dy >= 0 ? "bottom" : "top";
        const toSide: NonNullable<CanvasEdge["toSide"]> = dy >= 0 ? "top" : "bottom";
        return {
          ...edge,
          fromSide,
          toSide
        };
      });
    return { nodes, edges };
  }

  private semanticCanvasColumn(style: ProjectWhiteboardStyle, node: CanvasNode): number {
    const group = this.canvasNodeGroup(node);
    if (node.id === "project-hub" || group === "hub") return 0;
    if (style === "file-board") {
      return {
        task: -1,
        done: -1,
        related: -1,
        data: -1,
        template: 4,
        source: 1,
        document: 2,
        section: 3,
        concept: 3,
        evidence: 4,
        question: 4,
        action: 4,
        hub: 0
      }[group];
    }
    if (style === "data-dashboard") {
      return {
        task: 1,
        done: 1,
        related: 1,
        data: 2,
        template: 4,
        source: 3,
        document: 3,
        section: 4,
        concept: 4,
        evidence: 5,
        question: 5,
        action: 5,
        hub: 0
      }[group];
    }
    if (style === "project-review" || style === "planner-journal") {
      return {
        task: 1,
        done: 1,
        related: 1,
        data: 2,
        template: 3,
        source: 4,
        document: 4,
        section: 5,
        concept: 5,
        evidence: 6,
        question: 6,
        action: 6,
        hub: 0
      }[group];
    }
    return {
      task: -1,
      done: -1,
      related: -1,
      data: -1,
      template: 5,
      source: 1,
      document: 1,
      section: 2,
      concept: 2,
      evidence: 3,
      question: 4,
      action: 4,
      hub: 0
    }[group];
  }

  private canvasNodeGroup(node: CanvasNode): NodeGroup {
    if (node.id === "project-hub" || node.id.startsWith("chat-adjustment-") && !/-actions$|-questions$|-context$/.test(node.id)) return "hub";
    if (node.type === "file") return "source";
    if (/^task-|open-task|carryover/i.test(node.id)) return "task";
    if (/^done-|completed/i.test(node.id)) return "done";
    if (/^related-/i.test(node.id)) return "related";
    if (/^data-|heatmap|progress|dashboard/i.test(node.id)) return "data";
    if (/^template-|starter-/i.test(node.id)) return "template";
    if (/document-summary|summary/i.test(node.id)) return "document";
    if (/section|chapter|stage|phase/i.test(node.id)) return "section";
    if (/concept|keyword|topic/i.test(node.id)) return "concept";
    if (/evidence|quote|source/i.test(node.id)) return "evidence";
    if (/question|risk|blocker/i.test(node.id)) return "question";
    if (/action|next|step/i.test(node.id)) return "action";
    return this.nodeGroupFromCanvasColor(node.color);
  }

  private semanticGroupOrder(group: NodeGroup): number {
    return {
      hub: 0,
      document: 1,
      source: 2,
      section: 3,
      concept: 4,
      evidence: 5,
      question: 6,
      action: 7,
      task: 8,
      related: 9,
      done: 10,
      data: 11,
      template: 12
    }[group];
  }

  private buildAdjustmentCanvas(
    sourceCanvas: CanvasDocument,
    input: ProjectWhiteboardAdjustmentInput
  ): { canvas: CanvasDocument; addedNodes: CanvasTextNode[] } {
    const canvas: CanvasDocument = this.normalizeCanvasEdges(this.layoutSemanticCanvas("knowledge-map", {
      nodes: this.resizeExistingCanvasNodes(sourceCanvas.nodes),
      edges: sourceCanvas.edges.map((edge) => ({ ...edge }))
    }));
    const bounds = this.canvasBounds(canvas.nodes);
    const anchorId = canvas.nodes.some((node) => node.id === "project-hub")
      ? "project-hub"
      : canvas.nodes[0]?.id;
    const suffix = this.slugify(input.prompt || "adjust").slice(0, 20) || Date.now().toString();
    const promptItems = this.adjustmentPromptItems(input.prompt);
    const taskItems = input.summary.openTasks.slice(0, 4).map((task) => task.text);
    const documentItems = (input.documents ?? []).slice(0, 3).map((document) => document.title);
    const x = bounds.right + 420;
    const y = Math.max(bounds.top, -180);
    const addedNodes: CanvasTextNode[] = [];

    const hubInput: NodeInput = {
      id: `chat-adjustment-${suffix}`,
      title: "AI 微调指令",
      group: "hub",
      body: [
        `用户要求：${input.prompt.trim() || "补充白板内容"}`,
        `项目：${input.project.name}`,
        `进度：${input.summary.progress}%`,
        "处理方式：生成新版本，不覆盖旧白板。",
        documentItems.length > 0 ? `参考资料：${documentItems.join("、")}` : "参考资料：暂无项目文档"
      ].join("\n")
    };
    const hub = this.toCanvasNode(hubInput, { x, y, ...this.nodeSize(hubInput, 480, 240) }) as CanvasTextNode;
    addedNodes.push(hub);

    const actionInput: NodeInput = {
      id: `chat-adjustment-${suffix}-actions`,
      title: "继续生成",
      group: "action",
      body: (promptItems.length > 0 ? promptItems : taskItems).slice(0, 6).map((item) => `- ${item}`).join("\n") || "- 先补充项目资料，再重新生成内容拆解。"
    };
    const actionSize = this.nodeSize(actionInput, 430, 210);
    const action = this.toCanvasNode(actionInput, { x: x + hub.width + 140, y: y - 10, ...actionSize }) as CanvasTextNode;
    addedNodes.push(action);

    const questionInput: NodeInput = {
      id: `chat-adjustment-${suffix}-questions`,
      title: "待确认微调",
      group: "question",
      body: [
        `- 这次最希望强化：${this.firstPhrase(input.prompt) || "结构、证据或下一步"}`,
        "- 哪些节点需要保留为最终版本？",
        "- 是否继续按这个方向扩展下一版白板？"
      ].join("\n")
    };
    const questionSize = this.nodeSize(questionInput, 430, 210);
    const question = this.toCanvasNode(questionInput, { x: action.x, y: action.y + action.height + 100, ...questionSize }) as CanvasTextNode;
    addedNodes.push(question);

    const contextInput: NodeInput = {
      id: `chat-adjustment-${suffix}-context`,
      title: "项目上下文",
      group: "data",
      body: [
        `待办：${input.summary.openCount}`,
        `已完成：${input.summary.doneCount}`,
        `相关任务：${taskItems.slice(0, 3).join("；") || "暂无"}`,
        `相关文档：${documentItems.join("；") || "暂无"}`
      ].join("\n")
    };
    const context = this.toCanvasNode(contextInput, { x, y: y + hub.height + 110, ...this.nodeSize(contextInput, 480, 200) }) as CanvasTextNode;
    addedNodes.push(context);

    canvas.nodes.push(...addedNodes);
    if (anchorId) {
      canvas.edges.push({
        id: `edge-${anchorId}-${hub.id}`,
        fromNode: anchorId,
        fromSide: "right",
        toNode: hub.id,
        toSide: "left",
        label: "AI 微调"
      });
    }
    canvas.edges.push(
      { id: `edge-${hub.id}-${action.id}`, fromNode: hub.id, fromSide: "right", toNode: action.id, toSide: "left", label: "继续生成" },
      { id: `edge-${action.id}-${question.id}`, fromNode: action.id, fromSide: "bottom", toNode: question.id, toSide: "top", label: "确认" },
      { id: `edge-${hub.id}-${context.id}`, fromNode: hub.id, fromSide: "bottom", toNode: context.id, toSide: "top", label: "上下文" }
    );

    return { canvas: this.normalizeCanvasEdges(this.resolveCanvasOverlaps(canvas)), addedNodes };
  }

  private buildAdjustmentMarkdown(
    input: ProjectWhiteboardAdjustmentInput,
    sourceCanvasPath: string,
    canvasPath: string,
    addedNodes: CanvasTextNode[],
    warnings: string[]
  ): string {
    const lines = [
      "---",
      "type: lifeos-project-whiteboard-adjustment",
      `project_id: ${yamlScalar(input.project.id)}`,
      `project_name: ${yamlScalar(input.project.name)}`,
      `source_canvas: ${yamlScalar(sourceCanvasPath)}`,
      `canvas: ${yamlScalar(canvasPath)}`,
      `generated: ${formatDate()}`,
      "---",
      "",
      `# ${input.project.name} · 白板对话调整`,
      "",
      `来源 Canvas：[[${sourceCanvasPath}]]`,
      `调整版 Canvas：[[${canvasPath}]]`,
      "",
      "## 对话要求",
      "",
      input.prompt.trim() || "补充白板内容。",
      "",
      "## 新增节点",
      "",
      ...addedNodes.map((node) => `- ${node.text.split(/\r?\n/)[0]?.replace(/^#\s*/, "") ?? node.id}`)
    ];
    if (warnings.length > 0) {
      lines.push("", "## 生成说明", "", ...warnings.map((warning) => `- ${warning}`));
    }
    return lines.join("\n").trim() + "\n";
  }

  private adjustmentPromptItems(prompt: string): string[] {
    return this.uniqueStrings(
      prompt
        .split(/[。！？!?；;\n]+/)
        .map((item) => this.cleanPoint(item))
        .filter((item): item is string => Boolean(item))
    ).slice(0, 8);
  }

  private normalizeCanvasDocument(value: unknown): CanvasDocument {
    const candidate = value as Partial<CanvasDocument>;
    if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
      throw new Error("Invalid canvas document");
    }
    return {
      nodes: candidate.nodes.filter((node): node is CanvasNode => {
        if (!node || typeof node !== "object") return false;
        const typed = node as CanvasNode;
        return typeof typed.id === "string" && (typed.type === "text" || typed.type === "file");
      }),
      edges: candidate.edges.filter((edge): edge is CanvasEdge => {
        if (!edge || typeof edge !== "object") return false;
        const typed = edge as CanvasEdge;
        return typeof typed.id === "string" && typeof typed.fromNode === "string" && typeof typed.toNode === "string";
      })
    };
  }

  private resizeExistingCanvasNodes(nodes: CanvasNode[]): CanvasNode[] {
    return nodes.map((node) => {
      if (node.type === "file") {
        return {
          ...node,
          width: Math.max(node.width, 340),
          height: Math.max(node.height, 240)
        };
      }
      const title = this.canvasTextTitle(node.text) || node.id;
      const body = this.canvasTextBody(node.text);
      const source: NodeInput = {
        id: node.id,
        title,
        group: this.nodeGroupFromCanvasColor(node.color),
        body
      };
      const size = this.nodeSize(source, Math.max(node.width, 340), Math.max(node.height, 170));
      return {
        ...node,
        width: Math.max(node.width, size.width),
        height: Math.max(node.height, size.height)
      };
    });
  }

  private canvasTextTitle(text: string): string {
    const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
    return this.cleanInlineText(firstLine.replace(/^#\s*/, ""));
  }

  private canvasTextBody(text: string): string {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim().startsWith("#")) lines.shift();
    return lines.join("\n").trim();
  }

  private nodeGroupFromCanvasColor(color?: string): NodeGroup {
    const groups: Record<string, NodeGroup> = {
      "1": "hub",
      "2": "document",
      "3": "action",
      "4": "evidence",
      "5": "concept",
      "6": "question"
    };
    return groups[color ?? ""] ?? "template";
  }

  private canvasBounds(nodes: CanvasNode[]): CanvasBounds {
    if (nodes.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
    return nodes.reduce(
      (bounds, node) => ({
        left: Math.min(bounds.left, node.x),
        top: Math.min(bounds.top, node.y),
        right: Math.max(bounds.right, node.x + node.width),
        bottom: Math.max(bounds.bottom, node.y + node.height)
      }),
      {
        left: Number.POSITIVE_INFINITY,
        top: Number.POSITIVE_INFINITY,
        right: Number.NEGATIVE_INFINITY,
        bottom: Number.NEGATIVE_INFINITY
      }
    );
  }

  private latestCanvasFile(project: Pick<LifeOSProject, "id">): VaultFileLike | null {
    const files = typeof this.vault().getFiles === "function" ? this.vault().getFiles?.() ?? [] : [];
    const root = `${this.whiteboardsPath(project)}/`;
    return files
      .filter((file) => file.path.startsWith(root) && file.path.endsWith(".canvas"))
      .sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0) || b.path.localeCompare(a.path))[0] ?? null;
  }

  private fileAtPath(path: string): VaultFileLike | null {
    const file = this.vault().getAbstractFileByPath(path);
    return this.isFile(file) ? file : null;
  }

  private normalizeStyle(style: string): ProjectWhiteboardStyle {
    return PROJECT_WHITEBOARD_STYLES.some((item) => item.id === style)
      ? style as ProjectWhiteboardStyle
      : "knowledge-map";
  }

  private rebuildStyleFromAdjustmentPrompt(prompt: string): ProjectWhiteboardStyle | null {
    const text = prompt.trim();
    if (!/(改成|转成|重排|重组|重新|再生成|扩展成|整理成|变成)/u.test(text)) {
      return null;
    }
    if (/头脑风暴|发散|brainstorm/i.test(text)) return "brainstorm";
    if (/读书|论文|文献|拆书|阅读/u.test(text)) return "reading-breakdown";
    if (/复盘|回顾|review/i.test(text)) return "project-review";
    if (/思维导图|脑图|mind/i.test(text)) return "mind-map";
    if (/流程|架构|路线|路径|线路|时间线|依赖|flow|architecture/i.test(text)) return "flow-architecture";
    if (/看板|数据|统计|进度|热力图|dashboard/i.test(text)) return "data-dashboard";
    if (/文件|资料墙|PDF|图片|附件|file/i.test(text)) return "file-board";
    if (/手账|周计划|旅行|照片墙|习惯|planner|journal/i.test(text)) return "planner-journal";
    if (/知识地图|知识图谱|项目地图|地图/u.test(text)) return "knowledge-map";
    if (/重新生成|再生成/u.test(text)) return "knowledge-map";
    return null;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const clean = normalizePath(folderPath);
    if (!clean) return;
    let current = "";
    for (const part of clean.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault().getAbstractFileByPath(current);
      if (this.isFile(existing)) {
        throw new Error(`Cannot create folder "${current}" because a file already exists at that path.`);
      }
      if (existing) continue;
      await this.vault().createFolder(current);
    }
  }

  private uniquePath(folderPath: string, fileName: string): string {
    const cleanName = this.cleanFileName(fileName);
    const extensionIndex = cleanName.lastIndexOf(".");
    const baseName = extensionIndex > 0 ? cleanName.slice(0, extensionIndex) : cleanName;
    const extension = extensionIndex > 0 ? cleanName.slice(extensionIndex) : "";
    for (let index = 1; index < 1000; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const candidate = joinPath(folderPath, `${baseName}${suffix}${extension}`);
      if (!this.vault().getAbstractFileByPath(candidate)) return candidate;
    }
    return joinPath(folderPath, `${baseName}-${Date.now()}${extension}`);
  }

  private slugify(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || `project-whiteboard-${Date.now()}`;
  }

  private cleanFileName(fileName: string): string {
    const clean = fileName.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    return clean || `project-whiteboard-${Date.now()}`;
  }

  private isFile(value: unknown): value is VaultFileLike {
    if (!value || typeof value !== "object") return false;
    const candidate = value as VaultFileLike;
    return typeof candidate.path === "string" && typeof candidate.name === "string" && "extension" in candidate;
  }

  private vault(): ProjectWhiteboardVault {
    return this.app.vault as unknown as ProjectWhiteboardVault;
  }
}

function yamlScalar(value: string): string {
  const clean = value.trim();
  if (/^[A-Za-z0-9_-]+$/.test(clean)) return clean;
  return JSON.stringify(clean);
}
