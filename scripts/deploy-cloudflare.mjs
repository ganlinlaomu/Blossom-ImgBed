import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = resolve(projectRoot, 'wrangler.jsonc');
const generatedConfigPath = resolve(projectRoot, '.wrangler/generated/wrangler.deploy.json');
const schemaPath = resolve(projectRoot, 'database/init.sql');
const wranglerPath = resolve(projectRoot, 'node_modules/wrangler/bin/wrangler.js');

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DeployError extends Error {
    constructor(message, details = '') {
        super(details ? `${message}\n${details.trim()}` : message);
        this.name = 'DeployError';
    }
}

function authHint(output) {
    if (!/auth|authori[sz]|oauth|api token|account id|login|not logged|permission|code:\s*10000/i.test(output)) {
        return '';
    }
    return 'Cloudflare 未授权 / Cloudflare authorization missing. Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.';
}

function parseJson(output, label) {
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new DeployError(
            `${label}返回了无效 JSON / ${label} returned invalid JSON.`,
            error.message
        );
    }
}

function commandDetails(result) {
    return [result.stderr, result.stdout].filter(Boolean).join('\n');
}

function throwStepFailure(zh, en, result) {
    const details = commandDetails(result);
    const authorization = authHint(details);
    throw new DeployError(`${zh} / ${en}.`, [authorization, details].filter(Boolean).join('\n'));
}

function isMissingR2Bucket(result) {
    return /not found|does not exist|NoSuchBucket|code:\s*(10006|404)|\b404\b/i.test(commandDetails(result));
}

function validateTemplate(template) {
    const d1 = template.d1_databases?.[0];
    const r2 = template.r2_buckets?.[0];
    if (!d1?.binding || !d1?.database_name) {
        throw new DeployError('D1 模板缺少 binding 或 database_name / D1 template is missing binding or database_name.');
    }
    if (!r2?.binding || !r2?.bucket_name) {
        throw new DeployError('R2 模板缺少 binding 或 bucket_name / R2 template is missing binding or bucket_name.');
    }
    if (d1.database_id) {
        throw new DeployError('公共部署模板不得包含 database_id / The public deployment template must not contain database_id.');
    }
    return { d1, r2 };
}

function databaseId(database) {
    return database?.uuid || database?.id || database?.database_id;
}

function findDatabase(databases, name) {
    if (!Array.isArray(databases)) {
        throw new DeployError('D1 列表格式无效 / Invalid D1 list response.');
    }
    return databases.find(database => database.name === name);
}

export async function defaultRunner(args, { cwd = projectRoot, echo = true } = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [wranglerPath, ...args], {
            cwd,
            env: process.env,
            stdio: ['inherit', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            const text = chunk.toString();
            stdout += text;
            if (echo) process.stdout.write(text);
        });
        child.stderr.on('data', chunk => {
            const text = chunk.toString();
            stderr += text;
            if (echo) process.stderr.write(text);
        });
        child.on('error', reject);
        child.on('close', code => resolvePromise({ code: code ?? 1, stdout, stderr }));
    });
}

async function runBuild(cwd) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, ['deploy/worker/generate-routes.js'], {
            cwd,
            env: process.env,
            stdio: 'inherit'
        });
        child.on('error', reject);
        child.on('close', code => resolvePromise({ code: code ?? 1, stdout: '', stderr: '' }));
    });
}

