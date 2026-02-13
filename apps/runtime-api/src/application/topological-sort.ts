export function topologicalSort(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
): string[] {
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();

  for (const id of nodes) {
    indegree.set(id, 0);
    out.set(id, []);
  }

  for (const edge of edges) {
    out.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [node, degree] of indegree.entries()) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    order.push(current);

    for (const neighbor of out.get(current) ?? []) {
      const next = (indegree.get(neighbor) ?? 0) - 1;
      indegree.set(neighbor, next);
      if (next === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (order.length !== nodes.length) {
    throw new Error("Graph contains a cycle; cannot execute event.");
  }

  return order;
}
