import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { applyCanonicalNames, attachReferenceFaces, buildOutlinePrompt, buildScriptPrompt, finishScript, isModelUnavailableError, khmerizeNames, mergeOutlineParts, needsKhmerRepair, parseOutlinePart, planOutlineParts, validReferences } = await import('./storyRecapService')

describe('story title', () => {
  const base = { partStart: 0, partEnd: 60, segments: [], characterContext: '' }
  it('names the story and limits its use to recognising characters', () => {
    const prompt = buildOutlinePrompt({ ...base, storyTitle: '  斗破苍穹  ' })
    expect(prompt).toContain('this video is from "斗破苍穹"')
    expect(prompt).toContain('Never add, predict or explain events that are not in this video')
  })
  it('says nothing about a story when there is no title', () => {
    expect(buildOutlinePrompt({ ...base, storyTitle: '   ' })).not.toContain('STORY:')
    expect(buildOutlinePrompt(base)).not.toContain('STORY:')
  })
})

describe('reference photos', () => {
  const jpeg = 'data:image/jpeg;base64,/9j/AAAA'

  it('labels every photo of one person with one spelling', () => {
    const refs = validReferences([
      { id: '1', name: 'ឡី ទី', image: jpeg },
      { id: '2', name: 'Gu An', image: jpeg },
      { id: '3', name: 'ឡីទី', image: jpeg },
      { id: '4', name: 'gu an', image: jpeg }
    ])
    expect(refs.map((r) => r.name)).toEqual(['ឡី ទី', 'Gu An', 'ឡី ទី', 'Gu An'])
    expect(buildOutlinePrompt({ partStart: 0, partEnd: 60, segments: [], characterContext: '', referenceNames: refs.map((r) => r.name) })).toContain('Photos with the same name are the same person')
  })

  it('keeps only photos with a name and a real image, at most thirty', () => {
    const refs = validReferences([
      { id: '1', name: 'គូ អាន', image: jpeg },
      { id: '2', name: '   ', image: jpeg },
      { id: '3', name: 'ស៊ាវ នីង', image: '' },
      { id: '4', name: 'x', image: 'data:text/html;base64,PHA+' }
    ])
    expect(refs).toEqual([{ name: 'គូ អាន', mimeType: 'image/jpeg', data: '/9j/AAAA' }])
    expect(validReferences(Array.from({ length: 40 }, (_, i) => ({ id: `${i}`, name: `n${i}`, image: jpeg })))).toHaveLength(30)
  })

  it('tells Gemini which attached photo is who, and to keep those names', () => {
    const prompt = buildOutlinePrompt({ partStart: 0, partEnd: 600, segments: [], characterContext: '', referenceNames: ['គូ អាន', 'ស៊ាវ នីង'] })
    expect(prompt).toContain('Photo 1 = គូ អាន\nPhoto 2 = ស៊ាវ នីង')
    expect(prompt).toContain('use exactly these names')
    expect(buildOutlinePrompt({ partStart: 0, partEnd: 600, segments: [], characterContext: '' })).not.toContain('REFERENCE PHOTOS')
  })

  it('shows each photographed face on the matching outline character', () => {
    const outline = { characters: [{ id: 'c1', name: 'គូអាន', sourceNames: [], role: '', appearance: '' }, { id: 'c2', name: 'ឡីទី', sourceNames: [], role: '', appearance: '' }], beats: [], model: 'm' }
    const withFaces = attachReferenceFaces(outline, [{ id: 'r', name: 'គូ អាន', image: jpeg }])
    expect(withFaces.characters[0].faceImage).toBe(jpeg)
    expect(withFaces.characters[1].faceImage).toBeUndefined()
  })
})

describe('isModelUnavailableError', () => {
  it('recognises "this key cannot use that model" so the outline falls back to the standard model', () => {
    // The exact answer a key got for gemini-2.5-pro.
    expect(isModelUnavailableError(new Error('{"error":{"code":404,"message":"This model models/gemini-2.5-pro is no longer available to new users."}}'))).toBe(true)
    expect(isModelUnavailableError(new Error('PERMISSION_DENIED: model not enabled'))).toBe(true)
  })

  it('does not treat a network drop or an empty answer as an unavailable model', () => {
    expect(isModelUnavailableError(new Error('fetch failed'))).toBe(false)
    expect(isModelUnavailableError(new Error('Gemini returned no story outline for 0:00–8:31 (MAX_TOKENS).'))).toBe(false)
  })
})

const row = (start: number, end: number, text: string): { id: string; words: []; startTime: number; endTime: number; language: string; confidence: number; text: string; needsReview: boolean } =>
  ({ id: `r${start}`, words: [], startTime: start, endTime: end, language: 'zh', confidence: 1, text, needsReview: false })

