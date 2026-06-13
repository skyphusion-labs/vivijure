// Shared types for streaming-response parsers (v0.18.0).
//
// ProviderStreamEvent is the normalized envelope every provider's streaming
// parser yields. The worker layers above (callXaiStream, callAnthropicStream,
// callGeminiStream, callOpenAIStream, callWorkersAIStream, plus runChatStream
// that consumes them) are all written against this shape, so each provider's
// specific wire format (OpenAI-style SSE, Anthropic named-event SSE) gets
// translated to this common type at the parser boundary.
//
// Adding a new field here is a breaking change for the v0.13.0 envelope
// contract in /api/chat/stream; the worker has to forward whatever lands here
// and frontends would need to handle it.

export type ProviderStreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; in_: number | null; out_: number | null };
