import yaml from 'yaml'
import { readFile } from 'node:fs/promises'
import { config } from 'dotenv'
import { z } from 'zod/v4'

// preload env files
config({ path: ['.env', '.env.local'], override: true })

const envRegex = /["']?\$\{(\w+)(?::-([^}\s]*))?\}["']?/g

/**
 * Replaces ${VAR_NAME} or ${VAR_NAME:-default} in the given string with
 * the corresponding environment variable value or the default value if provided.
 * If errUndefined is true, throws an error if an environment variable is not defined and no
 * default value is provided.
 *
 * The rendered final value will be wrapped in quotes to ensure it's treated as a string in YAML or JSON
 */
export function envSubst(fileContents: string, errUndefined = true) {
  return fileContents.replace(
    envRegex,
    (_: string, varName: string, defaultVal?: string) => {
      const value = process.env[varName] ?? defaultVal

      if (value === undefined && errUndefined) {
        throw new Error(`Environment variable ${varName} is not defined`)
      }

      // ensure all newlines are properly escaped in the final rendered value,
      // since the value will be injected into a YAML or JSON file
      const normalizedValue = (value ?? '').replace(/\n/g, '\\n')
      return `"${normalizedValue}"`
    }
  )
}

/**
 * Loads a configuration file from a given filepath, parsing it with a given schema.
 * The file can be in YAML or JSON format, and can contain environment variable
 * placeholders in the form of ${VAR_NAME} or ${VAR_NAME:-default}.
 */
export async function loadConfig<T extends z.ZodType>(
  schema: T,
  filePath: string
): Promise<z.infer<T>> {
  const fileContents = await readFile(filePath, 'utf-8')
  const renderedContents = envSubst(fileContents)
  const parsed = yaml.parse(renderedContents)

  return await schema.parseAsync(parsed)
}

/**
 * Custom Zod schema that either processes a field using a given schema,
 * or treats the field as a file path and loads the config from that file using the given schema.
 */
export function fileOrSchema<T extends z.ZodType>(schema: T) {
  const filePath = z
    .string()
    .startsWith('file:')
    .transform(async (val, ctx) => {
      // strip quotes at start/end of filepath in case the filepath was
      // injected via env var
      const path = val
        .slice(5)
        .replace(/^["']?/, '')
        .replace(/["']?$/, '')

      try {
        return await loadConfig(schema, path)
      } catch (e) {
        ctx.issues.push({
          code: 'custom',
          message: `Failed to load config from file ${path}: ${(e as Error).message}`,
          input: val,
        })
        return z.NEVER
      }
    })

  return z.union([schema, filePath])
}
