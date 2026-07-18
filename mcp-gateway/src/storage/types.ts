import type { z } from 'zod/v4'

export interface TypedStorage<Schema extends z.ZodType = z.ZodType> {
  withSchema<NewSchema extends z.ZodType>(
    schema: NewSchema
  ): TypedStorage<NewSchema>

  has(key: string): Promise<boolean>
  get(key: string): Promise<z.infer<Schema> | null>
  set(key: string, value: z.infer<Schema>, ttlMs: number): Promise<void>
  refresh(key: string, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
}
