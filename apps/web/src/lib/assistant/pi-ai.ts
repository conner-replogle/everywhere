// What the app uses of @mariozechner/pi-ai, which vite.config.ts aliases
// here. Its main entry registers every provider (Anthropic, Google, Mistral,
// Bedrock…) and bundling them all fails; the assistant only talks to the
// Worker's OpenAI-compatible endpoint. Types still come from the package.

export { Type } from "typebox";
export type * from "../../../node_modules/@mariozechner/pi-ai/dist/types.js";
export { EventStream, AssistantMessageEventStream } from "../../../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js";
export { parseStreamingJson } from "../../../node_modules/@mariozechner/pi-ai/dist/utils/json-parse.js";
export { validateToolArguments, validateToolCall } from "../../../node_modules/@mariozechner/pi-ai/dist/utils/validation.js";
export { streamSimpleOpenAICompletions as streamSimple } from "@mariozechner/pi-ai/openai-completions";
