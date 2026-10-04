// Empaqueta las funciones de servidor (server/) en api/*.js para Vercel.
// Las dependencias de npm quedan externas: Vercel las rastrea en node_modules.
import { build } from 'esbuild'

await build({
  entryPoints: { correo: 'server/correo/entrada.ts' },
  outdir: 'api',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  banner: { js: '// GENERADO por scripts/build-api.mjs desde server/ — no editar a mano.' },
  logLevel: 'info',
})