export async function deployCloudflare(options = {}) {
    const cwd = options.cwd || projectRoot;
    const runner = options.runner || ((args, commandOptions = {}) => defaultRunner(args, { cwd, ...commandOptions }));
    const build = options.build || (() => runBuild(cwd));
    const log = options.log || console.log;
    const configOutput = options.generatedConfigPath || generatedConfigPath;
    const schema = options.schemaPath || schemaPath;
    const env = options.env || process.env;
    const template = options.template || JSON.parse(await readFile(options.templatePath || templatePath, 'utf8'));
    const { d1, r2 } = validateTemplate(template);
    const d1Name = env.D1_DATABASE_NAME || d1.database_name;
    const r2Name = env.R2_BUCKET_NAME || r2.bucket_name;

    log(`检查 D1 数据库 ${d1Name} / Checking D1 database ${d1Name}...`);
    let result = await runner(['d1', 'list', '--json'], { echo: false });
    if (result.code !== 0) {
        throwStepFailure('D1 查询失败', 'D1 query failed', result);
    }
    let databases = parseJson(result.stdout, 'D1 list');
    let database = findDatabase(databases, d1Name);

    if (!database) {
        log(`创建 D1 数据库 ${d1Name} / Creating D1 database ${d1Name}...`);
        result = await runner(['d1', 'create', d1Name]);
        if (result.code !== 0) {
            const createFailure = result;
            result = await runner(['d1', 'list', '--json'], { echo: false });
            if (result.code !== 0) {
                throwStepFailure('D1 创建失败', 'D1 creation failed', createFailure);
            }
            databases = parseJson(result.stdout, 'D1 list');
            database = findDatabase(databases, d1Name);
            if (!database) {
                throwStepFailure('D1 创建失败', 'D1 creation failed', createFailure);
            }
        }
        if (!database) {
            result = await runner(['d1', 'list', '--json'], { echo: false });
            if (result.code !== 0) {
                throwStepFailure('D1 查询失败', 'D1 query failed', result);
            }
            databases = parseJson(result.stdout, 'D1 list');
            database = findDatabase(databases, d1Name);
        }
    } else {
        log(`复用 D1 数据库 ${d1Name} / Reusing D1 database ${d1Name}.`);
    }

    const d1Id = databaseId(database);
    if (!UUID_PATTERN.test(d1Id || '') || d1Id === ZERO_UUID) {
        throw new DeployError(`无法取得 database_id / Unable to obtain database_id for D1 database ${d1Name}.`);
    }

    log(`检查 R2 bucket ${r2Name} / Checking R2 bucket ${r2Name}...`);
    result = await runner(['r2', 'bucket', 'info', r2Name, '--json'], { echo: false });
    if (result.code !== 0 && !isMissingR2Bucket(result)) {
        throwStepFailure('R2 查询失败', 'R2 query failed', result);
    }
    if (result.code !== 0) {
        log(`创建 R2 bucket ${r2Name} / Creating R2 bucket ${r2Name}...`);
        result = await runner(['r2', 'bucket', 'create', r2Name]);
        if (result.code !== 0) {
            const retry = await runner(['r2', 'bucket', 'info', r2Name, '--json'], { echo: false });
            if (retry.code !== 0) {
                throwStepFailure('R2 创建失败', 'R2 creation failed', result);
            }
        }
        result = await runner(['r2', 'bucket', 'info', r2Name, '--json'], { echo: false });
        if (result.code !== 0) {
            throwStepFailure('R2 查询失败', 'R2 query failed after creation', result);
        }
        const bucket = parseJson(result.stdout, 'R2 bucket info');
        if (bucket.name !== r2Name) {
            throw new DeployError(`R2 查询失败 / R2 query failed: expected ${r2Name}, received ${bucket.name || 'unknown'}.`);
        }
    } else {
        const bucket = parseJson(result.stdout, 'R2 bucket info');
        if (bucket.name !== r2Name) {
            throw new DeployError(`R2 查询失败 / R2 query failed: expected ${r2Name}, received ${bucket.name || 'unknown'}.`);
        }
        log(`复用 R2 bucket ${r2Name} / Reusing R2 bucket ${r2Name}.`);
    }

    const generated = structuredClone(template);
    generated.name = env.WORKER_NAME || generated.name;
    generated.main = resolve(cwd, generated.main);
    if (generated.assets?.directory) {
        generated.assets.directory = resolve(cwd, generated.assets.directory);
    }
    generated.d1_databases[0] = { ...d1, database_name: d1Name, database_id: d1Id };
    generated.r2_buckets[0] = { ...r2, bucket_name: r2Name };
    await mkdir(dirname(configOutput), { recursive: true });
    await writeFile(configOutput, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 });
    log(`已生成临时部署配置 / Generated temporary deployment config: ${configOutput}`);

    result = await build();
    if (result.code !== 0) {
        throwStepFailure('Worker 构建失败', 'Worker build failed', result);
    }

    log('初始化远程 D1 schema / Initializing remote D1 schema...');
    result = await runner(['d1', 'execute', d1Name, '--remote', '--file', schema, '--config', configOutput, '--yes']);
    if (result.code !== 0) {
        throwStepFailure('数据库 migration/schema 初始化失败', 'Database migration/schema initialization failed', result);
    }

    log('部署 Worker / Deploying Worker...');
    result = await runner(['deploy', '--config', configOutput, '--keep-vars']);
    if (result.code !== 0) {
        throwStepFailure('Worker 部署失败', 'Worker deployment failed', result);
    }
    log('Cloudflare 部署完成 / Cloudflare deployment completed.');

    return { databaseId: d1Id, d1Name, r2Name, generatedConfigPath: configOutput };
}

async function main() {
    try {
        await deployCloudflare();
    } catch (error) {
        console.error(`\n部署已停止 / Deployment stopped:\n${error.message}`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main();
}
