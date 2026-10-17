/**
 * 轻量测试运行器（无第三方依赖）。
 * 覆盖：条目推导、质量校验、字段映射、任务分类、设置合并。
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
    toFlatEntry,
    fromFlatEntry,
    POSITION_NUM,
    SELECTIVE_LOGIC_NUM,
} from '../src/worldbook/spec.js';
import { deriveStrategy, derivePosition, deriveOrder, deriveAll, thresholdOf } from '../src/worldbook/derive.js';
import { lintKeywords, lintContent, lintEntry, lintBook, formatIssues } from '../src/worldbook/lint.js';
import { buildEntries, normalizeGenerated, memoryEntriesFrom } from '../src/worldbook/builder.js';
import { quickRoute, TASK } from '../src/core/router.js';
import { mergeDefaults, DEFAULTS } from '../src/config.js';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/* ------------------------------------------------------------ 规范与映射 */

test('position 数字枚举与 SillyTavern 一致', () => {
    assert.equal(POSITION_NUM.before_character_definition, 0);
    assert.equal(POSITION_NUM.after_character_definition, 1);
    assert.equal(POSITION_NUM.at_depth, 4);
    assert.equal(POSITION_NUM.after_example_messages, 6);
    assert.equal(SELECTIVE_LOGIC_NUM.and_any, 0);
    assert.equal(SELECTIVE_LOGIC_NUM.and_all, 3);
});

test('扁平条目往返转换保持关键字段', () => {
    const entry = {
        name: '坡子口',
        content: '类型: 聚落\n人口: 以凡人为主',
        keys: ['坡子口'],
        secondaryKeys: ['码头'],
        selectiveLogic: 'and_all',
        constant: false,
        position: 'after_character_definition',
        order: 25,
        probability: 90,
        enabled: true,
    };
    const flat = toFlatEntry(entry, 3);
    assert.equal(flat.comment, '坡子口');
    assert.deepEqual(flat.key, ['坡子口']);
    assert.deepEqual(flat.keysecondary, ['码头']);
    assert.equal(flat.position, 1);
    assert.equal(flat.selectiveLogic, 3);
    assert.equal(flat.selective, true);
    assert.equal(flat.disable, false);
    assert.equal(flat.order, 25);

    const back = fromFlatEntry(flat, 3);
    assert.equal(back.name, '坡子口');
    assert.equal(back.position, 'after_character_definition');
    assert.equal(back.selectiveLogic, 'and_all');
    assert.equal(back.order, 25);
    assert.equal(back.constant, false);
});

test('常驻条目在扁平格式里不启用绿灯', () => {
    const flat = toFlatEntry({ name: '世界规则', content: 'x', keys: ['灵气'], constant: true });
    assert.equal(flat.constant, true);
    assert.equal(flat.selective, false);
});

/* ------------------------------------------------------------ 策略推导 */

const sib = (type, part, extra = {}) => ({ type, part, keys: ['x'], ...extra });

test('世界观恒为常驻（蓝灯）', () => {
    assert.equal(deriveStrategy(sib('世界观', ''), []), 'constant');
    assert.equal(thresholdOf('世界观'), Infinity);
});

test('NPC 恒为绿灯', () => {
    assert.equal(deriveStrategy(sib('NPC', ''), []), 'selective');
});

test('角色 basic 达到阈值后才转绿灯', () => {
    const four = [sib('角色', 'basic'), sib('角色', 'basic'), sib('角色', 'basic'), sib('角色', 'basic')];
    assert.equal(deriveStrategy(four[0], four), 'constant');
    const five = [...four, sib('角色', 'basic')];
    assert.equal(deriveStrategy(five[0], five), 'selective');
});

test('速览级与重述级不参与阈值计数', () => {
    const list = [
        sib('角色', 'basic'),
        sib('角色', 'basic', { scope: 'catalog' }),
        sib('角色', 'basic', { rephrase: true }),
        sib('角色', 'basic'),
    ];
    assert.equal(deriveStrategy(list[0], list), 'constant');
});

test('位置推导：按类型分组，重述强制 at_depth', () => {
    assert.equal(derivePosition(sib('世界观', '')), 'before_character_definition');
    assert.equal(derivePosition(sib('地理', 'region')), 'before_character_definition');
    assert.equal(derivePosition(sib('角色', 'basic')), 'after_character_definition');
    assert.equal(derivePosition(sib('事件', '')), 'at_depth');
    assert.equal(derivePosition(sib('角色', 'basic', { rephrase: true })), 'at_depth');
});

