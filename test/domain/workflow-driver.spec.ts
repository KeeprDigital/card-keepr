import { expect, test, vi } from "vitest";
import { workflowDriver } from "../../src/catalogue/shared/workflow-driver";

test("a transient lookup failure does not create a replacement Workflow", async () => {
  const failure = new Error("control plane timeout");
  const create = vi.fn();
  const binding = { get: vi.fn().mockRejectedValue(failure), create } as unknown as Workflow;
  await expect(workflowDriver(binding).ensure("evidence-run", {})).rejects.toBe(failure);
  expect(create).not.toHaveBeenCalled();
});

test("a lost create response reacquires the exact committed instance", async () => {
  const instance = { status: async () => ({ status: "running" }) };
  let exists = false;
  const binding = {
    get: async () => {
      if (!exists) throw new Error("instance not found");
      return instance;
    },
    create: async () => {
      exists = true;
      throw new Error("response lost");
    },
  } as unknown as Workflow;
  await expect(workflowDriver(binding).ensure("evidence-run", {})).resolves.toEqual({
    created: false,
    status: { status: "running" },
  });
});

test("resume errors succeed only when the exact instance is observed resumed", async () => {
  const failure = new Error("resume timeout");
  let status = "paused";
  let responseLost = false;
  const binding = {
    get: async () => ({
      status: async () => ({ status }),
      resume: async () => {
        if (responseLost) status = "running";
        throw failure;
      },
    }),
  } as unknown as Workflow;
  await expect(workflowDriver(binding).resume("evidence-run")).rejects.toBe(failure);
  responseLost = true;
  await expect(workflowDriver(binding).resume("evidence-run")).resolves.toEqual({ status: "running" });
});

test("restart-from rejects a step belonging to a different Workflow before any platform call", async () => {
  const get = vi.fn();
  const driver = workflowDriver({ get } as unknown as Workflow);
  await expect(
    driver.restart("evidence-run", "parent", {
      name: "export, retain, restore, and verify Catalogue D1",
      count: 1,
      type: "do",
    }),
  ).rejects.toThrow("restart target");
  expect(get).not.toHaveBeenCalled();
});

test("restart-from accepts a shared dynamic sleep target and forwards its occurrence", async () => {
  const restart = vi.fn().mockResolvedValue(undefined);
  const binding = { get: async () => ({ restart }) } as unknown as Workflow;
  await workflowDriver(binding).restart("evidence-run", "parent", {
    name: "await collection barrier stage 12",
    count: 2,
    type: "sleep",
  });
  expect(restart).toHaveBeenCalledWith({
    from: {
      name: "await collection barrier stage 12",
      count: 2,
      type: "sleep",
    },
  });
});

test("a failed create followed by an unavailable status does not claim successful dispatch", async () => {
  const failure = new Error("dispatch unavailable");
  const binding = {
    get: async () => ({ status: async () => ({ status: "unknown" }) }),
    create: async () => {
      throw failure;
    },
  } as unknown as Workflow;
  await expect(workflowDriver(binding).ensure("evidence-run", {})).rejects.toBe(failure);
});
