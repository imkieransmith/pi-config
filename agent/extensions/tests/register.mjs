import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the installed Pi APIs rather than a second package copy.
let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (true) {
  const manifest = join(root, 'package.json');
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@earendil-works/pi-coding-agent') break;
  const parent = dirname(root);
  if (parent === root) throw new Error('Cannot find the package owning the Pi executable');
  root = parent;
}
export const piRoot = root;
export const typePaths = {};
const apiPaths = Object.fromEntries(['pi-ai', 'pi-coding-agent', 'pi-tui', 'pi-agent-core'].map(name => {
  const specifier = `@earendil-works/${name}`;
  const dir = name === 'pi-coding-agent' ? piRoot : join(piRoot, 'node_modules', specifier);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = pkg.exports?.['.'];
  const imported = typeof entry === 'string' ? entry : entry?.import ?? pkg.main;
  typePaths[specifier] = [join(dir, entry?.types ?? pkg.types)];
  // Exercise the same bundled host API as the CLI. The installed unbundled
  // SDK entry imports an absent pi-server package; do not install another host.
  return [specifier, name === 'pi-coding-agent' ? join(piRoot, 'dist/bundle/index.js') : join(dir, imported)];
}));
registerHooks({
  resolve(specifier, context, next) {
    if (apiPaths[specifier] && context.parentURL?.includes('/agent/extensions/')) return next(apiPaths[specifier], context);
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/agent/extensions/')) {
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});
