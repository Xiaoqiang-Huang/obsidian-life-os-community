import type { AiWorkspaceNodeIndex } from "./types";

export interface AiWorkspaceGraphNode {
  node: AiWorkspaceNodeIndex;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AiWorkspaceGraphLayout {
  nodes: AiWorkspaceGraphNode[];
  byId: Map<string, AiWorkspaceGraphNode>;
  width: number;
  height: number;
  rowStride: number;
}

const NODE_WIDTH = 304;
const NODE_HEIGHT = 98;
const ROW_STRIDE = 132;
const ROLE_LANES: Record<AiWorkspaceNodeIndex["role"], number> = {
  user: 56,
  assistant: 418,
  tool: 780
};

export function buildConversationGraphLayout(nodes: AiWorkspaceNodeIndex[]): AiWorkspaceGraphLayout {
  const graphNodes = nodes.map((node, index) => ({
    node,
    x: ROLE_LANES[node.role],
    y: 62 + index * ROW_STRIDE,
    width: NODE_WIDTH,
    height: NODE_HEIGHT
  }));
  return {
    nodes: graphNodes,
    byId: new Map(graphNodes.map((item) => [item.node.id, item])),
    width: 1148,
    height: Math.max(560, 142 + graphNodes.length * ROW_STRIDE),
    rowStride: ROW_STRIDE
  };
}

export function graphNodeAtPoint(
  layout: AiWorkspaceGraphLayout,
  x: number,
  y: number
): AiWorkspaceGraphNode | null {
  const index = Math.floor((y - 62) / layout.rowStride);
  for (let offset = -1; offset <= 1; offset += 1) {
    const item = layout.nodes[index + offset];
    if (!item) continue;
    if (x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) {
      return item;
    }
  }
  return null;
}

export function graphVisibleRange(
  layout: AiWorkspaceGraphLayout,
  worldTop: number,
  worldBottom: number
): { start: number; end: number } {
  return {
    start: Math.max(0, Math.floor((worldTop - 62) / layout.rowStride) - 2),
    end: Math.min(layout.nodes.length, Math.ceil((worldBottom - 62) / layout.rowStride) + 3)
  };
}
