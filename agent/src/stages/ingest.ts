import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JIRA, ROOT } from '../config.ts';
import type { Ticket } from '../doc.ts';
import { jiraIssuesViaMcp, piAtlassianLogin } from './jira-mcp.ts';

// A fixture file wins (fixtures/jira/<KEY>.json), then the Jira REST API when JIRA_BASE_URL and a
// token are set, then the Atlassian MCP server Pi is signed in to on this host.
export async function fetchTickets(keys: string[]): Promise<Ticket[]> {
  const fixtures = keys.filter((k) => existsSync(join(ROOT, 'fixtures/jira', `${k}.json`)));
  const rest = keys.filter((k) => !fixtures.includes(k));
  let fetched: Ticket[] = [];
  if (rest.length && JIRA.baseUrl && JIRA.token) fetched = await Promise.all(rest.map(fromJira));
  else if (rest.length && piAtlassianLogin()) {
    fetched = (await jiraIssuesViaMcp(rest)).map((t) => ({ ...t, acceptance: acceptanceCriteria(t.description) }));
  } else if (rest.length) throw new Error(`no way to read ${rest.join(', ')}: no Jira API token, no Atlassian MCP login in Pi, no fixture`);
  return keys.map((k) => (fixtures.includes(k) ? fromFixture(k) : fetched.find((t) => t.key === k)!));
}

function fromFixture(key: string): Ticket {
  const path = join(ROOT, 'fixtures/jira', `${key}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function fromJira(key: string): Promise<Ticket> {
  const auth = JIRA.email ? `Basic ${Buffer.from(`${JIRA.email}:${JIRA.token}`).toString('base64')}` : `Bearer ${JIRA.token}`;
  const response = await fetch(`${JIRA.baseUrl!.replace(/\/$/, '')}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description`, {
    headers: { authorization: auth, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`ticket ${key}: Jira answered ${response.status}`);
  const issue = await response.json();
  const description: string = issue.fields.description ?? '';
  return { key, summary: issue.fields.summary, description, acceptance: acceptanceCriteria(description) };
}

// Lines under an "Acceptance criteria" heading, as bullet items.
function acceptanceCriteria(text: string): string[] {
  const at = text.search(/acceptance criteria/i);
  if (at < 0) return [];
  return text
    .slice(at)
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/^\s*(?:[*#-]+|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20);
}
