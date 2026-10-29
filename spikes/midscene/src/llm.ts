// The text model for the plan, card text and narration: any OpenAI-compatible Chat Completions
// endpoint (DEMO_TEXT_BASE_URL, DEMO_TEXT_API_KEY, DEMO_TEXT_MODEL).
function setting(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function chatJson<T>(system: string, user: string): Promise<T> {
  const response = await fetch(`${setting('DEMO_TEXT_BASE_URL')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${setting('DEMO_TEXT_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: setting('DEMO_TEXT_MODEL'),
      temperature: 0.4,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`text model ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const content: string | null = (await response.json()).choices[0].message.content;
  if (!content) throw new Error('the text model returned no content');
  return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')) as T;
}
