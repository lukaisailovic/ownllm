import { mkdirSync, writeFileSync } from 'node:fs'
import { defineCommand } from 'citty'
import { resolvePaths } from '../../config/paths'
import { DEFAULT_CONFIG_YAML } from '../../config/template'
import { fail, out, style } from '../../util/term'

const configInitCommand = defineCommand({
  meta: { name: 'init', description: 'Write a starter config file' },
  args: {
    force: { type: 'boolean', description: 'Overwrite an existing config file' },
  },
  run({ args }) {
    const { configDir, configFile } = resolvePaths()
    mkdirSync(configDir, { recursive: true, mode: 0o700 })

    try {
      writeFileSync(configFile, DEFAULT_CONFIG_YAML, { flag: args.force ? 'w' : 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        fail(`config already exists: ${configFile} (use --force to overwrite)`)
        process.exit(1)
      }
      throw error
    }

    out.status('ok', `wrote ${configFile}`)
    out.line(style.dim(`  config dir: ${configDir}`))
  },
})

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Manage configuration' },
  subCommands: { init: configInitCommand },
})
