import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

describe('Cloudflare one-click deployment', () => {
    const config = JSON.parse(read('wrangler.jsonc'));
    const packageJson = JSON.parse(read('package.json'));

    it('declares a deployable Worker with assets, D1, R2, and Blossom enabled', () => {
        assert.equal(config.main, 'deploy/worker/index.js');
        assert.equal(config.assets.directory, 'frontend-dist');
        assert.equal(config.d1_databases[0].binding, 'img_d1');
        assert.equal(config.r2_buckets[0].binding, 'img_r2');
        assert.equal(config.vars.BLOSSOM_ENABLED, 'true');
    });

    it('initializes D1 by binding name before deploying', () => {
        assert.match(packageJson.scripts.deploy, /db:init:cloudflare/);
        assert.match(packageJson.scripts['db:init:cloudflare'], /d1 execute img_d1 --remote/);
        assert.match(packageJson.scripts['db:init:cloudflare'], /database\/init\.sql/);
    });

    it('exposes the official Deploy to Cloudflare button and secret prompts', () => {
        assert.match(read('README.md'), /deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/ganlinlaomu\/Blossom-ImgBed/);
        assert.match(read('.dev.vars.example'), /^BASIC_USER=$/m);
        assert.match(read('.dev.vars.example'), /^BASIC_PASS=$/m);
        assert.ok(packageJson.cloudflare.bindings.BASIC_PASS.description);
    });
});
