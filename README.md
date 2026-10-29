# sprint-demo-agent

Turns a sprint's Jira tickets into a narrated demo video. You chat with an agent: it reads the tickets, writes a plan
(slides, narration and the browser steps to show), waits for your review, rehearses the steps against a test
environment, voices the narration, records the takes and renders the video, then waits for your final approval.

The video follows one template: title card → "what this demo proves" → one step slide per ticket or feature, with the
recording inset → closing card (delivered now, next evolution, business value).

## How it works

```
Jira tickets ─► plan ─► review gate ─► rehearse ─► voice ─► take ─► render ─► final gate ─► demo.mp4
               (text     (people,      (vision    (Kokoro)  (no      (ffmpeg)  (people)
                model)    in chat)      model)              model)
```

- **Plan:** the text model reads the tickets and the app's start page and writes the card text, narration and plain-English
  steps. A linter flags leaked notes, overlong narration and steps it can't record.
- **Rehearse:** [Midscene.js](https://midscenejs.com) drives Playwright, asks the vision model to carry out each step
  once, and caches what it did (a plan and an element XPath per step). The cache is then replayed without the model to
  prove it holds.
- **Voice:** [Kokoro](https://github.com/hexgrad/kokoro) reads each slide's narration on the CPU. Its word timings
  become the cue for each step.
- **Take:** replays the cache with a fake cursor, each step on its spoken cue. No model calls.
- **Render:** slides to PNG, the clips inset into the step slides, crossfades between slides.

Each demo is a durable task with a shared document, so the pipeline survives restarts and waits at the gates for as
long as it takes. Several people can follow the same thread and decide at the gates.

## Tech stack

| Part | What |
|---|---|
| Agent runtime | [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.4.0 (tasks, documents, conversations on SQLite), [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) 1.4.0 for models, Node 22.13+ with `tsx` |
| Models | Any provider [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) supports, through the host's Pi login or an API key: one model for text and chat, one vision model on the OpenAI API for rehearsals |
| Browser | Playwright 1.63, Midscene.js 1.15.4 (pinned) |
| Voice | Kokoro (`af_heart`) in its own [uv](https://docs.astral.sh/uv/) project, CPU-only PyTorch |
| Video | ffmpeg |
| Jira | Pi's Atlassian MCP login (read-only), the Jira REST API, or fixture files |
| Web app | Vite 8, React 19, TypeScript, Tailwind CSS v4, shadcn/ui with the [fluid-functionalism](https://github.com/mickadesign/fluid-functionalism) registry; live updates over a WebSocket |
| Sharing | Optional Cloudflare quick tunnel (`cloudflared`) with a per-tunnel share key |

## Repository layout

```
agent/                the agent
  src/main.ts         entry point: harness, models, web server
  src/chat.ts         the chat agent and its tools
  src/pipeline.ts     the demo pipeline (durable task with phases)
  src/stages/         plan, recorder (Midscene + Playwright), voice, render
  src/targets.ts      environments and their headless logins
  src/tunnel.ts       sharing through a Cloudflare quick tunnel
  src/web/server.ts   HTTP API + WebSocket
  web/                the React app
  tts/                Kokoro (uv project)
  fixtures/           sample Jira tickets and a TodoMVC page to try it with
spikes/midscene/      the original Midscene spike (see docs/spike-midscene.md)
```

## Prerequisites (on the agent host)

- Node.js 22.13 or later, [uv](https://docs.astral.sh/uv/getting-started/installation/), ffmpeg.
- A model provider: a Pi login (`~/.pi/agent/auth.json`; log in with Pi's `/login`) or the provider's API key in
  `agent/.env` (for example `OPENAI_API_KEY`). The agent reads Pi's logins and never writes them. See
  [Models](#models).
- For Jira: Pi's Atlassian MCP login (`~/.pi/agent/mcp-auth.json`), or `JIRA_BASE_URL` plus an API token in
  `agent/.env`. Ticket keys that have a file in `agent/fixtures/jira/` are read from there.
- Optional: `cloudflared` on the PATH or in `~/.local/bin` for the Share button.

## Setup

```sh
cd agent
npm ci
npx playwright install chromium
(cd web && npm ci && npm run build)
uv sync --project tts            # Kokoro; its first run also downloads the voice weights

cp targets.example.json targets.json   # your environments, see below
cp .env.example .env                   # optional host settings
```

### Environments (`agent/targets.json`)

The environments a demo can be recorded against. Each has an `id`, a `label`, the `appUrl`, and a `readyText` that
shows once the app has loaded (visible text, a placeholder or a heading). `${VAR}` in the URL is filled from the
environment, so tokens stay out of the file; `${AGENT_DIR}` is the agent's own directory (for the local fixtures).

An environment that needs a login gets a `session` block: the agent opens `loginUrl`, fills the username and password
from the variables `usernameVar` and `passwordVar` in `envFile` (for example your app's Playwright `.env`), and keeps the
session while `checkUrl` answers 200 with a token. Sessions are saved in `agent/data/sessions/` (owner-only) and renewed
when they expire. Credentials are read at login time only; they never reach the model or the demo's files.

`targets.example.json` includes a local TodoMVC page to try the whole pipeline without an app of your own.

### Host settings (`agent/.env`)

See `agent/.env.example`. The important one is `DEMO_BLOCKED_HOSTS`: production hosts the agent refuses to record
against.

### Models

The agent uses two models, by pi-ai provider and model ID:

| Setting | Used for | Requirement |
|---|---|---|
| `DEMO_PROVIDER`, `DEMO_MODEL` | the plan, card text, narration and the chat | any chat model with tool calls |
| `DEMO_VISION_PROVIDER`, `DEMO_VISION_MODEL` | rehearsals: Midscene looks at screenshots and finds elements | a vision model on the OpenAI API (Chat Completions or Responses) that can locate elements |

The vision provider defaults to the text provider. Midscene needs to know how the vision model reports positions:
`gpt-*` models use family `gpt-5`, `gemini-*` use `gemini`, anything else `qwen2.5-vl` (pixel boxes); set
`MIDSCENE_MODEL_FAMILY` to override (see [Midscene](https://midscenejs.com)'s model setup docs).
Rehearsals send screenshots of the app to the vision model, and the tickets go to the text model.

The agent refreshes short-lived tokens only where that's safe. An expired OAuth login that would rotate its refresh
token (and so sign Pi out) isn't refreshed; run Pi once to refresh it, or use an API key.

## Running

```sh
cd agent
./run.sh                 # http://localhost:4400 ; PORT=... to change it, --host 0.0.0.0 to listen beyond loopback
```

Or in tmux, where `./restart.sh` stops the agent cleanly and starts it again in the session `demo-agent`. Stop it with
Ctrl+C rather than killing it, and run only one agent per data directory. The log is in `agent/data/agent.log`.

### In Docker

The image has everything the agent runs (Node, Chromium, ffmpeg, Kokoro with its voice weights, `cloudflared`), so the
host needs only Docker and the Pi login. Logins and settings are mounted from the host; none are in the image.

```sh
cp agent/targets.example.json agent/targets.json   # your environments
cp agent/.env.example agent/.env                   # optional: blocked hosts, models, Jira token
cp .env.docker.example .env                        # where Pi's logins and the app's env file are
docker compose up -d --build                       # http://localhost:4400
docker compose logs -f                             # the agent's log
docker compose down                                # stops it cleanly; demos and threads stay in the volume
```

- Pi's login directory (`~/.pi/agent` by default, `PI_AGENT_DIR`) is mounted read-only.
- If an environment logs in, set `APP_ENV_FILE` to the env file its `envFile` names; it's mounted read-only at the same
  path, so `targets.json` works unchanged.
- Data (the database, demos, browser sessions) lives in the Docker volume `agent-data`.
- The port is published on this machine's loopback only. Teammates come in through Share, which works in the container.
- The container runs as uid 1000 (`node`). If your user has another uid, Pi's `auth.json` (mode 600) won't be readable;
  set `user:` in `compose.yaml` to your uid.

## Using it

1. Open the app and type your name at the bottom of the sidebar. It goes with your messages and decisions.
2. Click **New demo** and ask, for example: *"Make a demo for PROJ-123 and PROJ-124 on QA, for the product team."*
   The agent lists the environments if you don't name one. To try it out: *"Make a demo for TODO-1 and TODO-2 on
   TodoMVC."*
3. **Review gate:** the plan appears in the right-hand panel (Plan tab). Ask the agent for changes in the chat
   ("make step 2's narration shorter", "add a step that opens Settings"), or open the plan editor to change text
   yourself. Approve when it's right.
4. The pipeline rehearses each step slide. If a step can't be done, the agent explains why in the chat and suggests a
   fix; you can reword the step and it rehearses again.
5. **Final gate:** watch the video in the Video tab, then approve, or ask for changes and rebuild. Download it from
   the Video tab.

The right-hand panel shows the progress of each stage, the plan, and an activity timeline of who did what. Threads
(and everything they made) can be deleted from the sidebar.

### Sharing with teammates

On the agent host, click **Share** to start a Cloudflare quick tunnel and copy the link; it carries a secret key that
changes every time you share. Optionally list emails or domains so visitors also need a one-time PIN from Cloudflare.
Turning sharing off kills the link. Names in the app are self-declared, so share the link only with people you trust.

## Development

```sh
cd agent && npx tsc --noEmit -p .        # type-check the agent
cd agent/web && npm run dev              # the React app with hot reload (proxies the API to :4400)
```

`AGENTS.md` holds the design decisions and gotchas for coding agents working on the repo.

## Credits

- [fluid-functionalism](https://github.com/mickadesign/fluid-functionalism) by Micka Touillaud: the web app's
  components and starter (MIT), built on [shadcn/ui](https://github.com/shadcn-ui/ui) (MIT). See
  `THIRD-PARTY-NOTICES.md`.
- [Pi Durable and pi-ai](https://www.npmjs.com/package/@earendil-works/pi-durable) (MIT): the agent runtime and models.
- [Midscene.js](https://midscenejs.com) (MIT) and [Playwright](https://playwright.dev) (Apache-2.0): rehearsals and
  takes.
- [Kokoro](https://github.com/hexgrad/kokoro) (Apache-2.0): the voice-over.
- [Untitled UI icons](https://www.untitledui.com/free-icons) (MIT), [Lucide](https://lucide.dev) (ISC) and the
  [Inter](https://rsms.me/inter/) typeface (OFL-1.1).

## License

MIT, see `LICENSE`. Code copied from other projects keeps its own license; see `THIRD-PARTY-NOTICES.md`.
