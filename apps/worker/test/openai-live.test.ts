import { expect, test } from "bun:test";
import { liveSessionBody } from "../src/openai-live";

test("a live session uses client delegation and seeds the newest history", () => {
  const made = liveSessionBody({
    sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n",
    instructions: "be the voice",
    input: [
      { role: "user", text: "old" },
      { role: "assistant", text: "older reply" },
      { role: "user", text: "  " },
      { role: "user", text: "newest" },
    ],
    voice: "not-a-voice",
  });
  if ("error" in made) throw new Error(made.error);
  const body = made.body as {
    session: { model: string; delegation: unknown; audio: { output: { voice: string } }; input: { role: string; content: { type: string; text: string }[] }[] };
    transport: { type: string; sdp: string };
  };
  expect(body.session.model).toBe("gpt-live-1");
  expect(body.session.delegation).toEqual({ type: "client" });
  expect(body.session.audio.output.voice).toBe("marin");
  expect(body.session.input.map((m) => [m.role, m.content[0]!.type, m.content[0]!.text])).toEqual([
    ["user", "input_text", "old"],
    ["assistant", "output_text", "older reply"],
    ["user", "input_text", "newest"],
  ]);
  expect(body.transport.type).toBe("webrtc");
});

test("a live session needs an offer", () => {
  expect(liveSessionBody({ sdp: "nope" })).toEqual({ error: "a WebRTC offer is required" });
  expect(liveSessionBody({})).toHaveProperty("error");
});