test('order 十位分组递增，重述逆序追加末尾', () => {
    const entries = [
        { type: '角色', part: 'basic', name: 'a' },
        { type: '角色', part: 'basic', name: 'b' },
        { type: '世界观', part: '', name: 'c' },
        { type: '地理', part: 'region', name: 'd' },
        { type: '角色', part: 'basic', name: 'r1', rephrase: true },
        { type: '角色', part: 'basic', name: 'r2', rephrase: true },
    ];
    deriveOrder(entries);
    const byName = Object.fromEntries(entries.map(entry => [entry.name, entry.order]));
    assert.ok(byName.d < byName.c, 'before_char 组内按 part 排序');
    assert.ok(byName.c < byName.a, 'before_char 整体早于 after_char');
    assert.ok(byName.a < byName.b);
    assert.ok(byName.r1 > byName.b && byName.r2 > byName.b, '重述条目在末尾');
    assert.ok(byName.r2 < byName.r1, '重述条目逆序追加');
});

test('deriveAll 补齐开关、位置与深度', () => {
    const entries = [{ type: '事件', part: '', name: 'e', content: 'x', keys: ['事件甲'] }];
    deriveAll(entries);
    assert.equal(entries[0].enabled, true);
    assert.equal(entries[0].position, 'at_depth');
    assert.equal(entries[0].depth, 0);
    assert.equal(entries[0].role, 'system');
    assert.equal(entries[0].constant, false);
});

/* ------------------------------------------------------------ 质量校验 */

test('单个汉字关键词被拒绝', () => {
    const issues = lintKeywords(['樱'], { type: '角色', name: '桃宫樱_基础信息' });
    assert.ok(issues.some(item => item.code === 'KW_SINGLE_CJK' && item.level === 'error'));
});

test('泛用职务与成语关键词被警告', () => {
    assert.ok(lintKeywords(['老师']).some(item => item.code === 'KW_GENERIC'));
    assert.ok(lintKeywords(['倾国倾城']).some(item => item.code === 'KW_IDIOM'));
});

test('人物条目关键词须包含人物名', () => {
    const issues = lintKeywords(['小樱'], { type: '角色', name: '桃宫樱_基础信息' });
    assert.ok(issues.some(item => item.code === 'KW_NAME_MISSING'));
});

test('破折号被视为错误', () => {
    const issues = lintContent({ name: 'x', content: '他停住了——然后转身。' });
    assert.ok(issues.some(item => item.code === 'DASH' && item.level === 'error'));
});

test('元叙事泄漏是错误', () => {
    const issues = lintContent({ name: 'x', content: 'AI 写作要点：这里要突出反差。' });
    assert.ok(issues.some(item => item.code === 'META_LEAK' && item.level === 'error'));
});

test('占位符与繁体字被警告', () => {
    assert.ok(lintContent({ name: 'x', content: '主角来自某城市，具体待定。' }).some(item => item.code === 'PLACEHOLDER'));
    assert.ok(lintContent({ name: 'x', content: '她住在宮中，喜愛櫻花。' }).some(item => item.code === 'TRADITIONAL'));
});

test('八股表达被警告', () => {
    assert.ok(lintContent({ name: 'x', content: '他嘴角微微上扬，眼中闪过一丝冷意。' }).some(item => item.code === 'CLICHE'));
});

test('跨条目引用被警告', () => {
    assert.ok(lintContent({ name: 'x', content: '势力构成详见「合欢宗」条目。' }).some(item => item.code === 'CROSS_REFERENCE'));
});

test('既非常驻又无关键词是错误', () => {
    const issues = lintEntry({ name: 'x', type: 'NPC', content: '一名路人，负责传话。', keys: [], constant: false });
    assert.ok(issues.some(item => item.code === 'NO_TRIGGER' && item.level === 'error'));
});

test('整本校验能发现重名条目', () => {
    const result = lintBook([
        { name: '同名', type: 'NPC', content: '甲，负责开门。', keys: ['门房甲'], constant: false },
        { name: '同名', type: 'NPC', content: '乙，负责关门。', keys: ['门房乙'], constant: false },
    ]);
    assert.ok(result.errors.some(item => item.code === 'NAME_DUPLICATE'));
    assert.equal(result.ok, false);
    assert.ok(formatIssues(result).length > 0);
});

/* ------------------------------------------------------------ 装配 */

test('normalizeGenerated 容忍缺字段并回退类型', () => {
    const entry = normalizeGenerated({ name: '张婆', content: 'x' }, { type: 'NPC' });
    assert.equal(entry.type, 'NPC');
    assert.equal(entry.name, '张婆');
    assert.equal(entry.enabled, true);
});

