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
        assert.equal(config.d1_databases[0].database_name, 'blossom-imgbed-db');
        assert.equal(config.d1_databases[0].database_id, undefined);
        assert.equal(config.r2_buckets[0].binding, 'img_r2');
        assert.equal(config.r2_buckets[0].bucket_name, 'blossom-imgbed-storage');
        assert.equal(config.vars.BLOSSOM_ENABLED, 'true');
    });

    it('uses the resource bootstrapper for every production deploy command', () => {
        assert.equal(packageJson.scripts.deploy, 'npm run deploy:cloudflare');
        assert.equal(packageJson.scripts['deploy:cloudflare'], 'node scripts/deploy-cloudflare.mjs');
        assert.equal(packageJson.scripts['deploy:worker'], 'npm run deploy:cloudflare');
    });

    it('exposes the official Deploy to Cloudflare button and secret prompts', () => {
        assert.match(read('README.md'), /deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/ganlinlaomu\/Blossom-ImgBed/);
        assert.match(read('.dev.vars.example'), /^BASIC_USER=$/m);
        assert.match(read('.dev.vars.example'), /^BASIC_PASS=$/m);
        assert.ok(packageJson.cloudflare.bindings.BASIC_PASS.description);
    });

    it('never commits the invalid production database placeholder', () => {
        assert.doesNotMatch(read('wrangler.jsonc'), /00000000-0000-0000-0000-000000000000/);
        assert.match(read('.gitignore'), /\.wrangler\/generated/);
    });

    it('matches the bindings consumed by the existing database and storage code', () => {
        assert.match(read('functions/utils/databaseAdapter.js'), /env\.img_d1/);
        assert.match(read('functions/upload/index.js'), /env\.img_r2/);
    });
});
