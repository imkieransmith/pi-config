import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AuthResult, type Model, type Provider } from "@earendil-works/pi-ai";

type Respond = (model: Model<Api>, context: Parameters<Provider["streamSimple"]>[1], options: Parameters<Provider["streamSimple"]>[2]) => AssistantMessage | Promise<AssistantMessage>;

/** Real Pi request preparation with an in-memory, network-free provider. */
export async function createModelFixture(model: Model<Api>, respond: Respond, resolveAuth: () => Promise<AuthResult | undefined>) {
  const runtime = await ModelRuntime.create({
    credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} },
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  const stream: Provider["streamSimple"] = (selected, context, options) => {
    const response = respond(selected, context, options);
    const events = createAssistantMessageEventStream();
    const finish = (message: AssistantMessage) => {
      if (message.stopReason === "pending") throw new Error("Pending responses are not supported by this fixture");
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        events.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        events.push({ type: "done", reason: message.stopReason, message });
      }
      events.end();
    };
    Promise.resolve(response).then(finish, error => finish({
      role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: [],
      stopReason: error?.name === "AbortError" ? "aborted" : "error", errorMessage: String(error?.message ?? error),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }));
    return events;
  };
  runtime.registerNativeProvider({
    id: model.provider, name: "Synthetic provider", getModels: () => [model],
    auth: { apiKey: { name: "Synthetic auth", check: async () => ({ type: "api_key" }), resolve: resolveAuth } },
    stream: stream as Provider["stream"], streamSimple: stream,
  });
  return new ModelRegistry(runtime);
}
