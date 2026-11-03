"""Reads a video's burned-in subtitles (the text drawn into the picture)
with PP-OCRv4's Chinese/English text recognizer, as timed lines.

    python screen_subs_runner.py <job.json>

job.json: {"ffmpeg", "video", "model", "detModel" (optional), "keys", "out",
           "band": {"x", "y", "w", "h"} (fractions of the frame),
           "ranges": [[start, end], ...] (seconds), "fps"}

ffmpeg cuts the subtitle band out of every frame (fps per second); in each
band the subtitle's letters are found (bright strokes, centred), cut out and
read; frames that read alike in a row are one line, its text the reading
seen most often. Prints "progress <0-1>" while it works and "ok <count>"
once <out> (JSON: [{"start", "end", "text", "confidence", "frames"}]) is
written.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
from collections import Counter
from difflib import SequenceMatcher

import numpy as np
import onnxruntime as ort

# The recognizer's input height; widths are a multiple of WIDTH_STEP.
REC_HEIGHT = 48
WIDTH_STEP = 64
MAX_WIDTH = 1600
BATCH = 16
MIN_CONFIDENCE = 0.55
# A finished line surer than this is kept.
LEAST_LINE_CONFIDENCE = 0.7
# Two readings of one line, at least this alike (difflib ratio).
SAME_LINE = 0.6

JUNK = re.compile(r'[#<>《》「」『』（）()\[\]【】|_~`^*①-⓿]')
EDGES = re.compile(r'^[，,。.、：:；;！!？?\s\-]+|[，,。.、：:；;\s\-]+$')
CJK = re.compile(r'[㐀-鿿]')


def local_min(gray, radius):
    """The darkest value within `radius` pixels of each pixel (a box)."""
    out = gray
    for d in range(1, radius + 1):
        shifted = np.empty_like(gray)
        shifted[:, d:] = gray[:, :-d]
        shifted[:, :d] = gray[:, :1]
        out = np.minimum(out, shifted)
        shifted = np.empty_like(gray)
        shifted[:, :-d] = gray[:, d:]
        shifted[:, -d:] = gray[:, -1:]
        out = np.minimum(out, shifted)
    rows = out
    for d in range(1, radius + 1):
        shifted = np.empty_like(out)
        shifted[d:] = out[:-d]
        shifted[:d] = out[:1]
        rows = np.minimum(rows, shifted)
        shifted = np.empty_like(out)
        shifted[:-d] = out[d:]
        shifted[-d:] = out[-1:]
        rows = np.minimum(rows, shifted)
    return rows


# A letter's stroke is thin: something much darker (its outline, its shadow,
# the picture behind it) is within this many pixels of every stroke pixel.
STROKE_REACH = 4
STROKE_CONTRAST = 55


def letters_mask(band):
    """Subtitle-coloured pixels: white/grey-white, or yellow -- and thin.

    Keep the grey-white threshold a little below pure white. 4K input is
    downscaled before it reaches this worker, and anti-aliased subtitle
    strokes otherwise lose their few >190 pixels and disappear entirely.

    Colour alone took a white shirt or a lit face behind the text for
    letters: the two lines of a subtitle then ran together into one tall
    "row" and were read as one line of nonsense. A stroke differs from such
    a surface by being thin, so a pixel only counts with something clearly
    darker close by.
    """
    b = band[:, :, 0].astype(np.int16)
    g = band[:, :, 1].astype(np.int16)
    r = band[:, :, 2].astype(np.int16)
    white = (r > 155) & (g > 155) & (b > 155) & ((np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])) < 55)
    yellow = (r > 190) & (g > 160) & (b < 120)
    gray = np.maximum.reduce([r, g, b])
    thin = (gray - local_min(gray, STROKE_REACH)) >= STROKE_CONTRAST
    return (white | yellow) & thin


def runs(flags, max_gap):
    """[start, end) of the True runs in flags, gaps up to max_gap bridged."""
    out = []
    idx = np.nonzero(flags)[0]
    if len(idx) == 0:
        return out
    start = prev = idx[0]
    for i in idx[1:]:
        if i - prev > max_gap + 1:
            out.append((start, prev + 1))
            start = i
        prev = i
    out.append((start, prev + 1))
    return out


def text_rows(band, mask=None, grow=0.25):
    """The subtitle's line(s) in the band: [(y0, y1, x0, x1)], top to bottom.

    mask: where the letters are (letters_mask's by default). grow: how much
    of a row's height is added around it before it is read.
    """
    if mask is None:
        mask = letters_mask(band)
    height, width = mask.shape
    # The old minimum was relative to the whole search band (height / 8).
    # A broad fallback band from a 4K video is about 200 px high after
    # scaling, while its subtitle glyphs can be only 10-20 px high. Those
    # perfectly valid rows were therefore rejected. Cap the minimum at a
    # glyph-sized value instead.
    min_row_height = max(4, min(14, height // 20))
    min_row_pixels = max(2, int(width * 0.002))
    row_runs = [r for r in runs(mask.sum(axis=1) >= min_row_pixels, max(1, min(5, height // 40))) if r[1] - r[0] >= min_row_height]
    found = []
    for y0, y1 in row_runs:
        cols = mask[y0:y1].sum(axis=0) >= 2
        # Letters of one line are close together; a speck far away is not text.
        pieces = runs(cols, int((y1 - y0) * 1.8))
        if not pieces:
            continue
        mid = width / 2
        # Keep real word/character groups and join them into one text line.
        # Taking only the single biggest group dropped the rest of English
        # lines whenever a wide word space split the mask.
        substantial = [p for p in pieces if mask[y0:y1, p[0]:p[1]].sum() >= max(3, (y1 - y0) // 3)]
        if not substantial:
            substantial = [max(pieces, key=lambda p: (mask[y0:y1, p[0]:p[1]].sum(), -abs((p[0] + p[1]) / 2 - mid)))]
        x0 = min(p[0] for p in substantial)
        x1 = max(p[1] for p in substantial)
        if x1 - x0 < (y1 - y0) * 0.8:
            continue
        if mask[y0:y1, x0:x1].mean() < 0.018:
            continue
        pad = max(4, int((y1 - y0) * grow))
        found.append((max(0, y0 - pad), min(height, y1 + pad), max(0, x0 - pad), min(width, x1 + pad)))
    return found


def resize(img, h, w):
    ys = np.clip(((np.arange(h) + 0.5) * img.shape[0] / h).astype(int), 0, img.shape[0] - 1)
    xs = np.clip(((np.arange(w) + 0.5) * img.shape[1] / w).astype(int), 0, img.shape[1] - 1)
    return img[ys][:, xs]


# "ArtsAcademy": the recognizer drops a narrow space now and then; a capital
# straight after a small letter is where one was.
LOST_SPACE = re.compile(r'(?<=[a-z])(?=[A-Z][a-z])')


def clean(text):
    return LOST_SPACE.sub(' ', EDGES.sub('', JUNK.sub('', text)).strip())


class Reader:
    def __init__(self, model, keys):
        self.keys = [''] + open(keys, encoding='utf-8').read().splitlines() + [' ']
        # A few threads: the inputs are small, and onnxruntime's default (one
        # per core) spent its time contending with ffmpeg -- measured on a
        # 28-thread CPU: 5 minutes of 4K read in 60 s, 21 s with 4 threads.
        options = ort.SessionOptions()
        options.intra_op_num_threads = int(os.environ.get('OCR_THREADS', '4'))
        self.session = ort.InferenceSession(model, options, providers=['CPUExecutionProvider'])
        self.input = self.session.get_inputs()[0].name

    def decode(self, logits):
        ids = logits.argmax(-1)
        probs = logits.max(-1)
        chars, confs, at, last = [], [], [], 0
        steps = len(ids)
        for k, (i, p) in enumerate(zip(ids, probs)):
            if i != last and i != 0:
                char = self.keys[i] if i < len(self.keys) else ''
                if char:
                    chars.append(char)
                    confs.append(float(p))
                    # Where along the input (0-1) the character was read.
                    at.append((k + 0.5) / steps)
            last = i
        return ''.join(chars), (float(np.mean(confs)) if confs else 0.0), at

    def read(self, crops):
        """Text, confidence and character places (0-1 of the crop's width)
        of each crop (BGR, any size)."""
        prepared = []
        for c in crops:
            w = int(round(c.shape[1] * REC_HEIGHT / max(1, c.shape[0])))
            w = max(WIDTH_STEP, min(MAX_WIDTH, w))
            prepared.append(resize(c, REC_HEIGHT, w))
        results = [('', 0.0, [])] * len(crops)
        by_width = {}
        for i, p in enumerate(prepared):
            by_width.setdefault(-(-p.shape[1] // WIDTH_STEP) * WIDTH_STEP, []).append(i)
        for width, ids in by_width.items():
            for s in range(0, len(ids), BATCH):
                chunk = ids[s:s + BATCH]
                batch = np.zeros((len(chunk), REC_HEIGHT, width, 3), np.float32)
                for j, i in enumerate(chunk):
                    batch[j, :, :prepared[i].shape[1]] = prepared[i]
                batch = ((batch / 255.0 - 0.5) / 0.5).transpose(0, 3, 1, 2)
                out = self.session.run(None, {self.input: batch})[0]
                for j, i in enumerate(chunk):
                    text, conf, at = self.decode(out[j])
                    # The batch is as wide as its widest crop: places are
                    # of the batch, a narrower crop fills only its left part.
                    results[i] = (text, conf, [min(1.0, a * width / prepared[i].shape[1]) for a in at])
        return results


# A reading the mask could not make well is made again from where a text
# detector finds the lines.
WEAK_READING = 0.8
DET_THRESHOLD = 0.3
DET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
DET_STD = np.array([0.229, 0.224, 0.225], np.float32)


class Detector:
    """PP-OCRv4's text detector: for every pixel, how likely it is text.

    The letter mask goes by colour and thinness; white letters on a white
    shirt or a lit face give it nothing to hold on to, and the two lines of
    a subtitle were read as one line of nonsense. The detector was trained
    for exactly that, so it is asked where the mask's reading is weak.
    """

    def __init__(self, model):
        options = ort.SessionOptions()
        options.intra_op_num_threads = int(os.environ.get('OCR_THREADS', '4'))
        self.session = ort.InferenceSession(model, options, providers=['CPUExecutionProvider'])
        self.input = self.session.get_inputs()[0].name

    def mask(self, band):
        # At the band's own size: at half size (a quarter of the time) it
        # missed one row of a two-line subtitle now and then, and a line's
        # end came out a second early.
        h, w = band.shape[:2]
        # The model takes sizes that are multiples of 32.
        ph, pw = -(-h // 32) * 32, -(-w // 32) * 32
        padded = np.zeros((ph, pw, 3), np.float32)
        padded[:h, :w] = band
        x = ((padded / 255.0 - DET_MEAN) / DET_STD).transpose(2, 0, 1)[None]
        prob = self.session.run(None, {self.input: x})[0][0, 0]
        return prob[:h, :w] > DET_THRESHOLD


def centred(rows, width):
    """Whether any row could be a subtitle: wide for its height and about
    the middle of the picture. A bright speck off to one side is not worth
    asking the detector about."""
    for y0, y1, x0, x1 in rows:
        if x1 - x0 >= (y1 - y0) * 2 and abs((x0 + x1) / 2 - width / 2) <= width * 0.25:
            return True
    return False


# A gap between letters at least this wide (of the letters' height) is a
# space between words. Letters of one word sit about a tenth apart, words a
# quarter or more.
WORD_GAP = 0.3
ASCII_WORD = re.compile(r"[A-Za-z0-9'’,.!?;:%$-]")


def word_gaps(mask_row):
    """Where the words of a line part: [(x0, x1)] as fractions of its width.

    mask_row: the letter mask of the line's own rows and columns. The
    letters' height is where most of the ink is (a comma's tail or an
    accent does not count).
    """
    rows = mask_row.sum(axis=1)
    if rows.size == 0 or rows.max() <= 0:
        return []
    inked = np.nonzero(rows >= rows.max() * 0.25)[0]
    letter_height = inked[-1] - inked[0] + 1
    cols = mask_row.sum(axis=0) > 0
    filled = np.nonzero(cols)[0]
    if len(filled) < 2:
        return []
    width = mask_row.shape[1]
    holes = [(a + 1, b) for a, b in zip(filled[:-1], filled[1:]) if b - a > 1]
    if not holes:
        return []
    # A word gap is wide for the letters AND for this line: several times
    # the usual hole between two of its letters (small text has holes of a
    # pixel or two everywhere, and a fixed share of the height took them
    # all for spaces).
    usual = float(np.median([b - a for a, b in holes]))
    least = max(3.0, letter_height * WORD_GAP, usual * 2.5)
    return [(a / width, b / width) for a, b in holes if b - a >= least]


def with_spaces(text, at, gaps):
    """The reading with a space put back wherever the picture shows one.

    The recognizer drops a narrow space now and then ("Threehundredyears",
    "Tryme"). Each character's place along the line is known, and so are
    the gaps between the words in the picture: two Latin characters with a
    gap between them, and no space read there, get one.
    """
    if not gaps or len(at) != len(text):
        return text
    out = []
    for k, char in enumerate(text):
        if k > 0 and char != ' ' and text[k - 1] != ' ' and ASCII_WORD.match(char) and ASCII_WORD.match(text[k - 1]):
            if any(at[k - 1] < (g0 + g1) / 2 < at[k] for g0, g1 in gaps):
                out.append(' ')
        out.append(char)
    return ''.join(out)


def join_rows(kept):
    # Chinese with an English translation under it: the Chinese is the line.
    if any(CJK.search(t) for t, _ in kept):
        kept = [(t, c) for t, c in kept if CJK.search(t)]
    return ' '.join(t for t, _ in kept), min(c for _, c in kept)


def read_rows(reader, band, rows, letters):
    """rows read and joined. letters: the band's letter mask (for the spaces)."""
    if not rows:
        return '', 0.0
    readings = reader.read([band[y0:y1, x0:x1] for y0, y1, x0, x1 in rows])
    kept = [(clean(with_spaces(t, at, word_gaps(letters[y0:y1, x0:x1]))), c) for (t, c, at), (y0, y1, x0, x1) in zip(readings, rows)]
    kept = [(t, c) for t, c in kept if t and c >= MIN_CONFIDENCE]
    return join_rows(kept) if kept else ('', 0.0)


def read_frame(reader, band, detector=None):
    # Every frame is read, even when the line has not changed: a line's text
    # is the reading seen most often, so one bad reading cannot stick.
    letters = letters_mask(band)
    rows = text_rows(band, letters)
    text, conf = read_rows(reader, band, rows, letters)
    # Something letter-like is there but did not read well: the detector's
    # lines instead, when they read better. (Nothing letter-like at all is
    # an empty frame -- most of a film -- and is left at that.)
    if detector is not None and conf < WEAK_READING and centred(rows, band.shape[1]):
        # The detector marks the core of each line; the letters reach half a
        # line further out.
        found_text, found_conf = read_rows(reader, band, text_rows(band, detector.mask(band), grow=0.5), letters)
        if found_text and found_conf > conf:
            return found_text, found_conf
    return text, conf


def bare(text):
    """Letters and digits only, lower case: what two readings are compared by."""
    return re.sub(r'[^0-9a-z㐀-鿿]', '', text.lower())


def same_subtitle(a, b):
    """One reading holds (nearly all of) the other: the same subtitle."""
    a, b = bare(a), bare(b)
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) < 4:
        return False
    if short in long:
        return True
    match = SequenceMatcher(None, short, long).find_longest_match(0, len(short), 0, len(long))
    return match.size >= 0.8 * len(short)


