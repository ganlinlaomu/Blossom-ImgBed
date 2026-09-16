import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployCloudflare, DeployError } from '../../scripts/deploy-cloudflare.mjs';

const DATABASE_ID = '123e4567-e89b-42d3-a456-426614174000';
const template = {
    name: 'blossom-imgbed',
    main: 'deploy/worker/index.js',
    d1_databases: [{ binding: 'img_d1', database_name: 'blossom-imgbed-db' }],
    r2_buckets: [{ binding: 'img_r2', bucket_name: 'blossom-imgbed-storage' }]
};

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const missingBucket = () => ({ code: 1, stdout: '', stderr: 'The specified bucket does not exist. [code: 10006]' });

describe('Cloudflare resource bootstrapper', () => {
    let temporaryDirectory;

    beforeEach(async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'blossom-deploy-'));
    });

    afterEach(async () => {
        await rm(temporaryDirectory, { recursive: true, force: true });
    });

    it('creates missing D1 and R2 resources before schema and Worker deployment', async () => {
        const calls = [];
        let d1Lists = 0;
        let r2Info = 0;
        const runner = async args => {
            calls.push(args);
            const command = args.slice(0, 3).join(' ');
            if (args[0] === 'd1' && args[1] === 'list') {
                d1Lists += 1;
                return ok(JSON.stringify(d1Lists === 1 ? [] : [{ name: 'blossom-imgbed-db', uuid: DATABASE_ID }]));
            }
            if (args[0] === 'd1' && args[1] === 'create') return ok();
            if (command === 'r2 bucket info') {
                r2Info += 1;
                return r2Info === 1 ? missingBucket() : ok(JSON.stringify({ name: 'blossom-imgbed-storage' }));
            }
            if (command === 'r2 bucket create') return ok();
            if (args[0] === 'd1' && args[1] === 'execute') return ok();
            if (args[0] === 'deploy') return ok();
            throw new Error(`Unexpected command: ${args.join(' ')}`);
        };
        const generatedConfigPath = join(temporaryDirectory, 'wrangler.deploy.json');

        await deployCloudflare({
            template: structuredClone(template),
            generatedConfigPath,
            schemaPath: '/project/database/init.sql',
            runner,
            build: async () => ok(),
            log: () => {},
            env: {}
        });

        assert.ok(calls.some(args => args.join(' ') === 'd1 create blossom-imgbed-db'));
        assert.ok(calls.some(args => args.join(' ') === 'r2 bucket create blossom-imgbed-storage'));
        const schemaIndex = calls.findIndex(args => args[0] === 'd1' && args[1] === 'execute');
        const deployIndex = calls.findIndex(args => args[0] === 'deploy');
        assert.ok(schemaIndex > calls.findIndex(args => args[0] === 'r2' && args[2] === 'create'));
        assert.ok(deployIndex > schemaIndex);

        const generated = JSON.parse(await readFile(generatedConfigPath, 'utf8'));
        assert.equal(generated.d1_databases[0].binding, 'img_d1');
        assert.equal(generated.d1_databases[0].database_id, DATABASE_ID);
        assert.equal(generated.r2_buckets[0].binding, 'img_r2');
        assert.doesNotMatch(JSON.stringify(generated), /00000000-0000-0000-0000-000000000000/);
    });

    it('reuses existing resources during repeat deployments', async () => {
        const calls = [];
        const runner = async args => {
            calls.push(args);
            if (args[0] === 'd1' && args[1] === 'list') {
                return ok(JSON.stringify([{ name: 'blossom-imgbed-db', uuid: DATABASE_ID }]));
            }
            if (args.slice(0, 3).join(' ') === 'r2 bucket info') {
                return ok(JSON.stringify({ name: 'blossom-imgbed-storage' }));
            }
            if (args[0] === 'd1' && args[1] === 'execute') return ok();
            if (args[0] === 'deploy') return ok();
            throw new Error(`Unexpected command: ${args.join(' ')}`);
        };

        await deployCloudflare({
            template: structuredClone(template),
            generatedConfigPath: join(temporaryDirectory, 'wrangler.deploy.json'),
            schemaPath: '/project/database/init.sql',
            runner,
            build: async () => ok(),
            log: () => {},
            env: {}
        });

        assert.equal(calls.some(args => args[1] === 'create'), false);
        assert.equal(calls.filter(args => args[0] === 'd1' && args[1] === 'list').length, 1);
        assert.ok(calls.findIndex(args => args[0] === 'deploy') > calls.findIndex(args => args[0] === 'd1' && args[1] === 'execute'));
    });

    it('stops with an authorization hint when D1 cannot be queried', async () => {
        await assert.rejects(
            deployCloudflare({
                template: structuredClone(template),
                generatedConfigPath: join(temporaryDirectory, 'wrangler.deploy.json'),
                runner: async () => ({ code: 1, stdout: '', stderr: 'Not logged in. Run wrangler login.' }),
                build: async () => ok(),
                log: () => {},
                env: {}
            }),
            error => error instanceof DeployError
                && /D1 查询失败/.test(error.message)
                && /Cloudflare 未授权/.test(error.message)
        );
    });

    it('does not deploy when schema initialization fails', async () => {
        const calls = [];
        const runner = async args => {
            calls.push(args);
            if (args[0] === 'd1' && args[1] === 'list') {
                return ok(JSON.stringify([{ name: 'blossom-imgbed-db', uuid: DATABASE_ID }]));
            }
            if (args.slice(0, 3).join(' ') === 'r2 bucket info') {
                return ok(JSON.stringify({ name: 'blossom-imgbed-storage' }));
            }
            if (args[0] === 'd1' && args[1] === 'execute') {
                return { code: 1, stdout: '', stderr: 'SQL execution failed' };
            }
            if (args[0] === 'deploy') return ok();
            throw new Error(`Unexpected command: ${args.join(' ')}`);
        };

        await assert.rejects(
            deployCloudflare({
                template: structuredClone(template),
                generatedConfigPath: join(temporaryDirectory, 'wrangler.deploy.json'),
                schemaPath: '/project/database/init.sql',
                runner,
                build: async () => ok(),
                log: () => {},
                env: {}
            }),
            /migration\/schema initialization failed/
        );
        assert.equal(calls.some(args => args[0] === 'deploy'), false);
    });
});
