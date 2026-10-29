import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Jira through the Atlassian MCP server that Pi on this host is signed in to. Read-only: only
// `getAccessibleAtlassianResources` and `getJiraIssue` are called. The token is used as Pi
// stored it and never refreshed here: Atlassian rotates refresh tokens, so refreshing would
// sign Pi out. An expired token means using Jira in Pi once, which refreshes it.
const AUTH_PATH = join(homedir(), '.pi/agent/mcp-auth.json');
const SERVER = 'https://mcp.atlassian.com/v1/mcp';

type Entry = { serverUrl: string; tokens: { access_token: string }; tokensExpireAt?: number };

export function piAtlassianLogin(): Entry | undefined {
  if (!existsSync(AUTH_PATH)) return undefined;
  const all: Record<string, Entry> = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  return Object.entries(all).find(([key]) => key.endsWith(`|${SERVER}`))?.[1];
}

export async function jiraIssuesViaMcp(keys: string[]) {
  const login = piAtlassianLogin();
  if (!login) throw new Error('Pi has no Atlassian MCP login on this host');
  if (login.tokensExpireAt && login.tokensExpireAt < Date.now() + 60_000) {
    throw new Error("Pi's Atlassian MCP token has expired: use Jira in Pi once to refresh it, then ask for changes to retry");
  }
  const client = new Client({ name: 'sprint-demo-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(login.serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${login.tokens.access_token}` } },
  }));
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    };
    const sites: { id: string; url: string; scopes: string[] }[] = await call('getAccessibleAtlassianResources', {});
    const site = sites.find((s) => s.scopes.some((x) => x.includes('jira'))) ?? sites[0];
    if (!site) throw new Error('the Atlassian login has no Jira site');
    return await Promise.all(keys.map(async (key) => {
      const issue = await call('getJiraIssue', { cloudId: site.id, issueIdOrKey: key, fields: ['summary', 'description'], responseContentFormat: 'markdown' });
      const fields = issue.fields ?? issue;
      return { key, summary: String(fields.summary ?? ''), description: typeof fields.description === 'string' ? fields.description : JSON.stringify(fields.description ?? '') };
    }));
  } finally {
    await client.close();
  }
}
