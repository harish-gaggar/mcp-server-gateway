import { z } from 'zod/v4'
import ms, { StringValue } from 'ms'

export const httpUrl = z.url({
  protocol: /^https?$/,
  hostname: z.regexes.hostname,
})

export const httpsUrl = z.url({
  protocol: /^https$/,
  hostname: z.regexes.hostname,
})

// a zod transformer that validates a string as a regular expression and returns the RegExp object
// NOTE: this is not safe to use with untrusted user input, this SHOULD ONLY BE
// USED FOR CONFIG FILES
export const regexPattern = z
  .string()
  .nonempty()
  .transform((s, ctx) => {
    try {
      return new RegExp(s)
    } catch (e) {
      ctx.issues.push({
        code: 'invalid_format',
        format: 'regex',
        message: `Invalid regular expression: ${(e as Error).message}`,
        input: s,
      })

      return z.NEVER
    }
  })

const loopbackRegex = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/
// specific constant that is converted to a regex that matches loopback URLs,
// to make it easier for users to specify "loopback" in their config without
// having to write a regex themselves
const loopbackLiteral = z.literal('loopback').transform(() => loopbackRegex)

// like regexPattern, but takes an array of regex strings and combines them into
// a single regex that matches if any of the patterns match
export function regexPatternList(allowLoopbackLiteral = false) {
  const pattern = allowLoopbackLiteral
    ? z.union([loopbackLiteral, regexPattern])
    : regexPattern

  const arrayPattern = z
    .array(pattern)
    .nonempty()
    .transform(list => {
      const source = list.map(r => r.source).join('|')
      return new RegExp(`(?:${source})`)
    })

  return pattern.or(arrayPattern)
}

// a zod transformer that validates a string as a duration and returns the duration in milliseconds
export const duration = z
  .custom<StringValue>(v => {
    if (typeof v !== 'string') return false
    try {
      return ms(v as StringValue) !== undefined
    } catch {
      return false
    }
  })
  .transform(ms)

// supports a space-separated string or list of strings, returns a list of strings
export const scope = z.union([
  z
    .string()
    .nonempty()
    .transform(s => s.split(' ').filter(Boolean)),
  z.array(z.string().nonempty()).nonempty(),
])

/**
 * A helper function that returns a wrapped schema with an additional `enabled` boolean field. The returned schema will
 * require the `enabled` field, and all other fields will be optional. This is useful for config sections that can be
 * enabled or disabled, where we want to allow users to omit the config entirely when disabled, but require the `enabled` field to be explicitly set to `true` when the config is present.
 */
export function withEnabled<T extends z.ZodObject>(
  schema: T,
  defaultEnabled = true
) {
  const partial = schema.partial()

  type Result =
    | ({ enabled: false } & Partial<z.infer<T>>)
    | ({ enabled: true } & z.infer<T>)

  // use looseObject to allow underlying schema fields to be passed through
  return z
    .looseObject({ enabled: z.boolean().default(defaultEnabled) })
    .transform(({ enabled, ...rest }, ctx): Result => {
      const result = enabled ? schema.safeParse(rest) : partial.safeParse(rest)
      if (!result.success) {
        for (const issue of result.error.issues) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx.issues.push(issue as any)
        }
        return z.NEVER
      }

      return { enabled, ...result.data } as Result
    })
}
