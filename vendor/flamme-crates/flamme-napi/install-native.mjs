/**
 * Builds the napi module and installs it where `@flamme/core` loads it from.
 *
 *   pnpm build:native            # release build (the default)
 *   pnpm build:native --debug    # debug build, for a fast edit/test loop
 *
 * `cargo build` produces a cdylib; Node loads a cdylib whose extension is `.node`,
 * so the artifact is copied to `packages/core/native/flamme.node` (gitignored).
 * The build is reproducible from a clean checkout: `cargo` resolves the pinned
 * toolchain from `rust-toolchain.toml` and the crate versions from `Cargo.lock`.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const TARGET = join(REPO, 'packages/core/native/flamme.node');
const debug = process.argv.includes('--debug');
const profile = debug ? 'debug' : 'release';

execFileSync('cargo', ['build', '-p', 'flamme-napi', ...(debug ? [] : ['--release'])], {
  cwd: REPO,
  stdio: 'inherit',
});

const candidates = {
  linux: 'libflamme_napi.so',
  darwin: 'libflamme_napi.dylib',
  win32: 'flamme_napi.dll',
};
const name = candidates[process.platform];
if (name === undefined) {
  throw new Error(`flamme: unsupported platform ${process.platform}`);
}
const built = join(REPO, 'target', profile, name);
mkdirSync(dirname(TARGET), { recursive: true });
rmSync(TARGET, { force: true });
copyFileSync(built, TARGET);
process.stdout.write(`flamme: native module at ${TARGET}\n`);
