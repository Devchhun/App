"""Edge TTS for one line, at the best quality Microsoft's endpoint serves.

edge_tts hard-codes the lowest-quality stream, "audio-24khz-48kbitrate-mono-mp3",
into the speech.config message it sends. At 48 kbps the MP3 encoder leaves
holes all over the upper spectrum -- visible in a spectrogram, heard as a
crackly, bubbly edge on every generated line ("អុចៗ"). The same endpoint
accepts "audio-24khz-96kbitrate-mono-mp3" (measured: same voice and text,
twice the bytes, the holes gone); it rejects PCM and Opus.

Rather than editing the installed library, this swaps the format name in the
one outgoing websocket message that carries it. If a future edge_tts sends
that message differently the swap simply does not match and the line is
made at 48 kbps as before; if the endpoint ever rejects 96 kbps, the line is
retried at 48 kbps. Either way a line is still produced. An empty or dropped
stream is retried a few times (see main) -- the endpoint does that now and
then under load, not because the line is unreadable.

Usage: python edge_tts_runner.py --voice V --text T --write-media OUT.mp3
Exit 0 with OUT written, or exit 1 with the reason on the last stderr line
(the app shows that line -- see app/main/media/edgeTts.ts)."""
import argparse
import asyncio
import sys

import aiohttp
import edge_tts

DEFAULT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
HIGH_QUALITY_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'

_wanted_format = HIGH_QUALITY_FORMAT
_original_send_str = aiohttp.ClientWebSocketResponse.send_str


async def _send_str(self, data, *args, **kwargs):
    if _wanted_format != DEFAULT_FORMAT and f'"outputFormat":"{DEFAULT_FORMAT}"' in data:
        data = data.replace(f'"outputFormat":"{DEFAULT_FORMAT}"', f'"outputFormat":"{_wanted_format}"')
    return await _original_send_str(self, data, *args, **kwargs)


aiohttp.ClientWebSocketResponse.send_str = _send_str


async def synthesize(text: str, voice: str, out_path: str) -> int:
    communicate = edge_tts.Communicate(text, voice)
    size = 0
    with open(out_path, 'wb') as handle:
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                handle.write(chunk['data'])
                size += len(chunk['data'])
    return size


async def main() -> None:
    global _wanted_format
    parser = argparse.ArgumentParser()
    parser.add_argument('--voice', required=True)
    parser.add_argument('--text', required=True)
    parser.add_argument('--write-media', required=True)
    args = parser.parse_args()
    # Microsoft's endpoint sometimes answers with an empty stream
    # (NoAudioReceived) or drops the socket for a perfectly good line --
    # typically when it is rate limiting a long run. The same line spoken
    # again a few seconds later comes back fine, so try again with growing
    # pauses (1 + 3 + 6 s, well inside the app's 60 s per-line limit) before
    # giving up. The tries alternate 96 and 48 kbps: a line refused only for
    # the better stream still gets made, and one that was just unlucky is not
    # left with the crackly 48 kbps sound.
    retry_waits = [1.0, 3.0, 6.0]
    formats = [HIGH_QUALITY_FORMAT, DEFAULT_FORMAT, HIGH_QUALITY_FORMAT, DEFAULT_FORMAT]
    for attempt in range(len(retry_waits) + 1):
        _wanted_format = formats[attempt]
        try:
            await synthesize(args.text, args.voice, args.write_media)
            return
        except (edge_tts.exceptions.NoAudioReceived, edge_tts.exceptions.UnexpectedResponse,
                aiohttp.ClientError, asyncio.TimeoutError) as err:
            if attempt == len(retry_waits):
                raise
            print(f'attempt {attempt + 1} failed ({type(err).__name__}); retrying', file=sys.stderr)
            await asyncio.sleep(retry_waits[attempt])

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as err:  # the app reads the last stderr line
        print(f'{type(err).__module__}.{type(err).__name__}: {err}', file=sys.stderr)
        sys.exit(1)
