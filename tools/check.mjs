/**
 * 静态检查：逐个导入模块（同时验证语法与依赖关系），并校验仓库内 JSON 文件。
 * index.js 会在导入时启动扩展，因此只做静态读取。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skipDirs = new Set(['node_modules', '.git', '.test-output', '归档']);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (skipDirs.has(name)) continue;
        const full = join(dir, name);
        const info = statSync(full);
        if (info.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const files = walk(root);
const problems = [];
const modules = files.filter(file => file.endsWith('.js') || file.endsWith('.mjs'));

for (const file of modules) {
    const rel = relative(root, file).replace(/\\/g, '/');
    // 工具与测试脚本由 npm script 单独运行；导入自身会造成循环等待。
    if (rel.startsWith('tools/') || rel.startsWith('tests/')) continue;
    if (rel === 'index.js') {
        const text = readFileSync(file, 'utf8');
        if (!/import\s+\{\s*boot\s*\}/.test(text) || !/boot\(\)/.test(text)) {
            problems.push(`${rel}: 入口文件未按约定调用 boot()`);
        }
        continue;
    }
    try {
        await import(pathToFileURL(file).href);
        console.log(`  ✓ ${rel}`);
    } catch (error) {
        problems.push(`${rel}: ${error?.message ?? error}`);
        console.log(`  ✗ ${rel}`);
    }
}

const jsonFiles = files.filter(file => file.endsWith('.json'));
for (const file of jsonFiles) {
    const rel = relative(root, file).replace(/\\/g, '/');
    try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (rel === 'manifest.json') {
            for (const key of ['display_name', 'js', 'author', 'version']) {
                if (!data[key]) problems.push(`manifest.json 缺少必需字段 ${key}`);
            }
        }
        if (rel.startsWith('profiles/')) {
            if (data.kind !== 'tauritavern.agentProfile') problems.push(`${rel}: kind 不是 tauritavern.agentProfile`);
            if (!/^[a-z0-9\-_]{1,128}$/.test(data.id ?? '')) problems.push(`${rel}: id 不符合命名规范`);
            const artifacts = data.output?.artifacts ?? [];
            if (!artifacts.some(item => item.target === 'messageBody')) {
                problems.push(`${rel}: output.artifacts 必须包含 target=messageBody 的产物`);
            }
            const visible = new Set(data.workspace?.visibleRoots ?? []);
            for (const rootName of data.workspace?.writableRoots ?? []) {
                if (!visible.has(rootName)) problems.push(`${rel}: writableRoots 中的 ${rootName} 不在 visibleRoots 内`);
            }
        }
        console.log(`  ✓ ${rel}`);
    } catch (error) {
        problems.push(`${rel}: JSON 解析失败 — ${error?.message ?? error}`);
        console.log(`  ✗ ${rel}`);
    }
}

const skillFile = join(root, 'skills', 'interactive-fiction', 'SKILL.md');
try {
    const text = readFileSync(skillFile, 'utf8');
    if (!text.startsWith('---')) problems.push('skills/interactive-fiction/SKILL.md 缺少 YAML frontmatter');
    if (!/\nname:\s*\S/.test(text) || !/\ndescription:\s*\S/.test(text)) {
        problems.push('skills/interactive-fiction/SKILL.md frontmatter 必须包含 name 与 description');
    }
    console.log('  ✓ skills/interactive-fiction/SKILL.md');
} catch (error) {
    problems.push(`skills/interactive-fiction/SKILL.md: ${error?.message ?? error}`);
}

console.log('');
if (problems.length) {
    console.error(`检查未通过（${problems.length} 项）：`);
    for (const item of problems) console.error(`  - ${item}`);
    process.exitCode = 1;
} else {
    console.log(`全部检查通过：${modules.length} 个模块、${jsonFiles.length} 个 JSON、1 个 Skill。`);
}