# What the recognizer mixes up in English, where the context settles it.
ENGLISH_FIXES = [
    # A capital I read as a small L or the digit one: "l am", "1 owe", "lndex".
    (re.compile(r"\bl\b(?!')"), 'I'),
    (re.compile(r'\bl(?=[bcdfghjkmnpqrstvwxz])'), 'I'),
    (re.compile(r'^1(?= [a-z])'), 'I'),
    # A zero read as the letter o inside a number: "30,0o0", "2.o".
    (re.compile(r'(?<=\d)[oO](?=\d|\b)'), '0'),
    (re.compile(r'(?<=\d[.,])[oO](?=\d|\b)'), '0'),
]


# The recognizer writes Chinese (full-width) punctuation for English text.
WIDE_PUNCTUATION = str.maketrans({'？': '?', '！': '!', '，': ',', '：': ':', '；': ';', '。': '.', '’': "'", '‘': "'", '“': '"', '”': '"'})

# Everyday English words: with the words the film itself uses, enough to
# take apart words the recognizer ran together ("everspokento").
COMMON_WORDS = set("""
a about above across after again against all almost alone along already also always am an and another any anyone
anything are around as ask at away back bad be because been before behind being believe best better between big both
bring but by call came can can't come could couldn't day dead did didn't die do does doesn't doing don't done down each
else end enough even ever every everyone everything eyes face family far father feel few find first for found friend
from get give go god going gone good got had hand has have he he's head hear heard help her here him his hold home how
i i'd i'll i'm i've if in into is isn't it it's its just keep kill kind knew know last leave left let let's life like
little long look lost love made make man many may maybe me mean men might mind mine money more most mother move much
must my name need never new next night no not nothing now of off oh old on once one only open or other our out over own
people place please put real really right run said same saw say see seen she should show since so some someone something
son soon sorry speak spoke spoken stand stay still stop such sure take talk tell than thank that that's the their them
then there these they thing things think this those though thought three through time to today together told too took
treat true try turn two under until up us use very wait want wanted was wasn't way we well went were what when where
which while who whole why will wipe wiped with without won't word work world would wouldn't wrong year years yes yet you
you're you've young your brother sister master lord king queen prince emperor power strong blood sword sir miss boss
understand overcome handsome overnight somewhat whatever whenever wherever whoever however meantime lifetime sometime
sometimes moreover anywhere everywhere somewhere meanwhile throughout underworld overpower goodnight overall income
outcome forever nowhere tonight become became inside outside cannot myself yourself himself herself itself nobody
anybody somebody everybody forget forgot forgive anyway somehow within onto upon
""".split())


