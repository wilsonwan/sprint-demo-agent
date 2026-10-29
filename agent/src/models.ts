import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import type { Model, Api, Models } from '@earendil-works/pi-ai';
import { CREDENTIALS_OVERLAY, MODEL, PI_AUTH_PATHS } from './config.ts';

const REFRESHABLE = new Set(['github-copilot']);

// Reads the host's Pi logins (auth.json has pi-ai's credential shape) and never writes them:
// refreshed tokens (Copilot's short-lived access token) go to an overlay in the data dir.
class PiAuthStore implements CredentialStore {
  #overlay: Record<string, Credential> = existsSync(CREDENTIALS_OVERLAY) ? JSON.parse(readFileSync(CREDENTIALS_OVERLAY, 'utf8')) : {};
  #base(): Record<string, Credential> {
    const path = PI_AUTH_PATHS.find((p) => existsSync(p));
    return path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }
  #all() {
    return { ...this.#base(), ...this.#overlay };
  }
  async read(providerId: string) {
    return this.#all()[providerId];
  }
  async list(): Promise<CredentialInfo[]> {
    return Object.entries(this.#all()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    const current = this.#all()[providerId];
    // Refreshing an OAuth login rotates its refresh token for most providers, which would sign
    // Pi out. Copilot's is safe: its GitHub token stays, only the short-lived Copilot token is new.
    if (current?.type === 'oauth' && !REFRESHABLE.has(providerId)) {
      throw new Error(`Pi's ${providerId} login has expired. The agent won't refresh it (that would sign Pi out); run Pi once to refresh it, or use an API key`);
    }
    const next = await fn(current);
    if (next) this.#overlay[providerId] = next;
    else delete this.#overlay[providerId];
    writeFileSync(CREDENTIALS_OVERLAY, JSON.stringify(this.#overlay, null, 2), { mode: 0o600 });
    return next;
  }
  async delete(providerId: string) {
    delete this.#overlay[providerId];
    writeFileSync(CREDENTIALS_OVERLAY, JSON.stringify(this.#overlay, null, 2), { mode: 0o600 });
  }
}

export function openModels(): MutableModels {
  // Every provider pi-ai knows; logins come from Pi's auth.json or the provider's usual env var.
  return builtinModels({ credentials: new PiAuthStore() });
}

export function demoModel(models: Models, provider = MODEL.provider, id = MODEL.id): Model<Api> {
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`unknown model ${provider}/${id}`);
  return model;
}

// Midscene talks to the vision model with the OpenAI client (Chat Completions or Responses).
const MIDSCENE_APIS = ['openai-completions', 'openai-responses'];

// Text completion that must answer with one JSON object.
export async function completeJson<T>(models: Models, system: string, user: string, sessionId: string): Promise<T> {
  const model = demoModel(models);
  const answer = await models.completeSimple(
    model,
    { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] },
    { sessionId, maxTokens: 8000, reasoning: 'low' },
  );
  if (answer.stopReason === 'error') throw new Error(`model error: ${answer.errorMessage ?? 'unknown'}`);
  const text = answer.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!json) throw new Error(`model answered without JSON: ${text.slice(0, 300)}`);
  return JSON.parse(json) as T;
}

// Midscene's model settings for the same model, as environment for the recorder process.
// pi-ai resolves the base URL, key and static headers (and refreshes Copilot's token).
export async function midsceneEnv(models: Models): Promise<Record<string, string>> {
  const model = demoModel(models, MODEL.visionProvider, MODEL.visionId);
  if (!MIDSCENE_APIS.includes(model.api)) {
    throw new Error(`${MODEL.visionProvider}/${model.id} speaks ${model.api}; rehearsals need a vision model on the OpenAI API (DEMO_VISION_PROVIDER, DEMO_VISION_MODEL)`);
  }
  const resolved = await models.getAuth(model);
  if (!resolved?.auth.apiKey) throw new Error(`no login for ${MODEL.visionProvider} on this host (Pi auth.json or env)`);
  const headers: Record<string, string> = { ...(resolved.auth.headers as Record<string, string> | undefined) };
  // Per-request headers pi-ai adds for Copilot; Midscene always sends a screenshot.
  if (MODEL.visionProvider === 'github-copilot') Object.assign(headers, { 'Copilot-Vision-Request': 'true', 'X-Initiator': 'user', 'Openai-Intent': 'conversation-edits' });
  const family = model.id.startsWith('gpt-') ? 'gpt-5' : model.id.startsWith('gemini-') ? 'gemini' : 'qwen2.5-vl';
  const protocol = model.api === 'openai-responses' ? 'openai-responses' : undefined;
  return {
    MIDSCENE_MODEL_BASE_URL: resolved.auth.baseUrl ?? model.baseUrl,
    MIDSCENE_MODEL_API_KEY: resolved.auth.apiKey,
    MIDSCENE_MODEL_NAME: model.id,
    MIDSCENE_MODEL_FAMILY: process.env.MIDSCENE_MODEL_FAMILY ?? family,
    MIDSCENE_MODEL_TIMEOUT: '60000', // a stalled request fails in a minute, not three
    ...(protocol && { MIDSCENE_MODEL_PROTOCOL: protocol }),
    MIDSCENE_MODEL_INIT_CONFIG_JSON: JSON.stringify({ defaultHeaders: headers }),
  };
}
