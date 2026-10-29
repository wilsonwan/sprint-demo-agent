"""Kokoro voice-over: reads text on stdin, writes a 24 kHz WAV, prints word timings as JSON.

The timings come from Kokoro's own duration predictor, so they are exact for this audio.
The JSON lists lines of tokens, each with its start and end in seconds.

Usage: uv run --project tts python -I tts/speak.py <out.wav> [voice]
"""

import json
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

SAMPLE_RATE = 24000


def main() -> None:
    out, voice = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "af_heart")
    text = sys.stdin.read().strip()
    pipeline = KPipeline(lang_code=voice[0], repo_id="hexgrad/Kokoro-82M")
    audio, tokens, offset = [], [], 0.0
    # Kokoro splits long text into chunks; each chunk's timings start at zero.
    for result in pipeline(text, voice=voice):
        chunk = result.audio.numpy()
        for t in result.tokens:
            if t.start_ts is None or t.end_ts is None:
                continue
            spoken = any(c.isalnum() for c in t.text)
            tokens.append({"text": t.text, "spoken": spoken, "start": offset + t.start_ts, "end": offset + t.end_ts})
        audio.append(chunk)
        offset += len(chunk) / SAMPLE_RATE
    sf.write(out, np.concatenate(audio), SAMPLE_RATE)
    print(json.dumps({"duration": offset, "aligned": True,
                      "lines": [{"start": 0.0, "end": offset, "text": text, "tokens": tokens}]}))


if __name__ == "__main__":
    main()
