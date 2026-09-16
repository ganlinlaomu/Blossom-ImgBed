import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expectedWorkerdPackage, verifyWorkerdPlatform } from '../../scripts/check-workerd-platform.mjs';

const root = new URL('../../', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

describe('workerd platform dependency', () => {
    it('maps Cloudflare Linux x64 to its optional workerd package', () => {
        assert.equal(expectedWorkerdPackage('linux', 'x64'), '@cloudflare/workerd-linux-64');
        assert.equal(expectedWorkerdPackage('linux', 'arm64'), '@cloudflare/workerd-linux-arm64');
    });

    it('fails clearly when the current platform binary is absent', () => {
        assert.throws(
            () => verifyWorkerdPlatform({
                platform: 'linux',
                architecture: 'x64',
                resolvePackage: specifier => {
                    if (specifier === 'workerd/package.json') return '/workerd/package.json';
                    throw new Error(`Cannot find ${specifier}`);
                }
            }),
            error => /workerd platform binary is missing/.test(error.message)
                && /without --no-optional or --omit=optional/.test(error.message)
        );
    });

    it('keeps Wrangler pinned and workerd as a transitive optional dependency', () => {
        const packageJson = readJson('package.json');
        const lock = readJson('package-lock.json');
        const workerd = lock.packages['node_modules/workerd'];
        const linux = lock.packages['node_modules/@cloudflare/workerd-linux-64'];

        assert.equal(packageJson.packageManager, 'npm@10.9.2');
        assert.equal(packageJson.engines.node, '>=20 <23');
        assert.equal(packageJson.devDependencies.wrangler, '4.110.0');
        assert.equal(packageJson.devDependencies.miniflare, undefined);
        assert.equal(packageJson.devDependencies.workerd, undefined);
        assert.equal(linux.optional, true);
        assert.deepEqual(linux.os, ['linux']);
        assert.deepEqual(linux.cpu, ['x64']);
        assert.equal(linux.version, workerd.version);
    });
});
