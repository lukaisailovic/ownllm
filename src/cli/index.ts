import { defineCommand } from 'citty'
import { DESCRIPTION, NAME, VERSION } from '../meta'
import { authCommand } from './commands/auth'
import { configCommand } from './commands/config'
import { doctorCommand } from './commands/doctor'
import { modelsCommand } from './commands/models'
import { serveCommand } from './commands/serve'

export const mainCommand = defineCommand({
  meta: { name: NAME, version: VERSION, description: DESCRIPTION },
  subCommands: {
    serve: serveCommand,
    auth: authCommand,
    models: modelsCommand,
    config: configCommand,
    doctor: doctorCommand,
  },
})
