import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { piRoot, typePaths as paths } from './register.mjs';
const dir = mkdtempSync(join(tmpdir(), 'pi-typecheck-'));
try {
  const config = join(dir, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true,
    paths, typeRoots: [join(piRoot, 'node_modules/@types'), join(process.cwd(), 'node_modules/@types')],
  }, include: [join(process.cwd(), 'agent/extensions/**/*.ts')] }));
  const child = spawnSync(process.execPath, [join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--project', config], { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
