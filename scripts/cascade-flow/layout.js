import { graphlib, layout } from "./vendor/dagre-3.1.1.esm.js";

export const CARD = { width: 208, height: 96 };
const RANK_GAP = 88;

function appendPoint(points, point) {
  const previous = points.at(-1), before = points.at(-2);
  if (previous?.x === point.x && previous.y === point.y) return;
  if (before && (before.x === previous.x && previous.x === point.x || before.y === previous.y && previous.y === point.y)) points.pop();
  points.push(point);
}

export function edgePath(points) {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y);
    const radius = Math.min(6, before / 2, after / 2);
    path += ` L ${b.x + (a.x - b.x) * radius / before} ${b.y + (a.y - b.y) * radius / before}`;
    path += ` Q ${b.x} ${b.y} ${b.x + (c.x - b.x) * radius / after} ${b.y + (c.y - b.y) * radius / after}`;
  }
  return `${path} L ${points.at(-1).x} ${points.at(-1).y}`;
}

// Numeric internal keys keep remote task IDs out of the layout library's keys.
export function layoutGraph(nodes, dimensions = new Map()) {
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const keys = new Map(nodes.map((node, index) => [node.id, String(index)]));
  if (keys.size !== nodes.length) throw new Error("任务标识重复，无法绘制依赖图。");
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 36, ranksep: RANK_GAP, edgesep: 18, marginx: 28, marginy: 28 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    const size = dimensions.get(node.id) || CARD;
    if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error("任务卡片尺寸无效，无法绘制依赖图。");
    }
    graph.setNode(keys.get(node.id), { width: size.width, height: size.height });
  }
  const edges = [];
  for (const node of nodes) {
    const seen = new Set();
    for (const dependency of node.dependencies) {
      if (!keys.has(dependency.id) || dependency.id === node.id || seen.has(dependency.id)) {
        throw new Error("依赖端点缺失或重复，无法绘制依赖图。");
      }
      seen.add(dependency.id);
      graph.setEdge(keys.get(dependency.id), keys.get(node.id));
      edges.push({ from: dependency.id, to: node.id });
    }
  }
  if (!graphlib.alg.isAcyclic(graph)) throw new Error("任务依赖存在循环，无法绘制依赖图。");
  layout(graph);
  const placed = nodes.map(node => ({ id: node.id, ...graph.node(keys.get(node.id)) }));
  const byId = new Map(placed.map(node => [node.id, node]));
  const routes = edges.map(edge => ({ ...edge, points: graph.edge(keys.get(edge.from), keys.get(edge.to)).points }));
  const lanes = new Map();
  for (const edge of routes) {
    for (let i = 1; i < edge.points.length - 1; i += 2) {
      const x = edge.points[i].x;
      if (!lanes.has(x)) lanes.set(x, new Set());
      lanes.get(x).add(edge.from);
    }
  }
  for (const [x, sources] of lanes) lanes.set(x, [...sources].sort((a, b) => byId.get(a).y - byId.get(b).y));
  for (const edge of routes) {
    const source = byId.get(edge.from), target = byId.get(edge.to);
    const points = [{ x: source.x + source.width / 2, y: source.y }];
    // Dagre's dummy ranks leave a clear passage for edges that skip task columns.
    // Bend only in the gaps; different source tasks use distinct vertical lanes.
    for (let i = 1; i < edge.points.length - 1; i += 2) {
      const gap = edge.points[i].x, sources = lanes.get(gap);
      const x = gap + ((sources.indexOf(edge.from) + 1) / (sources.length + 1) - .5) * (RANK_GAP - 24);
      const y = i === edge.points.length - 2 ? target.y : edge.points[i + 1].y;
      appendPoint(points, { x, y: points.at(-1).y });
      appendPoint(points, { x, y });
    }
    appendPoint(points, { x: target.x - target.width / 2, y: target.y });
    edge.points = points;
  }
  return {
    width: graph.graph().width, height: graph.graph().height,
    nodes: placed, edges: routes,
  };
}
