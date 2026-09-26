import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildFilmHtml, buildVoiceJs, captionsFromCues, captionsToSrt, extractCode, failingFile, failingLines, groupChapters, sceneSeconds, scriptCoverage, xianxiaVocabulary, kitVocabulary, loudnessEnvelope, patchRuntime, sceneSlugs, stageMoods, vocabularyText } from './kuanimationKit'

const kit = join(__dirname, '../../../resources/kuanimation/assets')
const read = (file: string): string => readFileSync(join(kit, file), 'utf8')

describe('kuanimation kit', () => {
  it('reads each style\'s backdrop moods from stage.js', () => {
    const stage = read('stage.js')
    expect(stageMoods(stage, 'pencil')).toEqual(expect.arrayContaining(['warm', 'dawn', 'night', 'paper']))
    expect(stageMoods(stage, 'wash')).toEqual(expect.arrayContaining(['warm', 'night', 'storm']))
    expect(stageMoods(stage, 'haze')).toContain('warm')
    expect(stageMoods('', 'pencil')).toEqual(['warm'])
  })

  it('keeps the kit\'s own DT.draw and adds it to an older runtime', () => {
    const native = read('kuanimation.js')
    expect(patchRuntime(native)).toBe(native)
    const older = native.replace(/ {2}window\.DT\.draw = [^\n]*\n/, '')
    expect(older).not.toContain('window.DT.draw')
    expect(patchRuntime(older)).toContain('window.DT.draw = i =>')
    expect(() => patchRuntime('nothing here')).toThrow()
  })

  it('builds film.html with the look and the title, branded AI Animation', () => {
    const html = buildFilmHtml(read('film-template.html'), { style: 'wash', title: 'ប្រាសាទ <អង្គរ>', khmer: true })
    expect(html).toContain("style: 'wash',")
    expect(html).toContain('<title>ប្រាសាទ អង្គរ</title>')
    expect(html).toContain('{text: "ប្រាសាទ <អង្គរ>", size: 72, font: FONT.khmer')
    expect(html).toContain('Made with AI Animation')
    expect(html).not.toContain('Kuanimation')
    expect(html).not.toContain("'The End'")
  })

  it('has the kit guard what AI writers get wrong', () => {
    // Fixed in the kit itself (were page shims): unknown arm poses and bare
    // prop functions (cast.js), empty shapes and ell's point count (brush.js),
    // Windows Khmer fonts.
    expect(read('cast.js')).toContain("const PP_ARMS = ['down', 'up', 'pray', 'point', 'hold', 'row', 'cheer'];")
    expect(read('cast.js')).toContain("typeof prop === 'function'")
    expect(read('brush.js')).toContain('if (badShape(pts)) return;')
    expect(read('brush.js')).toContain('n = n >= 3 ? Math.round(n) : 28')
    expect(read('brush.js')).toContain('"Khmer UI"')
    expect(read('kuanimation.js')).toContain('window.DT.draw = i =>')
    expect(read('film-template.html')).toContain('Made with AI Animation')
  })

  it('writes voice.js as the kit expects', () => {
    const js = buildVoiceJs([{ scene: 'intro', lines: [{ file: 'audio/intro-0.mp3', dur: 2.5, sub: 'សួស្តី', sub2: 'Hello', env: [0.1] }] }])
    expect(js).toContain('const VOICE = [{"scene":"intro"')
  })

  it('measures loudness once per 1000 samples', () => {
    const samples = new Int16Array(2500).fill(16384)
    expect(loudnessEnvelope(samples)).toEqual([0.5, 0.5])
  })

  it('takes the code out of a fenced reply', () => {
    expect(extractCode('Here you go:\n```js\nconst SCENES = [];\n```\nEnjoy')).toBe('const SCENES = [];\n')
    expect(extractCode('const SCENES = [];')).toBe('const SCENES = [];\n')
  })

  it('reads the names the kit really accepts', () => {
    const v = kitVocabulary({ cast: read('cast.js'), action: read('action.js'), stage: read('stage.js'), brush: read('brush.js'), props: read('props.js'), runtime: read('kuanimation.js'), director: read('director.js') })
    // The poses Gemini guessed in a real run ('idle', 'run', 'reach') are not among them.
    expect(v.arms).toEqual(['down', 'up', 'pray', 'point', 'hold', 'row', 'cheer'])
    expect(v.arms).not.toContain('idle')
    expect(v.hats).toContain('mokot')
    expect(v.props).toEqual(expect.arrayContaining(['spear', 'parasol']))
    expect(v.faceMoods).toEqual(expect.arrayContaining(['happy', 'sad']))
    expect(v.emotes).toEqual(expect.arrayContaining(['!', '?', 'heart', 'idea']))
    expect(v.colors).toEqual(expect.arrayContaining(['gold', 'yellow', 'brown', 'sky']))
    expect(vocabularyText(v)).toContain("There is NO 'idle'")
    // The signature that tripped a real film: ell's fifth argument is a point count.
    expect(v.signatures).toContain('ell(cx, cy, rx, ry, n = 28, a0 = 0, a1 = TAU)')
    expect(v.signatures.find((s) => s.startsWith('sh('))).toContain('{w = LINE')
    expect(v.signatures.find((s) => s.startsWith('pp('))).toBe('pp(c, x, y, s, o = {})')
    expect(v.signatures.length).toBeGreaterThan(25)
  })

  it('shows the failing lines of scenes.js', () => {
    const code = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n')
    const excerpt = failingLines(code, 'TypeError: x\n    at Object.draw (file:///C:/f/scenes.js:40:28)')
    expect(excerpt).toContain('>> 40: line40')
    expect(excerpt).toContain('   37: line37')
    expect(failingLines(code, 'no location')).toBe('')
  })

  it('turns the voice cues into timed captions and SRT', () => {
    const voice = [
      { scene: 'intro', lines: [{ file: 'audio/intro-0.mp3', dur: 2.5, sub: 'ក្មេងប្រុសម្នាក់', sub2: 'A boy', env: [] }, { file: 'audio/intro-1.mp3', dur: 1.25, sub: 'ដាំគ្រាប់ស្វាយ', sub2: '', env: [] }] }
    ]
    const captions = captionsFromCues([{ file: 'audio/intro-1.mp3', t: 4.3 }, { file: 'audio/intro-0.mp3', t: 1.2 }, { file: 'audio/missing.mp3', t: 9 }], voice)
    expect(captions).toEqual([
      { startTime: 1.2, endTime: 3.7, text: 'ក្មេងប្រុសម្នាក់', text2: 'A boy' },
      { startTime: 4.3, endTime: 5.55, text: 'ដាំគ្រាប់ស្វាយ', text2: '' }
    ])
    expect(captionsToSrt(captions)).toBe('1\n00:00:01,200 --> 00:00:03,700\nក្មេងប្រុសម្នាក់\n\n2\n00:00:04,300 --> 00:00:05,550\nដាំគ្រាប់ស្វាយ\n')
    // The English file skips lines that have no translation, and renumbers.
    expect(captionsToSrt(captions, 'text2')).toBe('1\n00:00:01,200 --> 00:00:03,700\nA boy\n')
    expect(captionsToSrt([])).toBe('')
  })

  it('can leave the subtitles out of the picture', () => {
    const template = read('film-template.html')
    expect(buildFilmHtml(template, { style: 'pencil', title: 't', khmer: false, subtitles: false })).toContain("frame: 'stage',\n  subtitles: false,")
    expect(buildFilmHtml(template, { style: 'pencil', title: 't', khmer: false })).not.toContain('subtitles: false')
  })

  it('starts and ends a caption on the speech, not the clip\'s silence', () => {
    // 6 silent frames (0.25 s), 24 voiced, 6 silent: a 1.5 s clip.
    const env = [...Array(6).fill(0.001), ...Array(24).fill(0.2), ...Array(6).fill(0.001)]
    const [caption] = captionsFromCues([{ file: 'a.mp3', t: 10 }], [{ scene: 's', lines: [{ file: 'a.mp3', dur: 1.5, sub: 'x', sub2: '', env }] }])
    expect(caption.startTime).toBeCloseTo(10.25, 3)
    expect(caption.endTime).toBeCloseTo(10 + 30 / 24 + 0.1, 3)
  })

  it('loads a chapter film: SCENES first, the cast, then each chapter, and the xianxia kit', () => {
    const html = buildFilmHtml(read('film-template.html'), { style: 'haze', title: 't', khmer: true, chapters: 3, xianxia: true })
    const at = (s: string): number => html.indexOf(s)
    expect(html).not.toContain('src="scenes.js"')
    expect(at('const SCENES = [];')).toBeGreaterThan(at('voice.js'))
    expect(at('film-cast.js')).toBeGreaterThan(at('const SCENES = [];'))
    expect(at('chapter-1.js')).toBeGreaterThan(at('film-cast.js'))
    expect(at('chapter-3.js')).toBeGreaterThan(at('chapter-2.js'))
    expect(at('xianxia.js')).toBeGreaterThan(at('action.js'))
    expect(at('xianxia.js')).toBeLessThan(at('film-cast.js'))
    // The same from a template saved with Windows line endings.
    const crlf = buildFilmHtml(read('film-template.html').replace(/\n/g, '\r\n'), { style: 'haze', title: 't', khmer: true, chapters: 2, xianxia: true })
    expect(crlf).toContain('<script src="xianxia.js"></script>')
    expect(crlf).toContain('<script src="chapter-2.js"></script>')
  })

  it('finds which film file an error comes from', () => {
    expect(failingFile('TypeError: x\n    at polyPath (kuanimation.js:76:79)\n    at Object.set (chapter-3.js:121:13)')).toBe('chapter-3.js')
    expect(failingFile('at fxTree (film-cast.js:12:4)')).toBe('film-cast.js')
    expect(failingFile('at polyPath (kuanimation.js:76:79)')).toBeNull()
    expect(failingLines('a\nb\nc\nd', 'at x (chapter-2.js:2:1)', 'chapter-2.js')).toContain('>> 2: b')
  })

  it('groups scenes into chapters of about two and a half minutes', () => {
    // 10 scenes of 30 s: 5 per chapter at the 150 s target.
    expect(groupChapters(Array(10).fill(30))).toEqual([[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]])
    // A short film stays one chapter.
    expect(groupChapters([20, 25, 18])).toEqual([[0, 1, 2]])
    // A tiny leftover joins the chapter before it.
    expect(groupChapters([70, 70, 70, 10])).toEqual([[0, 1], [2, 3]])
    expect(groupChapters(Array(20).fill(10), 150, 8).every((c) => c.length <= 10)).toBe(true)
    expect(sceneSeconds([2, 3])).toBeCloseTo(1.2 + 2 + .55 + 3 + 1.5)
  })

  it('checks that the lines keep the user\'s own script', () => {
    const script = 'ក្មេងប្រុសម្នាក់ឈ្មោះ ដារ៉ា។ គាត់ដាំគ្រាប់ស្វាយ។ រាល់ថ្ងៃគាត់ស្រោចទឹក។'
    expect(scriptCoverage(script, ['ក្មេងប្រុសម្នាក់ឈ្មោះ ដារ៉ា។', 'គាត់ដាំគ្រាប់ស្វាយ។', 'រាល់ថ្ងៃគាត់ស្រោចទឹក។'])).toEqual({ lengthRatio: 1, linesFound: 1 })
    const dropped = scriptCoverage(script, ['ក្មេងប្រុសម្នាក់ឈ្មោះ ដារ៉ា។', 'រាល់ថ្ងៃគាត់ស្រោចទឹក។'])
    expect(dropped.lengthRatio).toBeLessThan(.8)
    const rewritten = scriptCoverage(script, ['ក្មេងប្រុសដារ៉ា។', 'គាត់ដាំគ្រាប់ស្វាយ។', 'រាល់ថ្ងៃគាត់ស្រោចទឹក។'])
    expect(rewritten.linesFound).toBeCloseTo(2 / 3)
  })

  it('describes the xianxia kit for the prompts', () => {
    const text = xianxiaVocabulary(readFileSync(join(kit, 'xianxia.js'), 'utf8'))
    expect(text).toContain('xxCultivator(c, x, y, s, o = {})')
    expect(text).toContain('xxPeak(')
    expect(text).toContain("'topknot'")
    expect(text).toContain('A tall misty karst peak')
  })

  it('makes safe, unique scene names', () => {
    expect(sceneSlugs(['The Intro!', 'the intro', '', 'ក្មេង'])).toEqual(['the-intro', 'the-intro-2', 'scene-3', 'scene-4'])
  })
})
