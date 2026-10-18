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
import { parseJson, isProviderApiError } from '../src/core/llm.js';
import { guessNameFromText } from '../src/core/edit.js';
import { MODE, MODE_LABEL } from '../src/ui/toggle.js';
import { parsePath, applyStatPatch, flattenStatData, numericPaths } from '../src/core/mvu.js';
import { sanitizeForSlash, composePrompt, composeNegative } from '../src/core/image.js';
import { characterStructuredPrompt, CHARACTER_SCHEMA, looksLikeMetaReply, stripMetaPreamble } from '../src/prompts.js';
import { mergeDefaults, migrateSettings, DEFAULTS } from '../src/config.js';

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

test('常驻条目没有关键词不算错误（记忆条目即如此）', () => {
    const issues = lintEntry({
        name: '[记忆] 剧情摘要',
        type: '时间线',
        part: 'plot',
        content: '摘要:\n  - 主角来到坡子口催租。',
        keys: [],
        constant: true,
        position: 'at_depth',
        depth: 0,
    });
    assert.equal(issues.filter(item => item.level === 'error').length, 0, issues.map(item => item.message).join(' / '));
    assert.ok(!issues.some(item => item.code === 'KW_EMPTY'));
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

test('数组设置整体替换（作者偏好不能被默认值吃掉）', () => {
    const merged = mergeDefaults(DEFAULTS, {
        authorPreferences: [{ at: '2026-10-17', text: '推进速度设为快' }],
    });
    assert.equal(merged.authorPreferences.length, 1);
    assert.equal(merged.authorPreferences[0].text, '推进速度设为快');
    const kept = mergeDefaults(DEFAULTS, {});
    assert.deepEqual(kept.authorPreferences, []);
});

/* ------------------------------------------------------------ 演绎剧情 / 更改配置 分离 */

test('调整生成参数被识别为更改配置，而不是演绎剧情', () => {
    assert.equal(quickRoute('把世界卡进度推进设为快').task, TASK.CONFIG_ADJUST);
    assert.equal(quickRoute('节奏放慢一点').task, TASK.CONFIG_ADJUST);
    assert.equal(quickRoute('每次回复短一些').task, TASK.CONFIG_ADJUST);
    assert.equal(quickRoute('不要替主角做决定').task, TASK.CONFIG_ADJUST);
    assert.equal(quickRoute('文风更冷一点').task, TASK.CONFIG_ADJUST);
    assert.equal(quickRoute('多写点对话').task, TASK.CONFIG_ADJUST);
});

test('更改配置与世界书任务不会互相抢占', () => {
    assert.equal(quickRoute('把世界书进度推进设为快').task, TASK.CONFIG_ADJUST);
    assert.equal(quickRoute('把坡子口和张婆的设定整理进世界书').task, TASK.WORLDBOOK_WRITE);
});

test('元回复能被识别（真机实测：指令被当成正文时模型回了说明）', () => {
    assert.equal(
        looksLikeMetaReply('你给的指令是"把世界卡进度推进设为快"，但这个故事的世界卡、人物档案和当前进度还没有发过来。'),
        true,
    );
    assert.equal(looksLikeMetaReply('请补充一下主角是谁、在哪个世界。'), true);
    assert.equal(looksLikeMetaReply('我手里没有可推进的起点。'), true);
    const realProse = '云压得极低，像一口倒扣的铁锅闷住了整个村子。蝉忽然全哑了，紧接着豆大的雨点砸下来。';
    assert.equal(looksLikeMetaReply(realProse), false);
    assert.equal(looksLikeMetaReply('x'.repeat(800)), false, '长文本不判为元回复');
});

test('三种模式职责互不重叠', () => {
    const modes = Object.values(MODE);
    assert.deepEqual(modes.sort(), ['dialogue', 'edit', 'prose']);
    assert.equal(new Set(modes).size, 3, '模式不重复');
    for (const m of modes) assert.ok(MODE_LABEL[m], `缺少模式标签：${m}`);
    // 演绎与编辑必须是两个不同入口（真机反馈要求分开）
    assert.notEqual(MODE.PROSE, MODE.EDIT);
});

/* ------------------------------------------------------------ 自动配图 */

test('配图提示词清理 STscript 敏感字符', () => {
    assert.equal(sanitizeForSlash('a|b{c}d\\e"f'), 'a b c d e f');
    assert.equal(sanitizeForSlash('多行\n提示词   带空格'), '多行 提示词 带空格');
});

test('配图提示词组装：模型 prompt + 画风 + 固定后缀，且去重', () => {
    const prompt = composePrompt({ prompt: '1girl, rain, village gate', style: 'anime style' }, 'anime style, cinematic lighting');
    assert.equal(prompt, '1girl, rain, village gate, anime style, cinematic lighting');
    assert.equal(composePrompt({ prompt: '' }, ''), '');
});

test('负面提示词合并去重', () => {
    assert.equal(composeNegative({ negative: 'lowres, bad hands' }, 'lowres'), 'lowres, bad hands');
    assert.equal(composeNegative({}, 'text, watermark'), 'text, watermark');
});

test('“配图”类说法被识别为生成配图任务', () => {
    assert.equal(quickRoute('配图').task, TASK.IMAGE_GENERATE);
    assert.equal(quickRoute('画一张雨中的村口').task, TASK.IMAGE_GENERATE);
    assert.equal(quickRoute('生成图片').task, TASK.IMAGE_GENERATE);
    assert.equal(quickRoute('来张图').task, TASK.IMAGE_GENERATE);
});

/* ------------------------------------------------------------ 结构化输出解析 */

test('parseJson 能剥掉代码围栏', () => {
    assert.deepEqual(parseJson('```json\n{"task":"prose.generate"}\n```'), { task: 'prose.generate' });
});

test('parseJson 能从未知文本中提取 JSON 对象', () => {
    const text = '好的，这是结果：\n{"entries":[],"notes":[]}\n希望有帮助。';
    assert.deepEqual(parseJson(text), { entries: [], notes: [] });
});

test('模型返回散文时 parseJson 给出可读报错（真机实测的失败模式）', () => {
    const prose = '收到的「最近剧情」与「既有资料」两栏均为空，因此我只给出条目骨架。\n\n---\n\n## 条…';
    assert.throws(() => parseJson(prose), /模型没有按要求返回结构化结果/);
    assert.equal(parseJson(prose, { fallback: { ok: false } }).ok, false);
});

test('人物结构化提示词与 schema 要求人物名与条目名', () => {
    const prompt = characterStructuredPrompt({ instruction: '创建一个合欢宗长老', memoryContext: '' });
    assert.match(prompt, /人物名/);
    assert.match(prompt, /entry_name/);
    const required = CHARACTER_SCHEMA.value.required;
    for (const key of ['name', 'entry_name', 'kind', 'content', 'keywords']) {
        assert.ok(required.includes(key), `schema 缺少必需字段 ${key}`);
    }
    assert.deepEqual(CHARACTER_SCHEMA.value.properties.kind.enum, ['角色', 'NPC']);
});

test('模型返回 Markdown 时也能推断出人物名（真机实测的降级路径）', () => {
    assert.equal(guessNameFromText('# 合欢宗·执法长老·裴守真\n\n## 基础档案\n- **姓名**：裴守真\n'), '裴守真');
    assert.equal(guessNameFromText('## 褚令仪_基础信息\n**name**：褚令仪\n'), '褚令仪');
    assert.equal(guessNameFromText('条目名：柳如烟_基础信息\n'), '柳如烟');
    assert.equal(guessNameFromText('没有任何名字的一段说明文字。'), '');
    assert.equal(guessNameFromText('角色_待命名', '兜底名'), '兜底名');
});

test('供应商拒绝结构化输出时能被识别（真机实测的 API 错误）', () => {
    assert.equal(isProviderApiError('[API 错误] This response_format type is unavailable now (request_id: 082b)'), true);
    assert.equal(isProviderApiError('response_format type is unavailable'), true);
    assert.equal(isProviderApiError('{"entries":[]}'), false);
    assert.equal(isProviderApiError('云压得极低，像一口倒扣的铁锅。'), false);
});

test('设置迁移：v1 的写入目标改为角色卡绑定世界书', () => {
    const raw = { version: 1, worldbook: { target: 'chat', nameTemplate: '{{chat}}·互动小说', autoCreate: true, primaryName: '' } };
    assert.equal(migrateSettings(raw), true);
    assert.equal(raw.worldbook.target, 'char');
    assert.equal(raw.worldbook.nameTemplate, '{{char}}·互动小说');
    assert.equal(raw.version, DEFAULTS.version);
    const pinned = { version: 1, worldbook: { target: 'chat', primaryName: '我的书' } };
    migrateSettings(pinned);
    assert.equal(pinned.worldbook.target, 'chat', '用户手动指定世界书时不动目标');
    assert.equal(migrateSettings({ version: DEFAULTS.version }), false, '已是当前版本不再迁移');
});
test('剥掉正文开头的元回复引导句（真机实测：预设习惯）', () => {
    assert.equal(stripMetaPreamble('好的，这是你需求的最终输出：\n\n殿里静得很。'), '殿里静得很。');
    assert.equal(stripMetaPreamble('以下是正文：\n\n黄立极出列。'), '黄立极出列。');
    assert.equal(stripMetaPreamble('【最终输出】\n\n日头爬上檐角。'), '日头爬上檐角。');
    assert.equal(stripMetaPreamble('殿里静得很。'), '殿里静得很。', '正常正文不得被改动');
});
/* ------------------------------------------------------------ MVU 变量 */

test('MVU 路径解析与按路径改值（含 delta 与新建路径）', () => {
    assert.deepEqual(parsePath('后宫[0].好感'), ['后宫', '0', '好感']);
    const stat = { 主角: { 魅力: 78 }, 后宫: [{ 姓名: '周皇后', 好感: 40 }] };
    const next = applyStatPatch(stat, {
        '主角.魅力': 90,
        '后宫[0].好感': { delta: 15 },
        '世界.当前时间': '崇祯元年十月二十七日',
    });
    assert.equal(next.主角.魅力, 90);
    assert.equal(next.后宫[0].好感, 55);
    assert.equal(next.世界.当前时间, '崇祯元年十月二十七日');
    assert.equal(stat.主角.魅力, 78, '不得就地修改原变量');
});

test('MVU 变量拍平与数值路径提取', () => {
    const stat = { 大明: { 国库: 300, 民心: 35 }, 后宫: [{ 好感: 40 }] };
    const flat = flattenStatData(stat);
    assert.ok(flat.some(item => item.path === '大明.国库' && item.value === 300));
    assert.ok(flat.some(item => item.path === '后宫[0].好感'));
    assert.deepEqual(numericPaths(stat), ['大明.国库', '大明.民心', '后宫[0].好感']);
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
