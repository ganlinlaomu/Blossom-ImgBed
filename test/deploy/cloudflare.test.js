import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

describe('Cloudflare Workers Builds deployment', () => {
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

    it('initializes the complete D1 schema during one-click deployment', () => {
        assert.equal(packageJson.scripts.deploy, 'npm run deploy:cloudflare');
        assert.equal(packageJson.scripts['deploy:cloudflare'], 'node scripts/deploy-cloudflare.mjs');
        assert.match(packageJson.scripts['db:init:cloudflare'], /d1 execute img_d1 --remote/);
        assert.match(packageJson.scripts['db:init:cloudflare'], /database\/init\.sql/);
        assert.match(read('README.md'), /automatically initializes/);
        assert.match(read('README_zh.md'), /自动执行/);
    });

    it('exposes the official Deploy to Cloudflare button and secret prompts', () => {
        assert.match(read('README.md'), /deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/ganlinlaomu\/Blossom-ImgBed/);
        assert.match(read('.dev.vars.example'), /^BASIC_USER=$/m);
        assert.match(read('.dev.vars.example'), /^BASIC_PASS=$/m);
        assert.ok(packageJson.cloudflare.bindings.BASIC_PASS.description);
    });

    it('ships actionable Admin login messages for database setup failures', () => {
        const adminLoginBundle = read('frontend-dist/js/730.d1diagnostics.js');
        assert.match(adminLoginBundle, /database_not_configured/);
        assert.match(adminLoginBundle, /database_not_initialized/);
        assert.match(adminLoginBundle, /数据库尚未绑定/);
        assert.match(adminLoginBundle, /数据库尚未初始化/);
        assert.match(read('frontend-dist/js/app.1e4229a6.js'), /730:"d1diagnostics"/);
        assert.match(read('frontend-dist/index.html'), /app\.1e4229a6\.js\?v=d1-initialization/);
    });
});
