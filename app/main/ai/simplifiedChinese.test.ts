import { describe, expect, it } from 'vitest'
import { toSimplifiedChinese } from './simplifiedChinese'

describe('toSimplifiedChinese', () => {
  it('puts Traditional lines Gemini returned into Simplified', () => {
    expect(toSimplifiedChinese(['現在, 帶我去找玄陰鼎。', '這麼多', '请。'])).toEqual(['现在, 带我去找玄阴鼎。', '这么多', '请。'])
  })
  it('leaves Japanese alone', () => {
    expect(toSimplifiedChinese(['風が強い', '東京'])).toEqual(['風が強い', '東京'])
    expect(toSimplifiedChinese(['東京'], 'ja')).toEqual(['東京'])
  })
  it('leaves non-Chinese lines as they are', () => {
    expect(toSimplifiedChinese(['សួស្តី', 'hello'])).toEqual(['សួស្តី', 'hello'])
  })
})