CONTRACTION_RUN = re.compile(r"(?<=[A-Za-z])('(?:s|t|re|ve|ll|d|m))(?=[A-Za-z]{2,})")


def split_run_together(word, known):
    """A run-together word as its words ("wipedoutthe" -> "wiped out the"),
    or None when it does not come apart cleanly into known ones."""
    low = word.lower()
    n = len(low)
    # best[i]: the fewest words low[:i] splits into (and where the last starts).
    best = [None] * (n + 1)
    best[0] = (0, 0)
    for i in range(1, n + 1):
        for j in range(max(0, i - 14), i):
            piece = low[j:i]
            if best[j] is None or piece not in known:
                continue
            if len(piece) == 1 and piece not in ('a', 'i'):
                continue
            if best[i] is None or best[j][0] + 1 < best[i][0]:
                best[i] = (best[j][0] + 1, j)
    if best[n] is None or not 2 <= best[n][0] <= 4:
        return None
    cuts, i = [], n
    while i > 0:
        cuts.append(best[i][1])
        i = best[i][1]
    cuts = sorted(cuts)[1:]
    parts, last = [], 0
    for c in cuts + [n]:
        parts.append(word[last:c])
        last = c
    return ' '.join(parts)


def unglue(lines):
    """Run-together words taken apart, by the film's own words and the
    everyday ones. Only a long word nobody wrote anywhere else is touched,
    and only when every piece of it is a known word."""
    seen = {}
    for l in lines:
        for w in re.findall(r"[A-Za-z']+", l['text']):
            seen[w.lower()] = seen.get(w.lower(), 0) + 1
    known = COMMON_WORDS | {w for w, c in seen.items() if c >= 2 and len(w) >= 3}
    for l in lines:
        # "Let'sgo", "Raina'sbrother": nothing follows a contraction's ending
        # in one word.
        l['text'] = CONTRACTION_RUN.sub(lambda m: m.group(1) + ' ', l['text'])

        def fix(m):
            word = m.group(0)
            if len(word) < 8 or word.lower() in COMMON_WORDS or seen.get(word.lower(), 0) >= 2:
                return word
            return split_run_together(word, known - {word.lower()}) or word
        l['text'] = re.sub(r"[A-Za-z']+", fix, l['text'])
    return lines


