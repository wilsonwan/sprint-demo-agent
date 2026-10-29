import { BLOCKED_HOSTS, ROOT } from './config.ts';

// Refuses production: an app URL on a blocked host (DEMO_BLOCKED_HOSTS).
export function checkTarget(appUrl: string) {
  let host = '';
  try {
    host = new URL(appUrl.replace(/\$\{\w+\}/g, 'x')).hostname;
  } catch {}
  if (BLOCKED_HOSTS.includes(host)) throw new Error(`${host} is blocked (production); use a test environment`);
}

// `${VAR}` in the app URL comes from the environment, so tokens stay out of the document.
// `${AGENT_DIR}` is the agent's own directory (for the local fixtures).
export function expandUrl(url: string) {
  return url.replace(/\$\{(\w+)\}/g, (_, name) => {
    const value = name === 'AGENT_DIR' ? ROOT : process.env[name];
    if (!value) throw new Error(`the app URL needs $${name}, which isn't set on the agent host`);
    return value;
  });
}
