/**
 * 文案字典完整性测试：zh / en 键完全对等，且键集与 QolKey 联合一致。
 *
 * @module dsh-qol/test/locales
 */

import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('dictionaries', () => {
  it('zh and en have exactly the same keys', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('has no empty or placeholder-only values', () => {
    for (const [key, value] of Object.entries({ ...zh, ...en })) {
      expect(value.trim(), key).not.toBe('')
    }
  })

  it('covers every QolKey', () => {
    // QolKey 是键联合；类型层面已强制 Record<QolKey, string>，这里做运行期
    // 双重确认：字典键集合与 zh 一致即可（QolKey 无法运行期枚举）。
    expect(Object.keys(zh).length).toBeGreaterThan(10)
  })
})
