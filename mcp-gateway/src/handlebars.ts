import { create } from 'express-handlebars'
import type { Application } from 'express'

export default function setupHandlebars(app: Application) {
  const hbs = create({
    extname: '.hbs',

    helpers: {
      splitScope: (scope: string) => scope.split(' ').filter(Boolean),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      and: (...args: any[]) => args.slice(0, -1).every(Boolean),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      or: (...args: any[]) => args.slice(0, -1).some(Boolean),
    },
  })

  app.engine('.hbs', hbs.engine)
  app.set('view engine', '.hbs')
  app.set('views', './views')
}
