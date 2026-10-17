/**
 * 编辑指令分类：本地启发式优先（零延迟、可预期），不确定时交给模型判定。
 * 用户永远不需要输入特殊关键词。
 */
import { generateObject } from './llm.js';
import { ROUTER_SYSTEM, ROUTER_SCHEMA } from '../prompts.js';

export const TASK = {
    PROSE_GENERATE: 'prose.generate',
    PROSE_REVISE: 'prose.revise',
    CHARACTER_CREATE: 'character.create',
    CHARACTER_UPDATE: 'character.update',
    WORLDBOOK_WRITE: 'worldbook.write',
    MEMORY_SUMMARIZE: 'memory.summarize',
    CONFIG_ADJUST: 'config.adjust',
    UNKNOWN: 'unknown',
};

export const TASK_LABEL = {
    'prose.generate': '演绎剧情',
    'prose.revise': '修改正文',
    'character.create': '创建人物',
    'character.update': '修改人物',
    'worldbook.write': '世界书操作',
    'memory.summarize': '整理记忆',
    'config.adjust': '记录作者偏好',
    unknown: '未识别',
};

const RULES = [
    {
        // 调整运行参数/写作偏好，而不是写正文。必须排在 PROSE_GENERATE 之前判定。
        task: TASK.CONFIG_ADJUST,
        weight: 4,
        patterns: [
            /(世界卡|世界书|系统|生成|运行|推进|剧情)(的)?(进度|速度|节奏|参数|开关|设置|选项|尺度)/u,
            /(设为|改成|调整为|切换为|调成|打开|关闭).{0,8}(快|慢|高|低|开|关|模式|档)/u,
            /(节奏|语速|文风|语气|篇幅|字数|长度|回复长度|描写密度|尺度|露骨程度|风格).{0,8}(放?[快慢长短多少轻重冷热硬软淡浓细粗]|调整|改变|改成|设为|加大|减少|收紧|放开|精简|详细)/u,
            /(回复|每次|每条|正文|段落|篇幅|字数).{0,8}(短|长|少|多|精简|详细|简短)/u,
            /(多|少)(写|来|给)点?(对话|动作|心理|环境|旁白|描写|细节)/u,
            /(不要|别)(再)?(替|帮)(我|主角)(决定|做决定|选择)/u,
            /(推进|节奏)(快|慢)(一)?(点|些)?$/u,
        ],
    },
    {
        task: TASK.MEMORY_SUMMARIZE,
        weight: 3,
        patterns: [/总结|汇总|梳理|回顾|整理.{0,4}(剧情|事件|记忆|经历|线索)|检查.{0,4}矛盾|有没有矛盾|连贯性/u],
    },
    {
        task: TASK.WORLDBOOK_WRITE,
        weight: 3,
        patterns: [/世界书|设定集|资料集|词条|条目/u],
        boost: [/写入|收录|建档|登记|保存|存入|更新|补充|整理|添加|新建/u],
    },
    {
        task: TASK.CHARACTER_CREATE,
        weight: 3,
        patterns: [/(创建|新建|新增|加|设计|造|添加).{0,6}(人物|角色|NPC|npc|配角|长老|师傅|掌柜|boss)/u],
    },
    {
        task: TASK.CHARACTER_UPDATE,
        weight: 3,
        patterns: [
            /(修改|调整|更改|重设|改写|完善|丰富|补充).{0,6}(人物|角色|档案|人设|设定|性格|身份|背景)/u,
            /(人物|角色|档案|人设|设定|性格|身份|背景).{0,8}(改成|改为|变成|调整为|修改为|更新为|重写)/u,
            /(不要那么|应该更|别那么|变得|改成).{0,10}(温婉|冷漠|热情|随和|严肃|活泼|温柔)/u,
        ],
    },
    {
        task: TASK.PROSE_REVISE,
        weight: 3,
        patterns: [
            /(把|将).{0,12}(那段|这段|刚才|上一段|上一条|回复|正文).{0,12}(改|重写|换|调整|润色|自然|顺)/u,
            /(重写|润色|改一下|改得更|改得自然|不自然|生硬)/u,
            /(纠正|不对|有误|错了|矛盾了)/u,
        ],
    },
    {
        task: TASK.PROSE_GENERATE,
        weight: 2,
        patterns: [
            /^(继续|接着|然后|接下来)/u,
            /(演绎|安排|推进|展开|让.{0,12}(发生|出现|来|走|说|争吵|下雨))/u,
            /(突然|忽然|此时|这时|随后|于是)/u,
        ],
    },
];