test('buildEntries 完成推导并给出校验结果', () => {
    const { entries, lint, notes } = buildEntries([
        { type: '地理', part: 'region', name: '坡子口', abstract: '凡人聚落', content: '类型: 聚落\n人口: 以凡人为主', keywords: ['坡子口', '坡子口码头'] },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].constant, true, '地理 region 未达阈值应为常驻');
    assert.equal(entries[0].position, 'before_character_definition');
    assert.ok(Number.isFinite(entries[0].order));
    assert.equal(lint.errors.length, 0, notes.join('\n'));
});

test('记忆条目使用固定名称且为常驻', () => {
    const entries = memoryEntriesFrom({
        summary: '主角来到坡子口催租。',
        scene: '坡子口 · 张婆家院子',
        characters: ['柳如烟：被张婆催促离开'],
        threads: ['租金来源未明'],
        facts_removed: [],
    });
    assert.ok(entries.length >= 4);
    assert.ok(entries.every(entry => entry.constant === true && entry.position === 'at_depth'));
    assert.ok(entries.some(entry => entry.name.includes('剧情摘要')));
});

/* ------------------------------------------------------------ 任务分类 */

test('编辑指令分类符合预期', () => {
    assert.equal(quickRoute('把刚才那段改得更自然').task, TASK.PROSE_REVISE);
    assert.equal(quickRoute('创建一个合欢宗长老，女性，年约四十').task, TASK.CHARACTER_CREATE);
    assert.equal(quickRoute('收录张婆').task, TASK.WORLDBOOK_WRITE);
    assert.equal(quickRoute('根据目前剧情整理坡子口和张婆的设定，写入世界书').task, TASK.WORLDBOOK_WRITE);
    assert.equal(quickRoute('总结一下目前已经发生的主要事件，顺便检查有没有矛盾').task, TASK.MEMORY_SUMMARIZE);
    assert.equal(quickRoute('突然下雨，张婆一反常态地走进雨中').task, TASK.PROSE_GENERATE);
    assert.equal(quickRoute('继续演绎我刚刚给出的剧情').task, TASK.PROSE_GENERATE);
});

test('修改人物时无法确定作用域则降低置信度', () => {
    const ambiguous = quickRoute('柳如烟不要那么冷漠，应该更善于伪装');
    assert.equal(ambiguous.task, TASK.CHARACTER_UPDATE);
    assert.equal(ambiguous.scope, 'unknown');
    assert.ok(ambiguous.confidence < 0.6, '应交给模型判定');

    const explicit = quickRoute('柳如烟的人设改成善于伪装');
    assert.equal(explicit.scope, 'setting');
});

test('否定事实会被标记为需要同步纠错', () => {
    assert.equal(quickRoute('坡子口只是普通凡人聚居区，不存在大量修仙高手').needs_fact_fix, true);
});

test('引用式修改能识别目标范围', () => {
    assert.equal(quickRoute('把最后一条回复改得更自然').target_hint, '最后一条回复');
    assert.equal(quickRoute('把第3条改一下').target_hint, '第3条');
});

/* ------------------------------------------------------------ 设置合并 */

test('设置深合并：类型纠正与未知键忽略', () => {
    const merged = mergeDefaults(DEFAULTS, {
        dialogue: { depth: '3', injectRules: false },
        memory: { intervalTurns: '20' },
        未知键: 1,
        enabled: 'yes',
    });
    assert.equal(merged.dialogue.depth, 3);
    assert.equal(merged.dialogue.injectRules, false);
    assert.equal(merged.dialogue.injectSceneState, DEFAULTS.dialogue.injectSceneState);
    assert.equal(merged.memory.intervalTurns, 20);
    assert.equal(merged.enabled, DEFAULTS.enabled, '类型不匹配时不采纳');
    assert.equal(merged.未知键, undefined);
});

/* ------------------------------------------------------------ 运行 */

let passed = 0;
const failures = [];
for (const item of cases) {
    try {
        await item.fn();
        passed += 1;
        console.log(`  ✓ ${item.name}`);
    } catch (error) {
        failures.push({ name: item.name, error });
        console.log(`  ✗ ${item.name}`);
        console.log(`      ${error?.message}`);
    }
}

const outDir = new URL('../.test-output/', import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL('result.json', outDir), JSON.stringify({ passed, failed: failures.length, failures: failures.map(item => item.name) }, null, 2));

console.log(`\n${passed}/${cases.length} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
process.exitCode = failures.length ? 1 : 0;