describe('timing beats by their subtitle rows', () => {
  const rows = [row(520, 523, '你好'), row(530, 534, '不合格'), row(560, 565, '安哥')]

  it('takes the times of the rows a beat names, whatever seconds the model gave', () => {
    const text = JSON.stringify({ characters: [], beats: [
      { firstLine: 1, lastLine: 2, startTime: 0, endTime: 0.5, kind: 'story', characterIds: [], summary: 'ប្រឡង' },
      { firstLine: 3, lastLine: 3, startTime: 0.5, endTime: 1, kind: 'story', characterIds: [], summary: 'ឡីទីមកដល់' }
    ] })
    expect(parseOutlinePart(text, 511, 1023, rows).beats.map((b) => [b.startTime, b.endTime])).toEqual([[520, 534], [560, 565]])
  })

  it('falls back to the model seconds for a beat without dialogue, or with row numbers out of range', () => {
    const text = JSON.stringify({ characters: [], beats: [
      { firstLine: 0, lastLine: 0, startTime: 100, endTime: 130, kind: 'story', characterIds: [], summary: 'ឡើងភ្នំ' },
      { firstLine: 9, lastLine: 12, startTime: 140, endTime: 150, kind: 'story', characterIds: [], summary: 'x' }
    ] })
    expect(parseOutlinePart(text, 511, 1023, rows).beats.map((b) => [b.startTime, b.endTime])).toEqual([[611, 641], [651, 661]])
  })
})

describe('khmerizeNames', () => {
  const outline = {
    characters: [{ id: 'c1', name: '谷安', sourceNames: ['安哥'], role: 'បងប្រុស', appearance: '' }, { id: 'c2', name: 'ស៊ាវ នីង', sourceNames: ['小宁'], role: '', appearance: '' }],
    beats: [{ id: 'b1', startTime: 0, endTime: 10, kind: 'story' as const, characterIds: ['c1'], summary: 'Gu An ឡើងដើមឈើ ហើយ 谷安 ញញឹម', include: true }],
    model: 'm'
  }

  it('gives a non-Khmer name its Khmer form and swaps every spelling in the summaries', async () => {
    const asked: string[] = []
    const result = await khmerizeNames(outline, async (prompt) => {
      asked.push(prompt)
      return JSON.stringify({ names: [{ id: 'c1', khmerName: 'គូ អាន', latinSpellings: ['Gu An', 'GuAn'] }] })
    })
    expect(asked[0]).toContain('c1: 谷安')
    expect(asked[0]).not.toContain('c2:')
    expect(result.characters[0]).toMatchObject({ name: 'គូ អាន' })
    expect(result.characters[0].sourceNames).toEqual(expect.arrayContaining(['安哥', '谷安', 'Gu An']))
    expect(result.beats[0].summary).toBe('គូ អាន ឡើងដើមឈើ ហើយ គូ អាន ញញឹម')
  })

  it('keeps the outline when every name is already Khmer, or the request fails', async () => {
    const khmerOnly = { ...outline, characters: [outline.characters[1]] }
    expect(await khmerizeNames(khmerOnly, async () => { throw new Error('should not be asked') })).toBe(khmerOnly)
    expect(await khmerizeNames(outline, async () => { throw new Error('offline') })).toBe(outline)
  })
})

const guAn = { id: 'c1', name: 'គូ អាន', sourceNames: ['Gu An', '安哥', '顾安'], role: 'បងប្រុស', appearance: '' }
const ning = { id: 'c2', name: 'ស៊ាវ នីង', sourceNames: ['Xiao Ning', '小宁'], role: 'ប្អូនស្រី', appearance: '' }

describe('parseOutlinePart', () => {
  it('keeps teasers and credits out of the script by default', () => {
    const text = JSON.stringify({ characters: [guAn], beats: [
      { startTime: 0, endTime: 60, kind: 'teaser', characterIds: [], summary: 'ឈុតបង្ហាញមុន' },
      { startTime: 60, endTime: 120, kind: 'story', characterIds: ['c1'], summary: 'ក្មេងៗលេងខ្លែង' },
      { startTime: 120, endTime: 130, kind: 'credits', characterIds: [], summary: 'ចំណងជើង' },
      { startTime: 130, endTime: 170, kind: 'flashback', characterIds: ['c1'], summary: 'កាលពីក្មេង' }
    ] })
    expect(parseOutlinePart(text, 0, 200).beats.map((b) => [b.kind, b.include])).toEqual([['teaser', false], ['story', true], ['credits', false], ['flashback', true]])
  })

  it('fixes beats given in file-local time for a later part', () => {
    const text = JSON.stringify({ characters: [], beats: [{ startTime: 10, endTime: 40, kind: 'story', characterIds: [], summary: 'x' }] })
    expect(parseOutlinePart(text, 2400, 3600).beats[0]).toMatchObject({ startTime: 2410, endTime: 2440 })
  })

  it('never lets two beats claim the same stretch of time', () => {
    const text = JSON.stringify({ characters: [], beats: [
      { startTime: 0, endTime: 50, kind: 'story', characterIds: [], summary: 'a' },
      { startTime: 30, endTime: 80, kind: 'story', characterIds: [], summary: 'b' }
    ] })
    const beats = parseOutlinePart(text, 500, 700).beats
    expect(beats.map((b) => [b.startTime, b.endTime])).toEqual([[500, 530], [530, 580]])
  })

  it('keeps the complete beats of an answer that was cut off', () => {
    const text = '{"characters":[],"beats":[{"startTime":0,"endTime":20,"kind":"story","characterIds":[],"summary":"មួយ"},{"startTime":20,"endTime":4'
    expect(parseOutlinePart(text, 0, 100).beats).toHaveLength(1)
  })
})

