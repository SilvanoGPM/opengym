import { describe, expect, it } from 'vitest'
import { parseMarkdown, spansOf } from './md.js'

const textOf = spans => spans.map(s => s.text).join('')

describe('spansOf', () => {
  it('finds bold in both spellings', () => {
    expect(spansOf('lift **heavy** things')).toEqual([
      { text: 'lift ' }, { text: 'heavy', bold: true }, { text: ' things' }
    ])
    expect(spansOf('__also__ this')).toEqual([{ text: 'also', bold: true }, { text: ' this' }])
  })

  it('finds inline code', () => {
    expect(spansOf('use `3x5` here')).toEqual([
      { text: 'use ' }, { text: '3x5', code: true }, { text: ' here' }
    ])
  })

  it('leaves a lone asterisk alone', () => {
    expect(spansOf('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }])
  })

  it('never returns nothing', () => {
    expect(spansOf('')).toEqual([{ text: '' }])
  })
})

describe('parseMarkdown', () => {
  it('reads headings at every level it supports', () => {
    const b = parseMarkdown('# One\n### Three')
    expect(b.map(x => x.level)).toEqual([1, 3])
    expect(textOf(b[0].spans)).toBe('One')
  })

  it('joins wrapped lines into one paragraph', () => {
    const b = parseMarkdown('a line\nand its continuation\n\na second paragraph')
    expect(b.length).toBe(2)
    expect(textOf(b[0].spans)).toBe('a line and its continuation')
  })

  it('collects bullets into one list', () => {
    const b = parseMarkdown('- squat\n- bench\n* deadlift')
    expect(b.length).toBe(1)
    expect(b[0].type).toBe('ul')
    expect(b[0].items.map(textOf)).toEqual(['squat', 'bench', 'deadlift'])
  })

  it('keeps a numbered list separate from a bulleted one', () => {
    const b = parseMarkdown('- a\n1. b')
    expect(b.map(x => x.type)).toEqual(['ul', 'ol'])
  })

  it('accepts both 1. and 1) numbering', () => {
    expect(parseMarkdown('1) first\n2) second')[0].items.length).toBe(2)
  })

  it('keeps bold inside a list item', () => {
    const b = parseMarkdown('- **squat** first')
    expect(b[0].items[0][0]).toEqual({ text: 'squat', bold: true })
  })

  it('does not turn a paragraph and a list into one block', () => {
    const b = parseMarkdown('Here is the plan:\n- squat\nAnd a closing thought.')
    expect(b.map(x => x.type)).toEqual(['p', 'ul', 'p'])
  })

  it('produces no HTML, whatever it is given', () => {
    // The whole reason this parses to a structure: the input is a language model's output, and
    // there must be no route from it to innerHTML. Markup arrives as text and stays text.
    const b = parseMarkdown('<img src=x onerror=alert(1)>\n\n- <script>bad()</script>')
    expect(textOf(b[0].spans)).toBe('<img src=x onerror=alert(1)>')
    expect(textOf(b[1].items[0])).toBe('<script>bad()</script>')
    expect(JSON.stringify(b)).not.toContain('innerHTML')
  })

  it('is empty for empty input rather than throwing', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown(null)).toEqual([])
    expect(parseMarkdown(undefined)).toEqual([])
    expect(parseMarkdown('   \n\n  ')).toEqual([])
  })

  it('reads a whole answer the shape a model actually writes one', () => {
    const b = parseMarkdown([
      '## How that session went',
      '',
      'Solid work. Volume was **up 8%** on last week.',
      '',
      '- Squat moved well',
      '- Bench stalled at `80 kg`',
      '',
      'Next time, drop the bench to 75.'
    ].join('\n'))
    expect(b.map(x => x.type)).toEqual(['h', 'p', 'ul', 'p'])
    expect(b[2].items.length).toBe(2)
  })
})
