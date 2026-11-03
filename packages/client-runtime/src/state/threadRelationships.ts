import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "transfer";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  const selectedThread = input.projection?.thread;
  const lineageThreads =
    selectedThread !== undefined && !threadsById.has(selectedThread.id)
      ? [...threads, { ...selectedThread, activityRunStatus: null, status: null }]
      : threads;
  for (const thread of lineageThreads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: thread.activityRunStatus ?? thread.status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status:
          child?.activityRunStatus ??
          (child?.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status)
            ? child.status
            : subagent.status),
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web pins the parent and distinct merge-back target before newest-created-first ordering.
 * Mobile does not share this exception; do not reuse it as the canonical relationship order.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}

export type ThreadSubtaskState =
  | "needs_input"
  | "working"
  | "waiting_on_children"
  | "failed"
  | "done";

export interface ThreadSubtaskCounts {
  readonly needsInput: number;
  readonly working: number;
  readonly waitingOnChildren: number;
  readonly failed: number;
  readonly done: number;
}

const ACTIVE_SUBTASK_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function compareNewestFirst(
  graph: ThreadRelationshipGraph,
  left: ThreadId,
  right: ThreadId,
): number {
  const leftCreatedAt = threadCreatedAtMillis(graph.nodes.get(left));
  const rightCreatedAt = threadCreatedAtMillis(graph.nodes.get(right));
  if (leftCreatedAt !== rightCreatedAt) {
    if (leftCreatedAt === null) return 1;
    if (rightCreatedAt === null) return -1;
    return rightCreatedAt - leftCreatedAt;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every descendant reached through subagent edges, depth first. Siblings run newest first,
 * matching the direct rows. A cycle or a repeated node is visited once.
 */
export function descendantThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const childRows = (parentId: ThreadId, depth: number): ThreadRelationshipWalkRow[] =>
    graph.edges
      .filter((edge) => edge.kind === "subagent" && edge.sourceThreadId === parentId)
      .sort((left, right) => compareNewestFirst(graph, left.targetThreadId, right.targetThreadId))
      .map((edge) => ({
        threadId: edge.targetThreadId,
        fromThreadId: parentId,
        depth,
        edge,
      }));

  const visited = new Set<ThreadId>([threadId]);
  const rows: ThreadRelationshipWalkRow[] = [];
  const pending = childRows(threadId, 1).reverse();
  while (pending.length > 0) {
    const row = pending.pop()!;
    if (visited.has(row.threadId)) continue;
    visited.add(row.threadId);
    rows.push(row);
    pending.push(...childRows(row.threadId, row.depth + 1).reverse());
  }
  return rows;
}

function ownSubtaskState(node: ThreadRelationshipNode | undefined): ThreadSubtaskState {
  const thread = node?.thread;
  if (!thread) return "done";
  if (thread.pendingRuntimeRequest != null) return "needs_input";
  const status: string = thread.activityRunStatus ?? thread.status;
  if (ACTIVE_SUBTASK_STATUSES.has(status)) return "working";
  if (status === "failed" || status === "error") return "failed";
  return "done";
}

function isSubtaskStateActive(state: ThreadSubtaskState | undefined): boolean {
  return state === "needs_input" || state === "working" || state === "waiting_on_children";
}

/**
 * The state of each row in a depth-first list from `descendantThreadRelationships`. A row
 * whose own run has ended still reads as waiting while any descendant is active.
 */
export function subtaskStatesByThreadId(
  graph: ThreadRelationshipGraph,
  rows: ReadonlyArray<ThreadRelationshipWalkRow>,
): ReadonlyMap<ThreadId, ThreadSubtaskState> {
  const states = new Map<ThreadId, ThreadSubtaskState>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const own = ownSubtaskState(graph.nodes.get(row.threadId));
    let descendantActive = false;
    for (let next = index + 1; next < rows.length && rows[next]!.depth > row.depth; next += 1) {
      if (isSubtaskStateActive(states.get(rows[next]!.threadId))) {
        descendantActive = true;
        break;
      }
    }
    const ownEnded = own === "done" || own === "failed";
    states.set(row.threadId, ownEnded && descendantActive ? "waiting_on_children" : own);
  }
  return states;
}

export function countThreadSubtaskStates(
  states: Iterable<ThreadSubtaskState>,
): ThreadSubtaskCounts {
  const counts = { needsInput: 0, working: 0, waitingOnChildren: 0, failed: 0, done: 0 };
  for (const state of states) {
    if (state === "needs_input") counts.needsInput += 1;
    else if (state === "working") counts.working += 1;
    else if (state === "waiting_on_children") counts.waitingOnChildren += 1;
    else if (state === "failed") counts.failed += 1;
    else counts.done += 1;
  }
  return counts;
}
