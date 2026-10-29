# sprint-demo-agent

Turns a sprint's tickets into a narrated demo video. The agent is in `agent/`; the Midscene spike it grew from is in
`spikes/midscene/` (see `docs/spike-midscene.md`). `README.md` covers the stack and how to run it.

Project memory for coding agents lives in this file. Add decisions here as they're made.

## The agent (`agent/`)

A Pi Durable 1.4.0 agent with a web app: tickets + environment → plan → review gate → rehearse → voice → take →
render → final gate. See `agent/src/pipeline.ts` for the phases. It runs on a host that has a Pi login for GitHub
Copilot or another model provider (`~/.pi/agent/auth.json`, or an API key) and, for Jira, Pi's Atlassian MCP login.

### Chat UI

- People talk to a chat agent: one Pi Durable conversation per thread (`agent/src/chat.ts`), on the text model, with
  tools `list_environments`, `start_demo`, `get_demo`, `edit_plan`, `decide`. Pipeline gates and failures reach it as
  `[pipeline] …` messages (a notifier, deduped by request ID). It only decides at a gate when a person asks.
- The browser rebuilds the chat from Pi Durable's `watchEvents` stream (`agent/web/src/lib/use-thread.ts`). Not
  TanStack AI: its server half would bypass Pi Durable, and `useChat` is single-client.
- Frontend: `agent/web/`, Vite + React 19 + Tailwind v4 + shadcn with the fluid-functionalism registry (`@fluid`).
  `npm run build` there; the agent serves `web/dist`.
- People type their own name in the app (per browser); it prefixes their chat messages and is recorded with decisions.
  Self-declared, not verified.
- Demos are always recorded against an environment from `agent/targets.json` (host-specific, git-ignored; see
  `targets.example.json`). An environment with a `session` block gets a headless login with the username and password
  from the app repo's env file; the saved session is kept in `agent/data/sessions/` and renewed when it expires.
  Jira comes through Pi's Atlassian MCP login, read-only (the agent never refreshes its token).
- Host settings (blocked production hosts, model overrides, Jira API token) go in `agent/.env` (git-ignored; see
  `.env.example`), which `run.sh` loads.

### Sharing (multiplayer)

- A Share toggle (agent host only) starts a Cloudflare quick tunnel (`cloudflared tunnel --url`, a random
  `*.trycloudflare.com` URL, `agent/src/tunnel.ts`). The agent has no login, so every tunnel gets a new secret share key:
  remote requests need `?key=` once (then an HttpOnly cookie); local ones (`localhost:4400`) don't. Optional
  `--allowed-mail` adds Cloudflare's email one-time PIN. The sharing API refuses remote callers.
- Quick tunnels don't carry server-sent events, so live updates go over one WebSocket (`/api/live`, topics
  `thread:<id>` and `demo:<id>`).
- Needs `cloudflared` on the agent host (PATH or `~/.local/bin`).

### Docker

- `agent/Dockerfile` + `compose.yaml`: Node 26, Playwright Chromium, ffmpeg, Kokoro (weights baked in at build) and
  `cloudflared`. Pi's login dir, `targets.json` and the app's env file are bind-mounted read-only; `agent/data` is the
  volume `agent-data`. The agent listens on 0.0.0.0 in the container, published on the host's loopback only.
- `${AGENT_DIR}` in a target's URL is the agent directory (`${PWD}` isn't set in a container).

## Models

Any pi-ai provider (`builtinModels()` in `agent/src/models.ts`), chosen with `DEMO_PROVIDER`/`DEMO_MODEL` and
`DEMO_VISION_PROVIDER`/`DEMO_VISION_MODEL`. The vision model must be on the OpenAI API (Midscene's client); the agent
checks. Only Copilot's OAuth login is refreshed: others rotate their refresh token, which would sign Pi out. The
defaults, and what was tested:

- **Text (plan, card text, narration, chat):** GitHub Copilot `gpt-6-luna` (`DEMO_MODEL`).
- **Rehearsals (Midscene vision):** GitHub Copilot `gpt-5.6-luna` (`DEMO_VISION_MODEL`). Not `gpt-6-luna`: through
  Copilot it hangs on some rehearsal requests (reproducible). Tested on a 3-step TodoMVC rehearsal: gpt-5.6-luna and
  gpt-6-sol 32.6 s, gemini-3.8-flash 66 s, gpt-5.4-nano failed. Copilot serves GPT models on the Responses API only.
- **Voice-over:** Kokoro `af_heart` on the CPU from `agent/tts/` (own uv project). Its word timings cue the takes.
- **Takes:** no model; a take that calls one fails.
- No local model for Midscene for now. A model that answers bboxes in pixels (GLM) needs Midscene family `qwen2.5-vl`.

Screenshots of the app under demo go to the vision model during rehearsal, and tickets to the text model.

## Gotchas

- In tmux, start a plain shell and type the agent command into it (`restart.sh` does this). `tmux new-session
  "cmd; exec bash"` dies on Ctrl+C, and tmux exits with its last session.
- Stop the agent with Ctrl+C or `restart.sh`, not a hard kill: a crash counts toward the restart limit of every demo
  waiting at a gate. Only one process may own `data/agent.sqlite`.
- App logins are done with plain Playwright before Midscene runs; never put credentials in steps (they'd reach the
  model and the cache file).
- Midscene is pinned at 1.15.4; releases come almost daily.

## Target video format

title card → "what this demo proves" (one card per point of the journey, plus an outcome line) → one step slide per
ticket or feature (heading, subtitle, recording inset below) → closing card (key message, then Delivered now /
Next evolution / Business value). All slides share one template: top colour bar, footer with the product name, page
number. Check card text for leaked planning notes (the plan linter flags common ones).