def polish_english(text):
    text = text.translate(WIDE_PUNCTUATION)
    for pattern, to in ENGLISH_FIXES:
        text = pattern.sub(to, text)
    return re.sub(r'\s+([?!,.;:])', r'\1', text)


def group(readings, fps):
    """[(time, text, conf)] -> lines: frames that read alike in a row."""
    lines = []
    step = 1.0 / fps
    for t, text, conf in readings:
        if not text:
            continue
        last = lines[-1] if lines else None
        # OCR may miss a couple of frames when text crosses a bright scene.
        # Match the text across that short hole instead of turning both
        # sides into one-frame fragments which are later discarded.
        if last and t - last['end'] <= max(0.8, step * 3.5):
            best = Counter(last['seen']).most_common(1)[0][0]
            if SequenceMatcher(None, best, text).ratio() >= SAME_LINE:
                last['end'] = t + step
                last['seen'].append(text)
                last['confs'].append(conf)
                continue
        lines.append({'start': t, 'end': t + step, 'seen': [text], 'confs': [conf]})
    out = []
    for ln in lines:
        if len(ln['seen']) < 2:
            continue
        counts = Counter(ln['seen'])
        text = max(counts.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
        out.append({'start': round(ln['start'], 3), 'end': round(ln['end'], 3), 'text': text, 'confidence': round(float(np.mean(ln['confs'])), 3), 'frames': len(ln['seen'])})
    # The same line flickering off for a frame or two is still one line --
    # and so is one subtitle read two ways in a row (all of it, then only
    # one of its two rows): the fuller, surer reading is kept.
    merged = []
    for ln in out:
        prev = merged[-1] if merged else None
        if prev and ln['start'] - prev['end'] < 0.6 and prev['text'] == ln['text']:
            prev['end'] = ln['end']
            prev['frames'] += ln['frames']
        elif prev and ln['start'] - prev['end'] < 0.45 and same_subtitle(prev['text'], ln['text']):
            best = ln if (len(bare(ln['text'])), ln['confidence']) > (len(bare(prev['text'])), prev['confidence']) and ln['confidence'] >= 0.8 else prev
            frames = prev['frames'] + ln['frames']
            prev.update(text=best['text'], confidence=best['confidence'], end=ln['end'], frames=frames)
        else:
            merged.append(ln)
    return merged


def main():
    job = json.load(open(sys.argv[1], encoding='utf-8'))
    reader = Reader(job['model'], job['keys'])
    # Optional: without it the letter mask's reading is all there is.
    detector = Detector(job['detModel']) if job.get('detModel') and os.path.exists(job['detModel']) else None
    fps = float(job.get('fps', 5))
    band = job['band']
    out_w, out_h = int(job['bandWidth']), int(job['bandHeight'])
    ranges = job['ranges']
    total = sum(e - s for s, e in ranges) or 1.0
    done_seconds = 0.0
    lines = []
    frame_bytes = out_w * out_h * 3
    for start, end in ranges:
        vf = f"fps={fps},crop=iw*{band['w']:.5f}:ih*{band['h']:.5f}:iw*{band['x']:.5f}:ih*{band['y']:.5f},scale={out_w}:{out_h}:flags=area"
        args = [job['ffmpeg'], '-v', 'error', '-hwaccel', 'auto', '-ss', f'{start:.3f}', '-t', f'{end - start:.3f}', '-i', job['video'], '-an', '-sn', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        # ffmpeg keeps decoding while the frames before are read.
        frames = queue.Queue(maxsize=256)

        def pump():
            while True:
                data = proc.stdout.read(frame_bytes)
                if len(data) < frame_bytes:
                    frames.put(None)
                    return
                frames.put(data)

        threading.Thread(target=pump, daemon=True).start()
        readings = []
        k = 0
        last_report = -1
        while True:
            data = frames.get()
            if data is None:
                break
            frame = np.frombuffer(data, np.uint8).reshape(out_h, out_w, 3)
            t = start + k / fps
            text, conf = read_frame(reader, frame, detector)
            readings.append((t, text, conf))
            k += 1
            pct = int(100 * (done_seconds + k / fps) / total)
            if pct != last_report:
                last_report = pct
                print(f'progress {min(1.0, pct / 100):.2f}', flush=True)
        proc.wait()
        done_seconds += end - start
        lines.extend(l for l in group(readings, fps) if l['start'] < end)
    # A film subtitled in Latin letters: a Chinese character here and there
    # is a sign or a speck read as text. It is taken out (a line of nothing
    # else goes), and the usual mix-ups of English letters are put right.
    letters = sum(len(bare(l['text'])) for l in lines)
    chinese = sum(len(CJK.findall(l['text'])) for l in lines)
    if lines and letters and chinese / letters < 0.05:
        kept = []
        for l in lines:
            text = polish_english(clean(CJK.sub('', l['text'])))
            if text:
                kept.append({**l, 'text': text})
        lines = unglue(kept)
    # A line read with almost no certainty is noise (a face, a sign), or a
    # real line read so badly that it would only mislead.
    lines = [l for l in lines if l['confidence'] >= LEAST_LINE_CONFIDENCE]
    with open(job['out'], 'w', encoding='utf-8') as f:
        json.dump(lines, f, ensure_ascii=False)
    print(f'ok {len(lines)}', flush=True)


if __name__ == '__main__':
    main()