describe('mergeOutlineParts', () => {
  it('joins parts, adds aliases found later, and numbers beats in time order', () => {
    const merged = mergeOutlineParts([
      { characters: [{ ...guAn, sourceNames: ['Gu An'] }], beats: [{ id: '', startTime: 0, endTime: 10, kind: 'story', characterIds: [], summary: 'a', include: true }] },
      { characters: [{ ...guAn, sourceNames: ['安哥'] }, ning], beats: [{ id: '', startTime: 10, endTime: 20, kind: 'story', characterIds: [], summary: 'b', include: true }] }
    ], 'm')
    expect(merged.characters).toHaveLength(2)
    expect(merged.characters[0].sourceNames).toEqual(['Gu An', '安哥'])
    expect(merged.beats.map((b) => b.id)).toEqual(['b1', 'b2'])
  })
})

describe('planOutlineParts', () => {
  it('splits into even parts of at most 12 minutes (a whole episode in one answer ran out of output)', () => {
    const episode = planOutlineParts(1534)
    expect(episode).toHaveLength(3)
    expect(episode[0].start).toBe(0)
    expect(episode[2].end).toBe(1534)
    for (const part of episode) expect(part.end - part.start).toBeLessThanOrEqual(12 * 60)
    expect(planOutlineParts(600)).toEqual([{ start: 0, end: 600 }])
  })
})

describe('script checks', () => {
  it('turns every alias into the one Khmer name', () => {
    expect(applyCanonicalNames('Gu An ហៅ 小宁 ហើយ 安哥 ញញឹម', [guAn, ning])).toBe('គូ អាន ហៅ ស៊ាវ នីង ហើយ គូ អាន ញញឹម')
  })

  it('does not touch a word that merely contains a Latin alias', () => {
    expect(applyCanonicalNames('Gu Anna', [guAn])).toBe('Gu Anna')
  })

  it('keeps "the story begins" in the opening only, and drops a repeated paragraph', () => {
    const out = finishScript([
      { beatId: 'b1', khmerNarration: 'សួស្តី។ សាច់រឿងចាប់ផ្តើមឡើង ដោយក្មេងៗលេងខ្លែង។' },
      { beatId: 'b2', khmerNarration: 'សាច់រឿងចាប់ផ្តើមឡើង ដោយ គូ អាន ឡើងដើមឈើ។' },
      { beatId: 'b3', khmerNarration: 'គូ អាន ឡើងដើមឈើ។' }
    ], [guAn])
    expect(out.map((p) => p.khmerNarration)).toEqual(['សួស្តី។ សាច់រឿងចាប់ផ្តើមឡើង ដោយក្មេងៗលេងខ្លែង។', 'គូ អាន ឡើងដើមឈើ។'])
  })

  it('flags leftover Chinese or English for the Khmer rewrite', () => {
    expect(needsKhmerRepair('ពួកគេស្រែកថា 仙人来了')).toBe(true)
    expect(needsKhmerRepair('he said hello')).toBe(true)
    expect(needsKhmerRepair('គូ អាន ញញឹម។')).toBe(false)
  })
})

describe('buildScriptPrompt', () => {
  const outline = { characters: [guAn, ning], beats: [{ id: 'b1', startTime: 60, endTime: 90, kind: 'story' as const, characterIds: ['c1'], summary: 'គូ អាន ឡើងដើមឈើ', include: true }], model: 'm' }

  it('gives the model the Khmer names, the beat and its own subtitles', () => {
    const prompt = buildScriptPrompt({ outline, beats: outline.beats, segments: [{ id: 's', words: [], startTime: 70, endTime: 72, language: 'zh', confidence: 1, text: '哥 加油', needsReview: false }], isFirstBatch: true, previousParagraphs: [] })
    expect(prompt).toContain('គូ អាន -- បងប្រុស (in the subtitles: Gu An, 安哥, 顾安)')
    expect(prompt).toContain('### b1 | 60-90s | story | គូ អាន')
    expect(prompt).toContain('[70.0-72.0] 哥 加油')
    expect(prompt).toContain('once in the whole script')
  })

  it('continues without a second welcome in later batches', () => {
    const prompt = buildScriptPrompt({ outline, beats: outline.beats, segments: [], isFirstBatch: false, previousParagraphs: ['...'] })
    expect(prompt).toContain('no welcome')
    expect(prompt).toContain('The script so far ends like this')
  })
})
