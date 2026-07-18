import { describe, it, expect } from 'vitest'
import {
  httpUrl,
  httpsUrl,
  regexPattern,
  regexPatternList,
  duration,
  scope,
  withEnabled,
} from '~/zod-utils'
import { z } from 'zod/v4'

describe('httpUrl', () => {
  it('accepts http URLs', () => {
    expect(httpUrl.safeParse('http://example.com').success).toBe(true)
  })

  it('accepts https URLs', () => {
    expect(httpUrl.safeParse('https://example.com').success).toBe(true)
  })

  it('rejects ftp and other protocols', () => {
    expect(httpUrl.safeParse('ftp://example.com').success).toBe(false)
  })

  it('rejects plain strings', () => {
    expect(httpUrl.safeParse('not-a-url').success).toBe(false)
  })
})

describe('httpsUrl', () => {
  it('accepts https URLs', () => {
    expect(httpsUrl.safeParse('https://example.com/path').success).toBe(true)
  })

  it('rejects http URLs', () => {
    expect(httpsUrl.safeParse('http://example.com').success).toBe(false)
  })
})

describe('regexPattern', () => {
  it('parses a valid regex string into a RegExp', () => {
    const result = regexPattern.parse('^hello$')
    expect(result).toBeInstanceOf(RegExp)
    expect(result.source).toBe('^hello$')
  })

  it('rejects an invalid regex string', () => {
    expect(regexPattern.safeParse('[invalid').success).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(regexPattern.safeParse('').success).toBe(false)
  })
})

describe('regexPatternList', () => {
  it('combines multiple regex patterns into a single RegExp', () => {
    const combined = regexPatternList(false).parse(['^foo', '^bar'])
    expect(combined).toBeInstanceOf(RegExp)
    expect(combined.test('foobar')).toBe(true)
    expect(combined.test('barfoo')).toBe(true)
    expect(combined.test('baz')).toBe(false)
  })

  it('rejects an empty array', () => {
    expect(regexPatternList(false).safeParse([]).success).toBe(false)
  })

  it('allows single string regex', () => {
    const single = regexPatternList(false).parse('^single$')
    expect(single).toBeInstanceOf(RegExp)
    expect(single.test('single')).toBe(true)
    expect(single.test('not single')).toBe(false)
  })

  it('if allowLoopbackLiteral is true, accepts "loopback" as a special pattern', () => {
    const loopback = regexPatternList(true).parse('loopback')
    expect(loopback).toBeInstanceOf(RegExp)
    expect(loopback.test('http://localhost')).toBe(true)
    expect(loopback.test('http://127.0.0.1:1234/asdf')).toBe(true)
    expect(loopback.test('http://[::1]/foo')).toBe(true)
    expect(loopback.test('http://example.com')).toBe(false)
  })
})

describe('duration', () => {
  it('parses valid ms-compatible strings to milliseconds', () => {
    expect(duration.parse('1s')).toBe(1000)
    expect(duration.parse('5m')).toBe(300000)
    expect(duration.parse('1h')).toBe(3600000)
    expect(duration.parse('1d')).toBe(86400000)
  })

  it('rejects strings that are not valid duration formats', () => {
    expect(duration.safeParse('notaduration').success).toBe(false)
    expect(duration.safeParse('').success).toBe(false)
  })
})

describe('scope', () => {
  it('splits a space-separated string into an array', () => {
    expect(scope.parse('openid profile email')).toEqual([
      'openid',
      'profile',
      'email',
    ])
  })

  it('passes through an array of strings unchanged', () => {
    expect(scope.parse(['openid', 'profile'])).toEqual(['openid', 'profile'])
  })

  it('handles a single scope string', () => {
    expect(scope.parse('openid')).toEqual(['openid'])
  })

  it('rejects empty arrays', () => {
    expect(scope.safeParse([]).success).toBe(false)
  })

  it('rejects empty strings', () => {
    expect(scope.safeParse('').success).toBe(false)
  })
})

describe('withEnabled', () => {
  const inner = z.object({ name: z.string().nonempty() })

  it('returns enabled:true with all fields when enabled is true', () => {
    const schema = withEnabled(inner)
    const result = schema.parse({ enabled: true, name: 'foo' })
    expect(result).toEqual({ enabled: true, name: 'foo' })
  })

  it('returns enabled:false with partial fields when enabled is false', () => {
    const schema = withEnabled(inner)
    const result = schema.parse({ enabled: false })
    expect(result.enabled).toBe(false)
  })

  it('throws when enabled is true but required inner fields are missing', () => {
    const schema = withEnabled(inner)
    expect(schema.safeParse({ enabled: true }).success).toBe(false)
  })

  it('defaults enabled to true when not provided', () => {
    const schema = withEnabled(inner)
    const result = schema.parse({ name: 'bar' })
    expect(result.enabled).toBe(true)
  })

  it('respects a custom defaultEnabled=false', () => {
    const schema = withEnabled(inner, false)
    const result = schema.parse({})
    expect(result.enabled).toBe(false)
  })
})
