import pino from 'pino'

const isLocal = process.env.NODE_ENV !== 'production'

export const serializers = {
  err: pino.stdSerializers.errWithCause,
  req: pino.stdSerializers.wrapRequestSerializer(req => ({
    id: req.id,
    method: req.method,
    // strip query params from url
    url: new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname,
  })),
  res: pino.stdSerializers.wrapResponseSerializer(res => ({
    status: res.raw.statusCode,
  })),
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isLocal ? { target: 'pino-pretty' } : undefined,
  errorKey: 'error',
  serializers,
  formatters: {
    // log text for level (i.e. 'warn', 'info', etc) instead of number ('10', '20', etc)
    level: label => ({ level: label }),
  },
})

export default logger
export type Logger = typeof logger
