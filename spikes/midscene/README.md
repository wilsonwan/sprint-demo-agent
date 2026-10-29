# Midscene spike: recording a segment

Throwaway proof of concept for [`docs/spike-midscene.md`](../../docs/spike-midscene.md).

```sh
npm install

# 1. Rehearse: needs a vision model (MIDSCENE_MODEL_BASE_URL / _API_KEY / _NAME / _FAMILY).
#    Plans each natural-language step and writes cache/<id>.cache.yaml.
npx tsx src/record-segment.ts rehearse segments/add-todos.json

# 2. Take: no model. Replays the cache with a fake cursor, paced to targetDurationMs,
#    and writes out/<id>/clip.mp4 + timings.json. Fails if any step misses the cache.
npx tsx src/record-segment.ts take segments/add-todos.json
```

`cache/add-todos.cache.yaml` is hand-written in Midscene's cache format (this sandbox
has no model key), so `take` runs as-is. A real `rehearse` overwrites it.

## Real app: Whaleshark settings

```sh
export WHALESHARK_WEB_URL=http://<host>:4317 WHALESHARK_WEB_TOKEN=$(cat ~/.config/whaleshark/web-token)   # filled into the segment URL
# MIDSCENE_MODEL_* as above. A model that answers bboxes in pixels needs MIDSCENE_MODEL_FAMILY=qwen2.5-vl.
npx tsx src/record-segment.ts rehearse segments/whaleshark-settings.json
npx tsx src/record-segment.ts take segments/whaleshark-settings.json
```


## Whole demo: title, agenda, step slides, close, with voice-over

```sh
# needs uv (Kokoro runs from tts/ on the CPU) and a rehearsed cache for each segment
export WHALESHARK_WEB_URL=http://<host>:4317 WHALESHARK_WEB_TOKEN=$(cat ~/.config/whaleshark/web-token)
export DEMO_TEXT_BASE_URL=... DEMO_TEXT_API_KEY=... DEMO_TEXT_MODEL=...   # any OpenAI-compatible endpoint
npx tsx src/demo.ts plan demos/whaleshark-settings     # brief.json -> plan.json (edit it, then:)
npx tsx src/demo.ts voice demos/whaleshark-settings    # Kokoro per slide, with its word timings
npx tsx src/demo.ts take demos/whaleshark-settings     # re-takes each segment with clicks on their spoken cues
npx tsx src/demo.ts render demos/whaleshark-settings   # -> out/demos/whaleshark-settings/demo.mp4
```

`voice` skips slides whose narration and voice haven't changed. Kokoro's first run downloads its weights and a spaCy
model.
