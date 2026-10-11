import { describe, expect, it, vi } from "vitest";

import { runCommand } from "./run";
import { runPipeline } from "../core/pipeline";
import { emitAmonEvent } from "../events/event-emitter";

vi.mock("../events/event-emitter", async () => {
  const actual = await vi.importActual<typeof import("../events/event-emitter")>(
    "../events/event-emitter"
  );

  return {
    ...actual,
    emitAmonEvent: vi.fn().mockResolvedValue(undefined),
    newRunId: vi.fn(() => "generated-run-id"),
  };
});

vi.mock("../core/pipeline", () => ({
  runPipeline: vi.fn().mockResolvedValue(0),
}));

vi.mock("../llm/router", () => ({
  listTaskTypes: vi.fn(() => ["research_task"]),
}));

describe("runCommand", () => {
  it("reuses the CLI runId for run events and the pipeline", async () => {
    const exitCode = await runCommand(
      {
        positional: ["First Heartbeat"],
        flags: {
          task: "BF-JARVIS-SMOKE-001",
          type: "research_task",
          repo: "C:\\Users\\nsand\\bracketflow",
        },
      },
      { runId: "fixed-run-id" }
    );

    expect(exitCode).toBe(0);
    expect(emitAmonEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "fixed-run-id",
        taskId: "BF-JARVIS-SMOKE-001",
        type: "run.started",
      })
    );
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "fixed-run-id",
        taskId: "BF-JARVIS-SMOKE-001",
        taskType: "research_task",
      })
    );
  });
});