function scoreText(text) {
    const scores = new Map();
    for (const rule of RULES) {
        const hit = rule.patterns.some(pattern => pattern.test(text));
        if (!hit) continue;
        let score = rule.weight;
        if (rule.boost && rule.boost.some(pattern => pattern.test(text))) score += 1;
        scores.set(rule.task, (scores.get(rule.task) ?? 0) + score);
    }
    const explicit = !scores.has(TASK.CONFIG_ADJUST) && /世界书|条目|收录|建档|档案/u.test(text);
    const prose = /(正文|这一段|刚才那段|上一段|演绎|剧情)/u.test(text);
    if (explicit && !prose) return { task: TASK.WORLDBOOK_WRITE, score: 4 };
    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return { task: TASK.PROSE_GENERATE, score: 1 };
    return { task: sorted[0][0], score: sorted[0][1] };
}

function extractEntities(text) {
    const found = new Set();
    for (const match of text.matchAll(/[「『《【"]([^」』》】"]{2,12})[」』》】"]/gu)) found.add(match[1]);
    for (const match of text.matchAll(/([\u4e00-\u9fff]{2,4})(?=说|道|问|答|的|是|把|被|在|向|给|让)/gu)) {
        if (!/^(主角|作者|系统|人物|角色|设定|世界|剧情|我们|你们|他们|这个|那个|什么|怎么|为什)/u.test(match[1])) {
            found.add(match[1]);
        }
    }
    return [...found].slice(0, 8);
}

function detectFactFix(text) {
    return /(其实没有|并不存在|不是|没有|不存在|错了|有误|不应该有|根本没有|只是普通|更准确|纠正)/u.test(text);
}

function detectTargetHint(text) {
    if (/(最后一条|最后一段|最近一条|刚才的?回复|刚刚)/u.test(text)) return '最后一条回复';
    if (/(上一段|上一条|前面那段|前一段)/u.test(text)) return '上一条回复';
    const match = text.match(/第\s*(\d+)\s*(楼|条|段)/u);
    if (match) return `第${match[1]}条`;
    return '';
}

/** 本地启发式路由。 */
export function quickRoute(text) {
    const value = String(text ?? '').trim();
    const { task, score } = scoreText(value);
    let scope = 'none';
    let confident = true;
    if (task === TASK.CHARACTER_UPDATE) {
        if (/(当前表现|这一场|这场|这一章|表演|演出|暂时|这一次)/u.test(value)) {
            scope = 'performance';
        } else if (/(人设|设定|档案|身份|背景|性格|经历|来历)/u.test(value)) {
            scope = 'setting';
        } else {
            // 由模型判断是"当前表现"还是"设定本身"（例如"柳如烟不要那么冷漠"）。
            scope = 'unknown';
            confident = false;
        }
    }
    return {
        task,
        scope,
        entities: extractEntities(value),
        target_hint: detectTargetHint(value),
        needs_fact_fix: detectFactFix(value),
        instruction: value,
        confidence: confident ? (score >= 3 ? 0.8 : score >= 2 ? 0.6 : 0.35) : 0.45,
        method: 'heuristic',
    };
}

/** 完整路由：低置信度时请模型判定。 */
export async function routeInstruction(text, { useModel = true } = {}) {
    const quick = quickRoute(text);
    if (!useModel || quick.confidence >= 0.6) return quick;
    try {
        const result = await generateObject({
            system: ROUTER_SYSTEM,
            prompt: `作者指令：\n${text}`,
            schema: ROUTER_SCHEMA,
        });
        return {
            task: result?.task ?? quick.task,
            scope: result?.scope ?? quick.scope,
            entities: Array.isArray(result?.entities) && result.entities.length ? result.entities : quick.entities,
            target_hint: result?.target_hint || quick.target_hint,
            needs_fact_fix: Boolean(result?.needs_fact_fix) || quick.needs_fact_fix,
            instruction: result?.instruction || text,
            confidence: typeof result?.confidence === 'number' ? result.confidence : 0.7,
            method: 'model',
            heuristic: quick,
        };
    } catch (error) {
        console.warn('[IF Enhancer] 模型路由失败，使用启发式结果：', error?.message ?? error);
        return quick;
    }
}
