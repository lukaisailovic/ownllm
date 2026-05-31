import { defineCommand } from 'citty'
import { notImplemented } from '../notImplemented'

export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Diagnose auth, endpoints, and reachability' },
  run: () => notImplemented('doctor'),
})
