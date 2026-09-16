import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const platformPackages = new Map([
    ['darwin-arm64', '@cloudflare/workerd-darwin-arm64'],
    ['darwin-x64', '@cloudflare/workerd-darwin-64'],
    ['linux-arm64', '@cloudflare/workerd-linux-arm64'],
    ['linux-x64', '@cloudflare/workerd-linux-64'],
    ['win32-x64', '@cloudflare/workerd-windows-64']
]);

export function expectedWorkerdPackage(platform = process.platform, architecture = process.arch) {
    return platformPackages.get(`${platform}-${architecture}`) || null;
}

export function verifyWorkerdPlatform(options = {}) {
    const platform = options.platform || process.platform;
    const architecture = options.architecture || process.arch;
    const resolvePackage = options.resolvePackage || require.resolve;
    const loadManifest = options.loadManifest || (manifestPath => require(manifestPath));
    const expectedPackage = expectedWorkerdPackage(platform, architecture);

    if (!expectedPackage) {
        throw new Error(`Unsupported workerd platform: ${platform}-${architecture}.`);
    }

    let workerdManifest;
    let platformManifest;
    try {
        workerdManifest = resolvePackage('workerd/package.json');
        platformManifest = resolvePackage(`${expectedPackage}/package.json`);
    } catch (error) {
        const message = [
            `workerd platform binary is missing: ${expectedPackage}.`,
            'Install dependencies without --no-optional or --omit=optional.',
            'workerd 平台可执行包缺失；请安装 optional dependencies。',
            error.message
        ].join('\n');
        throw new Error(message, { cause: error });
    }

    const workerdVersion = loadManifest(workerdManifest).version;
    const platformVersion = loadManifest(platformManifest).version;
    if (!workerdVersion || workerdVersion !== platformVersion) {
        throw new Error(`workerd version mismatch: workerd=${workerdVersion || 'unknown'}, platform=${platformVersion || 'unknown'}.`);
    }
    return { expectedPackage, platformManifest, platformVersion, workerdManifest, workerdVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const result = verifyWorkerdPlatform();
        console.log(`workerd platform binary: ${result.expectedPackage}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
