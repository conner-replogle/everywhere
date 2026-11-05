import { expect, test } from "bun:test";
import { SLOW_SECONDS, stepDetail, stepText, turnStatus } from "../src/lib/assistant/steps";

test("steps say what the agent did, with thread names", () => {
  const name = (ref: string) => (ref === "k3flaky001" ? "fix flaky test" : ref);
  expect(stepText("read_thread", { thread: "k3flaky001" }, name)).toBe("Read fix flaky test");
  expect(stepText("read_thread", { thread: "k3flaky001", page: 2 }, name)).toBe("Read fix flaky test (page 2)");
  expect(stepText("send_to_thread", { thread: "api migration", text: "go" }, name)).toBe("Sent to api migration");
  expect(stepText("start_thread", { project: "vet-chart", prompt: "x" })).toBe("Started a thread in vet-chart");
  expect(stepText("search_threads", { query: "booking" })).toBe('Searched threads for "booking"');
  expect(stepDetail("send_to_thread", { text: " Run the tests " })).toBe("Run the tests");
  expect(stepDetail("read_thread", { thread: "x" })).toBeUndefined();
});

test("the status says where the turn is, and when the model is slow", () => {
  expect(turnStatus(null, false, 0)).toBeNull();
  expect(turnStatus(null, true, 0)?.label).toBe("Starting…");
  expect(turnStatus({ text: "", phase: "waiting", model: "GLM 5.3 Flash" }, true, 1)?.label).toBe("Waiting on GLM 5.3 Flash…");
  const slow = turnStatus({ text: "", phase: "waiting", model: "GLM 5.3 Flash" }, true, SLOW_SECONDS + 3);
  expect(slow).toEqual({ label: `Still waiting on GLM 5.3 Flash (Workers AI)… · ${SLOW_SECONDS + 3}s`, slow: true });
  expect(turnStatus({ text: "", phase: "thinking" }, true, 4)?.label).toBe("Thinking… · 4s");
  expect(turnStatus({ text: "", phase: "tool", activity: "Reading a thread fix flaky test" }, true, 0)?.label).toBe("Reading a thread fix flaky test…");
  // The reply streaming shows itself.
  expect(turnStatus({ text: "Two threads", phase: "writing" }, true, 3)).toBeNull();
});
