import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectThreadRelationshipShells } from "./entities";

type Projection = Parameters<typeof selectThreadRelationshipShells>[1];

const shell = (id: string, parentThreadId: string | null = null) =>
  ({
    id,
    forkedFrom: null,
    lineage: { parentThreadId, relationshipToParent: parentThreadId === null ? null : "fork" },
  }) as unknown as OrchestrationV2ThreadShell;

const threadId = "current" as OrchestrationV2ThreadShell["id"];

describe("selectThreadRelationshipShells", () => {
  it("keeps the thread, its parent, its children and the threads its projection names", () => {
    const threads = [
      shell("current", "parent"),
      shell("parent"),
      shell("child", "current"),
      shell("subagent-child"),
      shell("workflow-member"),
      shell("transfer-source"),
      shell("unrelated"),
      shell("grandchild", "child"),
    ];
    const projection = {
      thread: threads[0],
      subagents: [
        {
          childThreadId: "subagent-child",
          workflow: { agents: [{ childThreadId: "workflow-member" }, {}] },
        },
        { childThreadId: null },
      ],
      contextTransfers: [{ sourceThreadId: "transfer-source", targetThreadId: "current" }],
    } as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "subagents" | "contextTransfers"
    >;

    expect(
      selectThreadRelationshipShells(threadId, projection, threads).map((thread) => thread.id),
    ).toEqual([
      "current",
      "parent",
      "child",
      "subagent-child",
      "workflow-member",
      "transfer-source",
    ]);
  });

  it("finds the parent from the shell before the projection loads", () => {
    const threads = [shell("current", "parent"), shell("parent"), shell("unrelated")];
    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current", "parent"]);
  });
  it("keeps delegated grandchildren and deeper, but not forks of a child", () => {
    const delegated = (id: string, parentThreadId: string) =>
      ({
        id,
        forkedFrom: null,
        lineage: { parentThreadId, relationshipToParent: "subagent" },
      }) as unknown as OrchestrationV2ThreadShell;
    const threads = [
      shell("current"),
      delegated("child", "current"),
      delegated("grandchild", "child"),
      delegated("great-grandchild", "grandchild"),
      shell("fork-of-child", "child"),
      shell("unrelated-root"),
    ];

    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current", "child", "grandchild", "great-grandchild"]);
  });
});
