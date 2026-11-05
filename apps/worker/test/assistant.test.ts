import { expect, test } from "bun:test";
import { workersAiMessage } from "../src/workers-ai";

test("messages reach Workers AI with string content and no developer role", () => {
  expect(workersAiMessage({ role: "developer", content: "be brief" })).toEqual({ role: "system", content: "be brief" });
  expect(
    workersAiMessage({ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }] }),
  ).toEqual({ role: "user", content: "ab" });
  const call = { id: "c1", type: "function", function: { name: "t", arguments: "{}" } };
  expect(workersAiMessage({ role: "assistant", content: null, reasoning_content: "We need to…", tool_calls: [call] })).toEqual({
    role: "assistant",
    content: "",
    tool_calls: [call],
  });
});
