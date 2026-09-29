import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionEvent, ExtensionHandler, ExtensionUIContext, ModelRegistry, ToolDefinition, ExecResult } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { Pane } from "./runtime.ts";

type EventName = ExtensionEvent["type"];
type EventMap = { [E in ExtensionEvent as E["type"]]: E };
export type EventOf<K extends EventName> = EventMap[K];
type Stored = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

export function fake<T extends object>(members: Partial<T>): T {
  return new Proxy(members, {
    get(target, key, receiver) {
      if (typeof key === "string" && !Reflect.has(target, key)) throw new Error(`fake: ${String(key)} is not implemented by this fixture`);
      return Reflect.get(target, key, receiver);
    },
  }) as T;
}
export const fakeApi = (members: Partial<ExtensionAPI>) => fake<ExtensionAPI>(members);
export const fakeContext = (members: Partial<ExtensionContext>) => fake<ExtensionContext>(members);
export const fakeUi = (members: Partial<ExtensionUIContext>) => fake<ExtensionUIContext>(members);
export const fakeRegistry = (members: Partial<ModelRegistry>) => fake<ModelRegistry>(members);
export const fakeSessions = (members: Partial<ExtensionContext["sessionManager"]>) => fake<ExtensionContext["sessionManager"]>(members);
export const fakeModel = (provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> => ({ id, name: id, api: "openai-completions",
  provider, baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0, ...extra });

export const fakeModelRegistry = ({ auth }: { auth: boolean }): ModelRegistry => fakeRegistry({
  find: (provider, id) => fakeModel(provider, id),
  hasConfiguredAuth: () => auth,
  getProviderAuthStatus: () => ({ configured: auth }),
});
export const beforeAgentStart = ({ cwd, prompt }: { cwd: string; prompt: string }): EventOf<"before_agent_start"> => ({
  type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: { cwd, selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [] },
}) satisfies ExtensionEvent;
export const completedSettle = (): EventOf<"agent_before_settle"> => ({
  type: "agent_before_settle", outcome: "completed", entries: [], continue: false,
  context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
}) satisfies ExtensionEvent;
export const herdrArgs = (argv: readonly string[]): string[] => argv.slice(argv.indexOf("herdr") + 1);
export const execOk = (stdout = ""): ExecResult => ({ code: 0, killed: false, stderr: "", stdout });
export const execFailure = (stderr: string, { killed = false }: { killed?: boolean } = {}): ExecResult => ({ code: 1, killed, stderr, stdout: "" });
export const herdrResult = (result: unknown): ExecResult => execOk(JSON.stringify({ result }));
export const fakePane = (id = "w1:p1"): Pane => ({ pane_id: id, workspace_id: "w1", terminal_id: `term-${id}`, tab_id: `tab-${id}` });

const is = <K extends EventName>(event: ExtensionEvent, name: K): event is EventOf<K> => event.type === name;
export function hookRegistry() {
  const handlers = new Map<EventName, Stored[]>();
  return {
    on<K extends EventName>(name: K, handler: ExtensionHandler<EventOf<K>, unknown>): () => void {
      const stored: Stored = (event, ctx) => is(event, name) ? handler(event, ctx) : undefined;
      handlers.set(name, [...(handlers.get(name) ?? []), stored]);
      return () => {};
    },
    emitConcurrent(event: ExtensionEvent, ctx: ExtensionContext): Promise<unknown[]> {
      return Promise.all((handlers.get(event.type) ?? []).map(handler => handler(event, ctx)));
    },
    async emit(event: ExtensionEvent, ctx: ExtensionContext): Promise<unknown[]> {
      const results = [];
      for (const handler of handlers.get(event.type) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}

type ParamsOf<P extends TSchema> = Parameters<ToolDefinition<P>["execute"]>[1];
const conforms = <P extends TSchema>(schema: P, value: unknown): value is ParamsOf<P> => Check(schema, value);
export type FakeTool = {
  name: string; description: string; parameters: TSchema;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<AgentToolResult<unknown>>;
};
export function toolRegistry() {
  const tools = new Map<string, FakeTool>();
  return {
    register<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): void {
      tools.set(tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters,
        execute: (id, params, signal, onUpdate, ctx) => {
          if (!conforms(tool.parameters, params)) throw new Error(`fake: invalid ${tool.name} parameters`);
          return tool.execute(id, params, signal, onUpdate, ctx);
        } });
    },
    get(name: string): FakeTool {
      const tool = tools.get(name);
      if (!tool) throw new Error(`fake: tool ${name} is not registered`);
      return tool;
    },
    keys: () => tools.keys(),
    get size() { return tools.size; },
    has: (name: string) => tools.has(name),
  };
}
export function toolText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("fake: tool result has no leading text content");
  return first.text;
}

export function fixtureEnvironment(overrides: NodeJS.ProcessEnv, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) if (!key.startsWith("DS_HERDR_")) env[key] = value;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function replaceEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}

export function installFixtureEnvironment(overrides: NodeJS.ProcessEnv): void {
  replaceEnvironment(fixtureEnvironment(overrides));
}

export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}
