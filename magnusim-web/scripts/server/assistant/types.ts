/**
 * The Assistant's provider-neutral types (Foundation spec 5.1). Each adapter maps its
 * provider's wire format to and from these; the loop, the registry and the routes
 * never see a provider's own shapes.
 */
export type ProviderId = 'anthropic' | 'openai' | 'openai_compatible';
export type Effort = 'default' | 'low' | 'medium' | 'high';
export type Risk = 'read' | 'edit' | 'compute' | 'destructive';

export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string; width: number; height: number }
export interface ToolResultPart { type: 'tool_result'; callId: string; isError: boolean; text: string /* JSON */; images: ImagePart[] }
export type UserPart = TextPart | ImagePart | ToolResultPart;
export interface ToolCallPart { type: 'tool_call'; callId: string; name: string; input: Record<string, unknown>; inputError?: string }
export type AssistantPart = TextPart | { type: 'thinking'; text: string } | ToolCallPart;
export interface UserMessage { role: 'user'; parts: UserPart[] }
export interface AssistantMessage {
  role: 'assistant';
  parts: AssistantPart[];
  /** Exactly what the provider returned, replayed byte for byte (thinking signatures, fallback blocks, reasoning items with encrypted_content, function_call items). */
  raw: { provider: ProviderId; model: string; payload: unknown };
}
export type Message = UserMessage | AssistantMessage;

export interface JsonSchemaObject { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false; description?: string }
export interface ProviderTool { name: string; description: string; schema: JsonSchemaObject }
export interface ProviderRequest {
  model: string;
  system: Array<{ text: string; cache: boolean }>;   // [host prompt, frozen workspace guide?]
  messages: readonly Message[];
  tools: readonly ProviderTool[];
  maxOutputTokens: number;
  effort: Effort;
}
export interface Usage { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number; reasoning: number; complete: boolean }
/** One billed attempt (a refusal fallback adds attempts on other models). */
export interface Attempt { model: string; usage: Usage; fallback: boolean }
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'context' | 'other';
export type StreamEvent =
  | { kind: 'text'; text: string } | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; callId: string; name: string } | { kind: 'usage'; usage: Usage }
  | { kind: 'fallback'; from: string; to: string };
export interface ProviderResult {
  message: AssistantMessage; stop: StopReason; usage: Usage; attempts: Attempt[]; servedBy: string; refusal?: { category: string | null; explanation: string };
  /** A local model wrote a tool call as text instead of calling the tool (its chat template doesn't do tools). */
  toolCallAsText?: boolean;
}
export type ProviderErrorCode = 'no_key' | 'deps_missing' | 'auth' | 'model' | 'rate_limit' | 'overloaded' | 'server'
  | 'bad_request' | 'context' | 'unreachable' | 'timeout' | 'aborted' | 'blocked_origin' | 'other';
export class ProviderError extends Error {
  code: ProviderErrorCode; status: number | null; retryAfterS: number | null; streamed: boolean;
  constructor(code: ProviderErrorCode, message: string, o: { status?: number | null; retryAfterS?: number | null; streamed?: boolean } = {}) {
    super(message); this.code = code; this.status = o.status ?? null; this.retryAfterS = o.retryAfterS ?? null; this.streamed = !!o.streamed;
  }
}
export interface ModelInfo { id: string; label: string; priced: boolean }
export interface ProviderAdapter {
  readonly id: ProviderId; readonly label: string; readonly cloud: boolean; readonly destination: string;
  /** Models this request may be served by besides `model` (refusal fallback); [] when none. */
  fallbackTargets(model: string): string[];
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  send(req: ProviderRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ProviderResult>;
}
