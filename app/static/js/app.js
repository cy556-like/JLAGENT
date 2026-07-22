/**
 * ForgeAgent 前端应用
 * 主脚本 - 处理认证、聊天、会话管理、导出等功能
 */

// ===== [BUG FIX] Browser Back Button Support =====
// The app uses CSS-based SPA navigation (show/hide elements) without updating
// browser history. This causes the back button to exit the app entirely
// instead of returning to the login page. Fix: use history.pushState to
// record page transitions, and listen for popstate to handle back/forward.

let currentUser = null;
let userRole = null;
let authToken = null;
let selectedFile = null;
let selectedFileBase64 = null;
let isLoading = false;
let currentChatId = null;
let allChats = [];
let renamingChatId = null;
let currentAbortController = null;
let userScrolledUp = false;
let lastMessageText = '';
let webSearchEnabled = false;
let deepThinkEnabled = false;
let currentMode = 'agent';
let selectedSkill = null;  // 当前选中的技能（如 '8d-skill'）
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const DIGITAL_TEACHER_AGENT_ID = 'digital-zheng-teacher-agent';
const FULL_KB_ADMIN_USERNAME = 'adminquanzhi';

function canUploadKnowledgeBase(agentId = currentAgentId) {
    return Boolean(currentUser && agentId && (currentUser === FULL_KB_ADMIN_USERNAME || agentId !== DIGITAL_TEACHER_AGENT_ID));
}

function canDeleteKnowledgeBase(agentId = currentAgentId) {
    return Boolean(currentUser && agentId && (
        currentUser === FULL_KB_ADMIN_USERNAME ||
        (currentUser === 'admin' && agentId !== DIGITAL_TEACHER_AGENT_ID)
    ));
}

// [#12] 同步防抖锁：避免短时间内重复调用 syncAgentsFromServer
let _syncAgentsLock = false;
let _syncAgentsLastTime = 0;
const _SYNC_AGENTS_COOLDOWN = 5000;  // 5秒内不重复同步
// [#12] 上次同步到服务器的智能体数据指纹（用于检测数据是否真变了）
let _lastSyncedAgentsHash = '';

// ===== Agent Management =====
// 允许的智能体ID白名单（与后端 storage.py 保持一致）
// 顺序即侧边栏固定显示顺序，点击等操作不会改变
const ALLOWED_AGENT_IDS = [
    'digital-zheng-teacher-agent', // 1. 数字郑老师
    'dfmea-risk-agent',            // 2. 整车制造过程改进工作助手
    'part-design-agent',           // 3. 三电系统质量改进工作助手
    'simulation-optimization-agent', // 4. 整车评审与AUDIT工作助手
    'ee-design-agent',             // 5. 供应商来料协同工作助手
    'embedded-software-agent',     // 6. 售后市场质量改进工作助手
    'test-verification-agent',     // 7. 数据统计分析预警工作助手
    'equipment-production-agent',  // 8. 防再发与经验库工作助手
    'lean-improvement-agent',      // 9. 精益提升工作助手
];

// 内置助手名称统一由代码控制，避免浏览器旧缓存或服务端旧数据恢复历史名称
const BUILTIN_AGENT_NAMES = {
    'digital-zheng-teacher-agent': '数字郑老师',
    'dfmea-risk-agent': '整车制造过程改进工作助手',
    'part-design-agent': '三电系统质量改进工作助手',
    'simulation-optimization-agent': '整车评审与AUDIT工作助手',
    'ee-design-agent': '供应商来料协同工作助手',
    'embedded-software-agent': '售后市场质量改进工作助手',
    'test-verification-agent': '数据统计分析预警工作助手',
    'equipment-production-agent': '防再发与经验库工作助手',
    'lean-improvement-agent': '精益提升工作助手',
};

// 按 ALLOWED_AGENT_IDS 定义的顺序排序智能体列表（保证侧边栏顺序永远固定）
function sortAgentsByFixedOrder(agents) {
    const orderMap = {};
    ALLOWED_AGENT_IDS.forEach((id, idx) => { orderMap[id] = idx; });
    return agents.sort((a, b) => {
        const oa = orderMap[a.id] !== undefined ? orderMap[a.id] : 9999;
        const ob = orderMap[b.id] !== undefined ? orderMap[b.id] : 9999;
        return oa - ob;
    });
}

// 数字郑老师专属人物页（信息摘自《郑伟老师简历》）
const ZHENG_TEACHER_PROFILE = {
    name: '郑伟老师',
    badge: 'AI分身',
    tags: ['质量与精益管理专家', '北京全质科技创办人', '浙江大学EMBA'],
    meta: '整车质量管理20年 · 丰田、长城、吉利、北汽实战经验',
    sections: {
        expertise: {
            label: '如何训练AI分身',
            content: '训练AI分身，是一个将顶尖专家的经验“复制”并“进化”为可持续工作的数字智能体的过程。把郑老师数以十万字的问答、讲课等实战经验和资料，转为结构化的数据，并通过通用大模型进行训练和微调，形成一个“数据驱动、持续进化”的数字智能体。'
        },
        profile: {
            label: '个人简介',
            content: '自2001年加入天津一汽丰田起，从事整车厂质量管理工作20年；先后在长城汽车、吉利汽车、北汽集团担任重要管理职务，拥有质量、技术、生产与企业运营实战经验。现为北京全质科技股份有限公司创办人、股东。'
        },
        wechat: {
            label: '个人微信',
            content: '如对AI生成内容产生疑问，相关问题可添加个人微信。',
            image: '/static/images/zheng-wei-wechat.jpg',
            imageAlt: '郑伟老师个人微信二维码'
        }
    }
};

// 每个智能体的欢迎页配置（名称、描述、推荐问题）
const AGENT_WELCOME_CONFIG = {
    'dfmea-risk-agent': {
        name: '整车制造过程改进工作助手',
        desc: '关注冲焊涂总四大工艺关键特性，智能诊断尺寸偏差与焊接飞溅等顽疾，驱动过程能力指数提升，夯实大批量制造质量。',
        questions: [
            { label: '冲压件超差排查', question: '冲压单件超出公差的常见原因有哪些，按人机料法环如何系统排查？' },
            { label: '夹具趋势预警', question: '如何根据CII指数变化趋势，提前识别焊装夹具的磨损或松动问题？' },
            { label: '焊装过程能力判定', question: '在焊装过程能力分析中，CPK达到多少算合格，PPK和CPK如何区分使用？' },
            { label: '镀锌板参数切换', question: '镀锌钢板与冷轧钢板在焊装车间混产时，需要调整哪些核心焊接参数？' },
            { label: '电泳缩孔真因', question: '涂装电泳漆膜出现缩孔或针孔缺陷，通常由哪些前处理工序失控引起？' },
            { label: '指数工艺优化', question: '面漆橘皮指数偏高，在工艺参数层面应从哪些方向进行优化调整？' },
            { label: '合装扭矩超差分析', question: '总装底盘合装工位，螺栓扭矩超差与哪些装配要素关系最密切？' },
            { label: '淋雨漏点工序追溯', question: '整车淋雨检测发现的水滴渗透点，如何快速追溯至涂装密封工序的失效源？' },
            { label: '冲压焊装偏差分离', question: '如何区分车身尺寸问题是冲压单品波动造成，还是焊装拼台偏位导致？' },
            { label: 'Audit缺陷诊断逻辑', question: '连续多日白车身Audit扣分集中在同一个位置，怎样建立系统诊断逻辑树？' },
            { label: '闭合件波动优先级', question: '当四门两盖的间隙与段差合格率波动时，应优先调冲压件还是调总装工装？' },
            { label: '色差温湿度补偿', question: '涂装车间相同批次油漆，在不同温湿度条件下出现色差值漂移，如何处理？' },
            { label: '错漏装数据追溯', question: '总装线边疑似零件错装或漏装，在不拆解的情况下如何通过追溯数据确认？' },
            { label: '飞溅虚焊曲线诊断', question: '焊装车间批量出现飞溅或虚焊缺陷，关键要从哪些焊接参数曲线中找异常点？' },
            { label: '车身尺寸预警建模', question: '如何利用车身测量点历史数据构建预警模型，提前发现尺寸均值漂移？' },
            { label: '能力不足分级预警', question: '在A级纯电SUV大批量生产阶段，如何设置过程能力不足的自动分级预警规则？' },
            { label: '历史防错复用', question: '新车型导入焊装线时，如何用历史车型的经验缺陷数据，做FMEA风险预防？' },
            { label: '异响变化点锁定', question: '出现偶发性异响缺陷时，如何结合工位扭矩曲线和力矩衰减数据锁定变化点？' },
            { label: '缺陷任务拆解', question: '如何将车身Audit评审发现的复杂外观缺陷，拆解为冲、焊、涂各车间可执行的改善任务？' },
            { label: '涂装颗粒来源锁定', question: '涂装洁净度颗粒缺陷增多，应如何通过颗粒分析锁定来自哪个工序或材料？' },
        ]
    },
    'part-design-agent': {
        name: '三电系统质量改进工作助手',
        desc: '围绕电池、电机、电控，关注绝缘耐压、气密性等核心参数，利用特征分析锁定失效真因，守护新能源安全底线。',
        questions: [
            { label: '模组来料标准', question: '三电系统进货检验中，电池模组的开路电压和内阻需要满足什么标准才算合格？' },
            { label: '气密泄漏定位', question: '电池包气密性测试泄漏率超标，常见的泄漏点有哪些，如何通过分段打压快速定位？' },
            { label: '扭矩波动真因', question: '电驱总成EOL测试中，扭矩波动超出工艺限值的常见真因是什么？' },
            { label: '耐压击穿缺陷区分', question: '电机定子绝缘耐压测试击穿，如何区分是绕组本体缺陷还是浸渍工艺不良？' },
            { label: '模组焊接参数排查', question: '电池模组激光焊接出现虚焊或熔深不足，应从哪些焊接参数入手排查？' },
            { label: 'PCBA原因', question: '电控PCBA波峰焊后出现锡珠残留，如何从助焊剂和预热温度曲线找根本原因？' },
            { label: '静置压降判定规则', question: '动力电池下线后静置压降异常，如何建立判定规则区分自放电过大与微短路？' },
            { label: '电机阶次噪声诊断', question: '电机NVH台架测试噪声阶次异常，如何通过频谱分析锁定是齿槽转矩还是轴承问题？' },
            { label: '涂胶工艺在线监控', question: '电池包IP67密封胶涂覆宽度和厚度如何在线监控，防止批量密封失效？' },
            { label: 'IGBT散热热阻验证', question: '电控IGBT模块过温保护频繁触发，散热界面材料的热阻是否达标如何验证？' },
            { label: '端子退针防错探测', question: '三电系统线束接插件端子退针或缩针缺陷，如何在装配工序设置防错探测？' },
            { label: '高压互锁断路诊断', question: '电池PACK高压互锁回路偶发断路，如何设计诊断逻辑快速锁定故障点？' },
            { label: '动平衡校正策略', question: '电机转子动平衡超差，校正时是优先去重还是加重，对量产节拍影响如何评估？' },
            { label: 'CAN报文丢失', question: '电控功能测试中CAN报文丢失或超时，如何区分是软件逻辑问题还是硬件链路故障？' },
            { label: '售后绝缘失效复现', question: '售后市场三电系统绝缘报警频发，如何结合车辆运行数据和环境湿度做失效复现分析？' },
            { label: '振动开裂仿真对标', question: '电池包振动测试后壳体开裂，如何通过有限元仿真与实际测试对标找到薄弱点？' },
            { label: '电容容衰批次预警', question: '电机控制器直流母线电容容值衰减异常，来料批次间的DF值差异如何设定预警限？' },
            { label: '进水失效鱼骨图', question: '三电系统进水导致功能失效，从整车涉水到单体密封的路径中如何建立鱼骨图排查逻辑？' },
            { label: '电驱效率损耗拆分', question: '电驱系统效率未达设计指标，如何通过台架MAP图对比锁定是电机还是控制器损耗偏高？' },
            { label: '二供模组等效验证', question: '新导入的二供电池模组与原厂模组在关键特性上如何做等效性验证，确保切换无风险？' },
        ]
    },
    'simulation-optimization-agent': {
        name: '整车评审与AUDIT工作助手',
        desc: '依照AUDIT标准进行整车静态、动态评审，数字化记录扣分项，智能分级分类，精准拉动责任单位快速整改，提升整车感官与功能品质。',
        questions: [
            { label: 'AUDIT缺陷等级标准', question: '整车AUDIT评审中，缺陷等级如何划分，A类、B类、C类缺陷的定义和扣分标准是什么？' },
            { label: '间隙段差评审标准', question: '静态评审时，车身外观间隙段差的测量方法和合格范围如何确定，不同车型是否有差异？' },
            { label: 'QK值计算方法', question: '整车AUDIT扣分值如何换算为QK值，QK值的计算公式和目标范围是什么？' },
            { label: '内饰外观缺陷判定', question: '内饰评审中，异色、皮纹对纹、分型线飞边等外观缺陷，按什么准则判定合格或扣分？' },
            { label: '动态评审停线标准', question: '整车动态路试评审时，异响、抖动、跑偏等问题如何记录和分级，哪些属于必须停线整改项？' },
            { label: '重复缺陷升级流程', question: 'AUDIT评审发现的同一部位重复缺陷，如何启动升级流程，触发更高层级评审和围堵措施？' },
            { label: 'AUDIT缺陷工序追溯', question: '如何根据AUDIT评审结果反向追溯缺陷产生的责任车间或责任工序？' },
            { label: '功能缺陷交叉验证', question: '评审中发现的电器功能类缺陷，如何与电检结果交叉验证，确认是硬件还是软件问题？' },
            { label: '漆面缺陷比对判定', question: '整车漆面评审中，颗粒、流挂、橘皮、缩孔等涂装缺陷，如何对照标准样板做比对判定？' },
            { label: '评审员一致性校准', question: 'AUDIT评审员的主观评分偏差如何控制，怎样通过定期校准评审员的一致性来保证评审公正？' },
            { label: '管路干涉安全评估', question: '评审发现底盘管路干涉或线束走向异常，如何快速评估是否存在安全隐患并判定缺陷等级？' },
            { label: '新车型评审过渡规则', question: '新车型SOP初期，AUDIT扣分偏高集中在哪些区域，如何设定初期评审的过渡期放宽规则？' },
            { label: '出口车评审差异', question: '出口车与内销车的AUDIT评审标准有哪些差异，右舵车型的评审项目和关注点如何调整？' },
            { label: 'Audit数据帕累托分析', question: '如何将Audit评审数据按月按车型做帕累托分析，找出TOP3高频缺陷并推动专项改进？' },
            { label: '淋雨评审判定标准', question: '整车密封性评审中，淋雨测试的检查点位和判定标准是什么，微量渗水和滴水的区分如何界定？' },
            { label: 'Audit问题闭环跟踪', question: 'AUDIT评审发现的问题，如何录入系统并自动生成任务单，跟踪各责任部门的整改进度和效果？' },
            { label: '气味评审评分标准', question: '气味评审时，车内VOC和气味的评分标准是什么，如何区分材料本身气味与环境吸附气味？' },
            { label: 'Audit与VOC关联分析', question: '如何将AUDIT评审结果与售后市场VOC数据做关联分析，验证评审标准是否能有效捕捉用户敏感缺陷？' },
            { label: '关门声品质量化分级', question: '评审发现门盖闭合力和关门声品质不佳，这类感官质量缺陷如何量化和分级？' },
            { label: '边界缺陷QIT攻关', question: '对于AUDIT评审中反复出现的边界条件缺陷，如何启动跨部门QIT小组进行专项攻关并验证效果？' },
        ]
    },
    'material-selection-agent': {
        name: '新车型质量改进智能体',
        desc: '针对新车型，从试制到爬产构建全生命周期质量门，快速暴露弱点，确保SOP质量即成熟。',
        questions: [
            { label: 'ET问题优先级管理', question: '新车型ET试制阶段发现的问题，如何按严重度和频次建立优先级排序并分配整改责任人？' },
            { label: 'PT过程能力评价节点', question: '如何在PT阶段设置过程能力评价节点，判断各工序是否具备进入SOP的量产成熟度？' },
            { label: '尺寸合格率爬坡四步法', question: '新车型白车身尺寸合格率爬坡缓慢，如何用四步法系统提升：测量、分析、整改、验证？' },
            { label: '双产品线防错清单', question: '银河A7双产品线共线生产时，如何建立差异件防错清单，防止插混版和纯电版零部件混装？' },
            { label: '历史FMEA前置预防', question: '新车型导入阶段，如何参照历史车型的FMEA库做设计/工艺失效风险的前置识别和预防？' },
            { label: 'Audit专项攻关', question: '试制样车Audit评审扣分集中在某个系统，如何组建专项QIT小组并制定90天攻关计划？' },
            { label: '新模具尺寸稳定性验证', question: '新模具的冲压单件尺寸稳定性如何验证，需要连续多少件检测数据才能判定模具合格？' },
            { label: '试喷色差参数调整', question: '新车型涂装试喷时出现色差，如何与标准色板做数据化比对并调整机器人喷涂参数？' },
            { label: '新工装首件验证', question: '总装新工装夹具到位后，如何通过首件验证和过程能力研究确认装配精度是否达标？' },
            { label: '气味超标三级溯源', question: '新车型气味和VOC摸底测试超标，如何建立内饰材料—零件—整车的三级溯源排查路径？' },
            { label: '质量阀开阀条件', question: '从ET到PT再到SOP，各阶段的质量阀评审通过条件是什么，需要哪些交付物才能开阀？' },
            { label: '设计变更影响评估', question: '新车型试制阶段出现设计变更，如何快速评估变更对关联零件、工艺和已制样件的影响范围？' },
            { label: '首次上电测试清单', question: '新车型三电系统搭载整车后的首次上电测试，需要检查哪些高压安全和功能验证项？' },
            { label: '新车型Audit清单', question: '如何根据新车型的结构特点制定整车Audit重点评审清单，提前锁定高关注区域？' },
            { label: '供应商初期流动管理', question: '新车型小批量试装阶段，供应商来料问题频发，如何建立供应商初期流动管理计划？' },
            { label: '路试故障8D归因', question: '新车型路试耐久测试中出现故障，如何用8D方法系统归因并判断是设计弱点还是制造波动？' },
            { label: '质量指标阶梯目标', question: '如何设定新车型爬产阶段的质量指标阶梯目标，实现从60%到95%合格率的渐进达成？' },
            { label: '上市首月VOC反向排查', question: '新车型上市后首月，售后VOC集中反馈某类缺陷，如何启动快速反向排查锁定产线真因？' },
            { label: '新车型经验教训归档', question: '如何建立新车型的经验教训库，将试制期的所有问题结构化归档，为后续车型提供输入？' },
            { label: '转量产质量移交清单', question: '新车型转量产移交时，质量部门需要向制造基地移交哪些控制计划、检验标准和防错清单？' },
        ]
    },
    'manufacturing-process-agent': {
        name: '全球车出口保障智能体',
        desc: '专为全球车护航，整合目标市场法规、环境适应性及左/右舵特殊要求，前置规避出口质量风险，确保顺利通关与海外口碑。',
        questions: [
            { label: '出口认证差异对比', question: '银河E5出口欧洲与东南亚市场，需要分别通过哪些强制认证，认证项目的主要差异是什么？' },
            { label: '欧盟EMC差异分析', question: '欧盟WVTA认证对整车电磁兼容EMC的要求与中国标准有何不同，需要额外增加哪些测试项？' },
            { label: '右舵装配防错清单', question: '右舵出口车在总装线上最容易出现哪些装配差错，如何建立右舵专属防错清单？' },
            { label: '高温市场三电验证', question: '中东高温干燥市场对三电系统热管理和电池冷却性能有哪些特殊验证要求？' },
            { label: '出口防腐分级标准', question: '出口车防腐标准如何根据目标市场气候条件分级，沿海高湿地区和内陆干燥地区有何不同？' },
            { label: '充电接口多版本管理', question: '不同国家燃油/充电接口标准不一致，出口车充电口及高压线束如何做多版本配置管理？' },
            { label: 'KD包装防锈验证', question: '出口KD散件包装时，如何制定防锈防潮方案并验证包装方案的有效性？' },
            { label: '出口VOC法规对标', question: '目标市场法规对车内VOC和有害物质限值与中国标准相比有哪些更严苛的指标？' },
            { label: '海外缺陷国内复现', question: '海外售后反馈的右舵车型异响或功能缺陷，如何快速在国内产线复现并定位真因？' },
            { label: '海运盐雾防护检测', question: '出口车船运途中盐雾腐蚀风险如何评估，交车前需要做哪些专项防盐雾处理和检测？' },
            { label: '出口标签合规审查', question: '目标市场语言版本的车辆铭牌、警示标签和用户手册，如何确保印刷内容和粘贴位置合规？' },
            { label: '电池碳足迹合规要求', question: '欧盟对动力电池碳足迹声明和回收溯源的要求，对电池来料和生产过程提出哪些新增约束？' },
            { label: '出口差异件断点管理', question: '出口不同国家的车型在灯光、后视镜、安全带等安全件上存在差异配置，如何做差异件断点管理？' },
            { label: '海外召回快速响应', question: '海外市场召回或质量投诉发生后，如何建立跨境快速响应机制并在48小时内给出初步原因分析？' },
            { label: '右舵制动补充测试', question: '左舵和右舵车型在制动踏板布置及管路走向上不同，制动性能验证需要针对右舵做哪些补充测试？' },
            { label: '极寒冷启动验证要求', question: '寒冷地区出口车冷启动性能验证，需要在哪些低温等级下完成整车及三电系统匹配测试？' },
            { label: '出口通关文件一致性', question: '出口车随车检验单、产地证、3C/认证一致性证书等通关文件如何与实车配置保持一致，避免清关受阻？' },
            { label: '出口安全法规对标', question: '目标市场对行人保护和碰撞安全的法规等级要求与中国C-NCAP有何差异，需要做哪些结构补强？' },
            { label: '出口PDI问题出厂拦截', question: '海外经销商PDI检查反馈的漆面划伤或装配松动问题，如何在出厂检验环节增加专项拦截？' },
            { label: '全球车变更同步评估', question: '如何建立全球车变更管理台账，确保国内设计变更同步评估对海外认证、备件和售后公告的影响？' },
        ]
    },
    'ee-design-agent': {
        name: '供应商来料协同工作助手',
        desc: '和SQE部门协同，针对百家供应商，确保零部件高质量入厂。',
        questions: [
            { label: '来料检验标准查询', question: '如何快速查询特定零部件的进货检验标准和最新版规格书？' },
            { label: '来料异常传递流程', question: '当产线发生疑似来料异常时，标准的信息传递和升级流程是什么？' },
            { label: '供应商批次合格率趋势', question: '如何查看某一供应商过去三个月的来料批次合格率趋势？' },
            { label: 'PPAP文件状态调阅', question: '如何调取某颗物料的PPAP文件包，查阅其历史批准状态和测量报告？' },
            { label: '来料问题协同提报', question: '质量改进科收到产线来料问题抱怨后，应如何整理问题描述并协同提报给SQE？' },
            { label: '报告状态追踪', question: '如何确认某次来料不良是否已经开具SCAR报告，以及该报告的当前处理节点？' },
            { label: '供应商封样件比对', question: '在Audit或新车型评审中发现的零部件外观问题，如何与供应商封样件进行比对确认？' },
            { label: '供应商月度绩效查询', question: '如何获取特定供应商的质量绩效月度评分卡，用于支持内部质量评审会？' },
            { label: '共用件版本标准区分', question: '对于银河A7双产品线共用的零件，如何区分和查询不同版本的技术标准及适用车型？' },
            { label: '关键件异常协同预警', question: '三电关键件来料检测数据出现异常波动时，协同预警的阈值和责任通知机制是什么？' },
            { label: '售后旧件批次追溯', question: '如何将售后反馈的索赔旧件问题，通过协同平台关联到具体的来料批次信息？' },
            { label: '8D报告完整性评估', question: '供应商提交的8D报告，质量改进科需要从哪些维度评估其分析逻辑和证据链的完整性？' },
            { label: '物料设计变更查询', question: '如何查询某个物料是否已有设计变更通知，以及新老状态切换的时间节点？' },
            { label: '来料停线信息登记', question: '产线因来料问题导致的停线信息，如何在协同平台中快速登记并完成影响范围评估？' },
            { label: '多家供应商质量对比', question: '如何比较同一物料多家供应商的来料质量水平，识别批次间或供应商间的质量差异？' },
            { label: '型式试验报告预警', question: '供应商定期提交的型式试验报告到期预警，应如何查询并提醒SQE进行索取？' },
            { label: '异常物料风险批号追溯', question: '面对产线的紧急物料质量异常，如何在不开箱的情况下通过系统数据初步判断风险批号？' },
            { label: '来料质量趋势看板', question: '质量改进科如何利用供应商来料数据，建立关键外协件的进厂质量趋势看板？' },
            { label: '出口件来料标准差异', question: '全球车E5的出口专用件，其来料检验标准和国内件有哪些差异？' },
            { label: '供应商会议数据准备', question: '在参与供应商质量改进会议前，应如何准备来料不良数据包和产线影响证据？' },
        ]
    },
    'embedded-software-agent': {
        name: '售后市场质量改进工作助手',
        desc: '打通市场、三包维修数据，智能聚类高频故障，快速启动优先改进，提升出口及国内用户满意度。',
        questions: [
            { label: '高频故障聚类排名', question: '售后维修数据中，如何按故障现象聚类，找出TOP10高频问题的排名及占比？' },
            { label: 'VIN码批次范围锁定', question: '某类售后故障集中爆发时，如何通过生产日期和VIN码锁定问题批次的范围？' },
            { label: '电器投诉制造端追溯', question: '售后反馈的电器功能类投诉，如何与整车电检历史数据做关联分析追溯制造端原因？' },
            { label: 'VOC关键词情感分析', question: '如何将市场VOC文本通过关键词提取和情感分析，识别用户抱怨最集中的质量维度？' },
            { label: '旧件失效产线对应', question: '三包索赔旧件返回分析后，如何将失效模式与产线过程参数做对应，找潜在失控点？' },
            { label: '售后改进优先级模型', question: '如何建立售后问题的优先级评价模型，综合频次、严重度、用户投诉热度给出改进顺序？' },
            { label: '异响分层共性分析', question: '针对售后出现的底盘异响投诉，如何按区域、里程、使用环境做分层分析找到共性特征？' },
            { label: '改进措施售后效果追踪', question: '如何追踪某项已落地改进措施在售后市场的效果，对比改进前后的索赔率变化？' },
            { label: '批量问题快速围堵', question: '售后市场出现疑似批量问题，如何在48小时内启动快速围堵并给出初步影响范围评估？' },
            { label: '供应商索赔数据拆分', question: '如何将售后索赔数据按供应商或零部件维度拆分，识别由外协件导致的TOP质量问题？' },
            { label: '出口国内售后对比分析', question: '针对出口市场E5的海外售后反馈，如何建立与国内同平台车型的对比分析找出区域差异？' },
            { label: '可靠寿命里程评估', question: '如何利用售后故障间隔里程数据，评估关键零部件的可靠性寿命是否满足设计目标？' },
            { label: '软件版本问题关联定位', question: '售后反馈的软件类问题，如何与车型版本号和OTA升级记录做关联，锁定问题软件版本？' },
            { label: '售后质量月报看板', question: '如何将售后质量数据以月报形式自动汇总，生成各车型质量表现看板和改进任务跟踪表？' },
            { label: '重复维修个案挖掘', question: '针对三包期内重复维修次数高的车辆，如何通过个案分析挖掘共性缺陷线索？' },
            { label: '安全项投诉紧急响应', question: '市场投诉涉及安全或法规项的问题，如何启动紧急响应流程并同步内部升级？' },
            { label: '售后案例经验入库', question: '如何建立售后问题经验库，将已关闭的改进案例结构化入库，供新车型开发时复用？' },
            { label: '区域抱怨环境因素分析', question: '如何分析不同销售区域的质量抱怨差异，识别气候或路况等环境因素对故障的影响？' },
            { label: '续航衰减真因排查', question: '售后市场发现电池续航衰减投诉偏高，如何结合车辆充电数据和BMS日志做衰减真因排查？' },
            { label: '售后反馈主动回访机制', question: '如何建立售后质量问题的客户主动回访机制，确保改进措施真正解决用户痛点？' },
        ]
    },
    'test-verification-agent': {
        name: '数据统计分析预警工作助手',
        desc: '汇聚产销全链条数据，以AI算法分析并预测质量趋势，异常点分级，让决策靠数据说话。',
        questions: [
            { label: 'FTT日周对比查询', question: '如何快速查询昨日整车下线一次合格率（FTT）及各车间直通率，并与周均值做对比？' },
            { label: 'CII异常自动预警规则', question: '白车身关键测点CII指数连续3点下降，系统如何自动判定异常并推送预警通知？' },
            { label: '色差阈值预警设置', question: '如何设置涂装车间面漆色差ΔE值的预警上限，当超出阈值时自动触发邮件或消息提醒？' },
            { label: '扭矩控制图异常判定', question: '总装车间某工位扭矩合格率出现周度下滑趋势，如何用控制图判断是否属于异常波动？' },
            { label: '过程能力月度报告', question: '如何按车型、产线、班次三个维度，自动生成月度过程能力指数（CPK/PPK）汇总报告？' },
            { label: 'Audit趋势预测预警', question: '整车Audit扣分值连续5天高于目标线，系统能否自动做趋势预测并给出超限概率？' },
            { label: 'EOL西格玛水平计算', question: '三电车间电驱EOL测试的扭矩波动数据如何做过程能力分析，当前西格玛水平是多少？' },
            { label: '双车型指标对比看板', question: '如何建立银河E5和银河A7的双车型质量指标对比看板，实时监控差异并突出异常项？' },
            { label: '来料连续不合格预警', question: '来料检验数据中出现同一物料连续两批不合格，系统能否自动标记并提醒潜在批量风险？' },
            { label: '售后CPV预测模型', question: '如何利用历史售后索赔数据建立预测模型，预估新车型上市后首年CPV的区间范围？' },
            { label: '参数周期性波动分析', question: '产线某关键设备的过程参数出现周期性波动，如何进行频谱分析找出波动主频率和可能原因？' },
            { label: '分层级预警规则设定', question: '如何设定质量指标的层级预警线（绿/黄/红），不同颜色触发不同的升级通知对象？' },
            { label: '质量数据清洗方法', question: '批量生产数据中存在缺失值或异常值，如何做数据清洗并确保分析结果的有效性？' },
            { label: '数据异常分布识别', question: '如何对供应商来料质量数据做统计分析，自动识别检验数据造假的异常分布模式？' },
            { label: '多变量偏移共因分析', question: '焊装车间多个测点同时出现尺寸偏移，如何进行多变量分析找出共因，是夹具还是来料导致？' },
            { label: '公差累积模拟评估', question: '如何利用蒙特卡洛模拟方法，评估尺寸链公差累积对最终装配间隙的影响概率？' },
            { label: '故障码时间序列预测', question: '售后市场同一故障码在不同月份的出现频次做时间序列分析，如何预测未来趋势和峰值？' },
            { label: '质量成本结构分析', question: '如何建立质量成本统计分析模板，自动计算内外部失效成本、鉴定成本和预防成本的占比？' },
            { label: '海量数据抽样方案', question: '面对26.2万辆年产量的海量过程数据，如何设定抽样方案确保统计推断的代表性？' },
            { label: '早会看板一键生成', question: '每日早会需要的数据看板，能否实现一键生成，包含FTT、Audit、IPTV、CPV等核心指标？' },
        ]
    },
    'equipment-production-agent': {
        name: '防再发与经验库工作助手',
        desc: '将历史质量问题结构化入库，在合适的时机，自动推送“避坑”措施，有效防止同类缺陷复发。',
        questions: [
            { label: '8D报告结构化入库', question: '如何将已关闭的质量问题8D报告，结构化录入经验库并关联到对应工序、缺陷类型和根本原因？' },
            { label: '历史尺寸链经验检索', question: '新车型导入时，如何一键检索同平台历史车型在焊装尺寸链上的所有经验教训？' },
            { label: '三电绝缘缺陷防再发', question: '如何查询三电系统领域过去三年发生的所有绝缘耐压类缺陷及对应的防再发措施？' },
            { label: '供应商历史问题预警', question: '某个供应商曾在来料上出过批量外观问题，如何在经验库中标记并设置新来料预警联动？' },
            { label: '同类工位防错案例', question: '总装车间某工位发生错装缺陷后，如何在经验库中查找同类工位的防错设计案例并对比借鉴？' },
            { label: '岗位历史教训推送', question: '如何在经验库中设置关键词标签，使新工程师上岗时自动接收与其岗位相关的历史教训推送？' },
            { label: '历史案例相似匹配', question: '某售后投诉与三年前一个已关闭案例高度相似，如何快速调取当年完整的改进轨迹和验证数据？' },
            { label: '措施有效性闭环验证', question: '防再发措施实施后，如何将效果验证数据回传经验库，形成措施有效性的闭环证据链？' },
            { label: '缺陷类型专题库构建', question: '如何按缺陷类型（如异响、漏水、电器失效）构建经验专题库，方便跨车型快速查阅？' },
            { label: 'FMEA历史失效模式调取', question: '新车型FMEA评审时，如何从经验库自动调取对应工序的历史失效模式，辅助风险识别？' },
            { label: '防错方法技术标准', question: '如何确保经验库中收录的防错方法（如传感器防错、工装防错）有明确的技术标准和适用边界？' },
            { label: '右舵专属经验标记', question: '海外出口车出现的右舵特有装配问题，如何标记为右舵专属经验并避免在后续出口车型再现？' },
            { label: '经验库有效性审查', question: '如何定期对经验库中的案例做有效性审查，剔除因工艺变更已不再适用的过时防再发措施？' },
            { label: '缺陷相似度匹配搜索', question: '涂装车间出现新缺陷时，如何在经验库中用缺陷照片或描述文字进行相似度匹配搜索？' },
            { label: '变更触发经验提醒', question: '如何将经验库与变更管理系统联动，当某个工序或零件发生变更时自动推送相关历史问题提醒？' },
            { label: '复盘会推荐方案生成', question: '质量改进科每周的问题复盘会，如何从经验库中自动生成近期高频缺陷及推荐防错方案？' },
            { label: '有效措施标准化升级', question: '某个防再发措施被多次证明有效，如何将其升级为公司级设计规范或工艺标准固化下来？' },
            { label: '经验库价值量化统计', question: '如何统计经验库中各类防再发措施的采用率、成功率和节省的质量成本，量化经验库价值？' },
            { label: '故障现象排查步骤', question: '新工程师独立处理产线异常时，如何在经验库中输入故障现象快速获得排查步骤建议？' },
            { label: '经验库权限分级管理', question: '如何建立经验库的权限分级机制，确保核心工艺经验和供应商敏感信息仅对授权人员可见？' },
        ]
    },
    'lean-improvement-agent': {
        name: '精益提升工作助手',
        desc: '聚焦价值流、七大浪费、标准作业、现场改善与效率提升，推动精益改善闭环。',
        questions: [
            { label: '价值流图分析', question: '如何绘制现状价值流图来识别冲压车间的瓶颈和浪费？' },
            { label: '节拍与线平衡', question: '请帮我计算总装线的节拍时间并分析线平衡率。' },
            { label: '五问法真因查找', question: '如何运用五问法找出焊装飞溅缺陷的真实根本原因？' },
            { label: '标准作业组合票', question: '帮我设计一份用于装配工位的标准作业组合票模板。' },
            { label: '快速换模技法', question: '如何实施快速换模将注塑换模时间缩短50%？' },
            { label: '看板数量计算', question: '怎样根据日均需求和安全库存计算看板张数？' },
            { label: '人机操作分析', question: '给我一个人机操作分析图的绘制方法与优化思路。' },
            { label: '山积图线平衡', question: '请提供一个带山积图的线平衡改善案例。' },
            { label: '防错装置设计', question: '如何设计防错装置防止零件漏装或错装？' },
            { label: '安灯响应流程', question: '如何建立总装车间安灯系统的异常响应与逐级升级流程？' },
            { label: '5S作战', question: '5S红牌作战的推行步骤和评判标准是什么？' },
            { label: '设备综合效率OEE', question: '如何计算设备综合效率OEE并针对性削减六大损失？' },
            { label: 'A3问题解决', question: '用A3报告形式帮我解析涂装一次合格率偏低的问题。' },
            { label: '标准化作业指导', question: '如何编制标准化作业指导书来高效培训多能工？' },
            { label: '价值工程降本', question: '如何运用价值工程在不影响功能的前提下降低单件成本？' },
            { label: 'U型线', question: '如何规划U型生产线布局以实现更有效率的制造？' },
            { label: '鱼骨图原因分析', question: '如何用鱼骨图全面梳理设备微小停机的潜在原因？' },
            { label: 'PDCA改善推进', question: '如何用PDCA循环激发员工改善提案并形成闭环管理？' },
            { label: '过程FMEA分析', question: '请给出焊接缺陷的PFMEA分析表示例和评估要点。' },
            { label: '动作经济原则', question: '如何通过动作经济原则优化装配工位物料摆放与拿取路径？' },
        ]
    },
    'standards-innovation-agent': {
        name: '新工程师质量教练智能体',
        desc: '部门新人占比超90%，提供手把手流程指引、典型缺陷判别训练与即时答疑，如同随身导师，加速新工程师能力提升。',
        questions: [
            { label: '新人岗位职责认知', question: '我是质量改进科的新人，科室的核心职责和与其他科室的协同边界是什么？' },
            { label: '异常处置首步流程', question: '当产线发生质量异常时，我作为质量改进工程师的第一步应该做什么，标准处置流程是怎样的？' },
            { label: '8D报告撰写指南', question: '8D报告怎么写才能逻辑严谨、证据充分，每个步骤的常见误区和填写要求是什么？' },
            { label: '鱼骨图分析法教程', question: '如何进行鱼骨图分析，从人机料法环五个维度系统性地深挖根本原因？' },
            { label: 'QC七大手法应用场景', question: 'QC七大手法分别适用于什么场景，能各举一个汽车制造中的实际应用案例吗？' },
            { label: 'CPK与PPK区分解读', question: 'CPK和PPK的区别是什么，如何正确选择使用并解读计算结果？' },
            { label: '核心质量指标解释', question: '公司对整车Audit评审的QK值目标是多少，日常需要关注哪些核心质量指标（FTT、IPTV、CPV）？' },
            { label: '常用系统查询入门', question: '质量改进科常用的系统和软件有哪些，如何快速学会查询过程数据、Audit记录和售后索赔信息？' },
            { label: '图纸关键特性识读', question: '怎样看一张汽车零部件的图纸，关键特性符号和重要特性符号的区别是什么？' },
            { label: 'MSA判断标准入门', question: '测量系统分析MSA是什么，什么情况下需要做，如何判断测量系统是否合格？' },
            { label: '售后投诉排查链路', question: '当接到售后市场投诉需要排查时，我从哪些数据源入手，如何建立从整车到零件的排查链路？' },
            { label: '四大工艺防错实例', question: '防错法有哪些常见类型，在冲焊涂总四大工艺中各举一个最典型的应用实例？' },
            { label: '来料异常描述填写', question: '遇到疑似来料异常时，我应该如何准确描述问题并正确填写信息，才能有效协同SQE处理？' },
            { label: '新车型质量评审任务', question: '新车型试制阶段，质量改进科需要参与哪些质量评审活动，我在其中负责什么任务？' },
            { label: 'FMEA概念与参与方式', question: 'FMEA是什么，DFMEA和PFMEA有什么区别，我在日常工作中如何参与FMEA活动？' },
            { label: '改进项目立项方法', question: '如何从售后数据或Audit缺陷中提炼出一个清晰的质量问题描述，并启动正式的改进项目？' },
            { label: '三电安全红线流程', question: '对于三电系统高压安全相关缺陷，公司有哪些特殊的升级流程和禁止独自操作的安全红线？' },
            { label: '复盘会组织与跟踪', question: '怎样有效地组织一次质量问题复盘会，会前需要准备什么，会后如何跟踪任务闭环？' },
            { label: '车型常见扣分与历史方案', question: '我所在车型的Audit经常扣分的项目有哪些，如何从经验库中调取类似问题的历史解决方案？' },
            { label: '新员工三月学习路径', question: '作为新员工，有没有推荐的学习路径图，让我在三个月内系统掌握质量改进工程师的必备技能？' },
        ]
    },
};

// 注意：AGENT_WELCOME_CONFIG 的键顺序无关，显示顺序由 sortAgentsByFixedOrder 控制

// 获取智能体欢迎页配置（内置+自定义智能体）
function getAgentWelcomeConfig(agentId) {
    if (AGENT_WELCOME_CONFIG[agentId]) return AGENT_WELCOME_CONFIG[agentId];
    const agent = myAgents.find(a => a.id === agentId);
    if (agent) {
        return {
            name: agent.name,
            desc: agent.task || '专属AI智能体',
            questions: ['介绍一下你的能力', '帮我分析一个问题', '给我一些建议', '常见的注意事项有哪些？']
        };
    }
    return null;
}

function forceCorrectAgents() {
    let existing = [];
    try { existing = JSON.parse(localStorage.getItem('forgeAgents') || '[]'); } catch(e) { existing = []; }
    const existingMap = {};
    existing.forEach(a => { existingMap[a.id] = a; });

    const defaults = {
        'digital-zheng-teacher-agent': { name: '数字郑老师', task: '你是郑伟老师AI分身，面向贵阳吉利汽车质量改进与精益工作，负责专业答疑、方法辅导、案例复盘和知识传承。你必须始终自称“郑伟老师AI分身”，绝不自称“小智”“企业智能助手”或其他名称；即使用户只输入问候、标点或简短内容，也要保持郑伟老师AI分身的身份。请始终优先检索本助手独立知识库中的资料后回答专业问题，并明确区分知识库事实与通用建议。', summary: '质量改进与精益专业辅导' },
        'dfmea-risk-agent': { name: '整车制造过程改进工作助手', task: '关注冲焊涂总四大工艺关键特性，智能诊断尺寸偏差与焊接飞溅等顽疾，驱动过程能力指数提升，夯实大批量制造质量。', summary: '整车制造过程改进' },
        'part-design-agent': { name: '三电系统质量改进工作助手', task: '围绕电池、电机、电控，关注绝缘耐压、气密性等核心参数，利用特征分析锁定失效真因，守护新能源安全底线。', summary: '三电系统质量改进' },
        'simulation-optimization-agent': { name: '整车评审与AUDIT工作助手', task: '依照AUDIT标准进行整车静态、动态评审，数字化记录扣分项，智能分级分类，精准拉动责任单位快速整改，提升整车感官与功能品质。', summary: '整车评审与AUDIT' },
        'ee-design-agent': { name: '供应商来料协同工作助手', task: '和SQE部门协同，针对百家供应商，确保零部件高质量入厂。', summary: '供应商来料协同' },
        'embedded-software-agent': { name: '售后市场质量改进工作助手', task: '打通市场、三包维修数据，智能聚类高频故障，快速启动优先改进，提升出口及国内用户满意度。', summary: '售后市场质量改进' },
        'test-verification-agent': { name: '数据统计分析预警工作助手', task: '汇聚产销全链条数据，以AI算法分析并预测质量趋势，异常点分级，让决策靠数据说话。', summary: '数据统计分析预警' },
        'equipment-production-agent': { name: '防再发与经验库工作助手', task: '将历史质量问题结构化入库，在合适的时机，自动推送“避坑”措施，有效防止同类缺陷复发。', summary: '防再发与经验库' },
        'lean-improvement-agent': { name: '精益提升工作助手', task: '你是贵阳吉利汽车的精益提升工作助手，聚焦价值流分析、七大浪费识别、标准作业、现场5S、产线平衡、快速换模和持续改善。请始终优先检索本助手独立知识库中的精益标准、改善案例和现场资料后回答问题。', summary: '精益改善与效率提升' }
    };

    const correctAgents = Object.keys(defaults).map(id => {
        const def = defaults[id];
        const ex = existingMap[id];
        return {
            id: id,
            name: def.name,
            task: ex ? (ex.task || def.task) : def.task,
            summary: ex ? (ex.summary || def.summary) : def.summary,
            mode: 'agent',
            created_at: ex ? (ex.created_at || 0) : 0,
            updated_at: ex ? (ex.updated_at || null) : null,
            chat_ids: ex ? (ex.chat_ids || []) : []
        };
    });

    localStorage.setItem('forgeAgents', JSON.stringify(correctAgents));
    return correctAgents;
}

function filterAgents(agents) {
    if (!agents || !Array.isArray(agents)) return sortAgentsByFixedOrder(forceCorrectAgents());
    // 保留内置智能体 + 用户动态创建的智能体（agent_ 开头）
    const filtered = agents
        .filter(a => ALLOWED_AGENT_IDS.includes(a.id) || (a.id && a.id.startsWith('agent_')))
        .map(a => BUILTIN_AGENT_NAMES[a.id] ? { ...a, name: BUILTIN_AGENT_NAMES[a.id] } : a);
    // 确保内置智能体一定存在
    const hasBuiltIn = ALLOWED_AGENT_IDS.every(id => filtered.some(a => a.id === id));
    if (!hasBuiltIn) return sortAgentsByFixedOrder(forceCorrectAgents());
    return sortAgentsByFixedOrder(filtered);
}

let myAgents = filterAgents((function() { try { return JSON.parse(localStorage.getItem('forgeAgents') || 'null'); } catch(e) { return null; } })());
let currentAgentId = null;
let agentKbUploadMode = false;

function _resolveMergeDirection(local, serverAgent) {
    // BUG FIX: Improved timestamp-based merge logic for prompt sync across browsers
    // If server has updated_at but local doesn't, prefer server data
    if (serverAgent.updated_at && !local.updated_at) return true;
    // If local has updated_at but server doesn't, prefer local data
    if (local.updated_at && !serverAgent.updated_at) return false;
    // Otherwise compare timestamps
    const localTime = local.updated_at || local.created_at || 0;
    const serverTime = serverAgent.updated_at || serverAgent.created_at || 0;
    return serverTime > localTime;
}

async function saveAgents() {
    // 过滤：只保留允许的智能体
    myAgents = filterAgents(myAgents);
    localStorage.setItem('forgeAgents', JSON.stringify(myAgents));
    // [#12] 同步到服务器：检测数据是否真变了（chat_ids变化不算，服务端不存chat_ids）
    if (currentUser && authToken) {
        try {
            const agentsForServer = myAgents.map(a => ({
                id: a.id, name: a.name, task: a.task, mode: a.mode, created_at: a.created_at, updated_at: a.updated_at
            }));
            const newHash = JSON.stringify(agentsForServer);
            if (newHash === _lastSyncedAgentsHash) {
                console.log('[saveAgents] 数据未变化，跳过POST');
                return;
            }
            _lastSyncedAgentsHash = newHash;
            const resp = await fetch('/api/v1/agents/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                body: JSON.stringify({ agents: agentsForServer })
            });
            const data = await resp.json();
            if (data.success && data.agents && data.agents.length > 0) {
                // Merge: preserve local chat_ids, use timestamp-based comparison for name/task/updated_at
                const localAgents = JSON.parse(localStorage.getItem('forgeAgents') || '[]');
                const localMap = {};
                localAgents.forEach(a => { localMap[a.id] = a; });
                const mergedAgents = data.agents.map(serverAgent => {
                    const local = localMap[serverAgent.id];
                    if (!local) return { ...serverAgent, chat_ids: [] };
                    const useServer = _resolveMergeDirection(local, serverAgent);
                    return {
                        ...serverAgent,
                        name: useServer ? serverAgent.name : (local.name || serverAgent.name),
                        task: useServer ? serverAgent.task : (local.task || serverAgent.task),
                        summary: local.summary || serverAgent.summary || '',
                        updated_at: useServer ? (serverAgent.updated_at || null) : (local.updated_at || null),
                        chat_ids: local.chat_ids || []
                    };
                });
                myAgents = filterAgents(mergedAgents);
                localStorage.setItem('forgeAgents', JSON.stringify(myAgents));
            }
        } catch (e) {
            console.warn('[智能体同步失败]', e);
        }
    }
}

async function syncAgentsFromServer(force = false) {
    // [#12] 防抖锁：5秒内不重复同步（除非 force=true）
    if (!force && _syncAgentsLock) return;
    const now = Date.now();
    if (!force && (now - _syncAgentsLastTime) < _SYNC_AGENTS_COOLDOWN) return;
    _syncAgentsLock = true;
    _syncAgentsLastTime = now;

    // 从服务器拉取最新智能体数据并合并（保留本地 chat_ids）
    // 修复跨浏览器同步：先GET服务器数据，再与本地比较，只有本地更新时才POST
    if (!currentUser || !authToken) { _syncAgentsLock = false; return; }
    try {
        // Step 1: GET 服务器最新数据（不发送本地数据，避免旧数据覆盖服务器）
        const getResp = await fetch('/api/v1/agents', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + authToken }
        });
        const getData = await getResp.json();
        
        if (getData.success && getData.agents && getData.agents.length > 0) {
            const serverAgents = getData.agents;
            const localAgents = JSON.parse(localStorage.getItem('forgeAgents') || '[]');
            const localMap = {};
            localAgents.forEach(a => { localMap[a.id] = a; });
            
            // Step 2: 比较时间戳，合并数据
            let localHasNewer = false;
            const mergedAgents = serverAgents.map(serverAgent => {
                const local = localMap[serverAgent.id];
                if (!local) return { ...serverAgent, chat_ids: [] };
                const useServer = _resolveMergeDirection(local, serverAgent);
                if (!useServer) localHasNewer = true; // 本地有更新的数据
                return {
                    ...serverAgent,
                    name: useServer ? serverAgent.name : (local.name || serverAgent.name),
                    task: useServer ? serverAgent.task : (local.task || serverAgent.task),
                    summary: local.summary || serverAgent.summary || '',
                    updated_at: useServer ? (serverAgent.updated_at || null) : (local.updated_at || null),
                    chat_ids: local.chat_ids || []
                };
            });
            
            myAgents = filterAgents(mergedAgents);
            localStorage.setItem('forgeAgents', JSON.stringify(myAgents));
            
            // Step 3: 只有本地有更新数据时才POST到服务器
            if (localHasNewer) {
                const agentsForServer = myAgents.map(a => ({
                    id: a.id, name: a.name, task: a.task, mode: a.mode, 
                    created_at: a.created_at, updated_at: a.updated_at
                }));
                // [#12] 计算数据指纹，检测是否真变了（避免无变化的写操作）
                const newHash = JSON.stringify(agentsForServer);
                if (newHash !== _lastSyncedAgentsHash) {
                    _lastSyncedAgentsHash = newHash;
                    try {
                        await fetch('/api/v1/agents/sync', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                            body: JSON.stringify({ agents: agentsForServer })
                        });
                    } catch (postErr) {
                        console.warn('[智能体POST同步失败]', postErr);
                    }
                } else {
                    console.log('[sync] 数据未变化，跳过POST');
                }
            }
        }

        // Rebuild chat_ids from server data
        await rebuildChatIdsFromServer();
        renderMyAgents();
    } catch (e) {
        console.warn('[智能体同步失败]', e);
    } finally {
        _syncAgentsLock = false;
    }
}
// BUG FIX: Rebuild agent.chat_ids from server chat data to restore agent-chat associations
// after refresh/cross-browser where local chat_ids are lost
async function rebuildChatIdsFromServer() {
    if (!currentUser || !authToken) return;
    try {
        const resp = await fetch(`/api/v1/chats?username=${encodeURIComponent(currentUser)}`, { headers: apiHeaders() });
        const data = await resp.json();
        console.log('[rebuildChatIds] server chats:', data);
        if (data.success && data.chats) {
            const serverChats = data.chats;
            myAgents.forEach(agent => {
                // Find all chats where chat.agent_id matches this agent's id
                const matchingChatIds = serverChats
                    .filter(chat => chat.agent_id === agent.id)
                    .map(chat => chat.chat_id);
                console.log(`[rebuildChatIds] Agent ${agent.name} (${agent.id}): found ${matchingChatIds.length} chats`);
                // Merge: add any new server chat_ids
                const existingIds = new Set(agent.chat_ids || []);
                matchingChatIds.forEach(id => existingIds.add(id));
                agent.chat_ids = Array.from(existingIds);
            });
            localStorage.setItem('forgeAgents', JSON.stringify(myAgents));
            console.log('[rebuildChatIds] Rebuilt chat_ids from server');
        }
    } catch (e) {
        console.warn('[rebuildChatIds失败]', e);
    }
}

function generateAgentId() {
    return 'agent_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function openAgentCreateModal() {
    document.getElementById('agentName').value = '';
    document.getElementById('agentTask').value = '';
    document.getElementById('agentCreateModal').classList.add('show');
    setTimeout(() => document.getElementById('agentName').focus(), 100);
}

function closeAgentCreateModal() {
    document.getElementById('agentCreateModal').classList.remove('show');
}

async function createAgent() {
    const name = document.getElementById('agentName').value.trim();
    const task = document.getElementById('agentTask').value.trim();
    if (!name) { showToast('请输入智能体名称'); return; }
    if (!task) { showToast('请输入任务描述'); return; }
    
    const agent = {
        id: generateAgentId(),
        name: name,
        task: task,
        mode: 'agent',
        created_at: Date.now() / 1000,
        chat_ids: []
    };
    myAgents.push(agent);
    saveAgents();
    closeAgentCreateModal();
    
    // Switch to the new agent
    await switchToAgent(agent.id);
    renderMyAgents();
    showToast(`智能体「${name}」锻造成功！`);
}

function deleteAgent(agentId) {
    const agent = myAgents.find(a => a.id === agentId);
    if (!agent) return;
    // 禁止删除内置智能体
    if (ALLOWED_AGENT_IDS.includes(agentId)) {
        showToast('内置智能体不可删除');
        return;
    }
    if (!confirm(`确定删除智能体「${agent.name}」？相关对话和知识库也将被删除。`)) return;
    
    // 先删除服务器端的知识库
    fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/knowledge`, { method: 'DELETE', headers: apiHeaders() })
        .then(r => r.json())
        .then(data => console.log('[KB删除]', data))
        .catch(e => console.warn('[KB删除失败]', e));
    
    myAgents = sortAgentsByFixedOrder(myAgents.filter(a => a.id !== agentId));
    saveAgents();
    
    if (currentAgentId === agentId) {
        currentAgentId = null;
        agentKbUploadMode = false;
        document.getElementById('kbUploadToggle').classList.remove('active');
        document.getElementById('agentKbBar').style.display = 'none';
        modeChatId['agent'] = null;
        document.getElementById('chatTitle').textContent = '质量改进/精益 智能体';
        updateKbUploadVisibility();
        updateHeaderKbVisibility();
    }
    renderMyAgents();
    loadChatList();
    showToast('智能体已删除');
}

async function switchToAgent(agentId) {
    const agent = myAgents.find(a => a.id === agentId);
    if (!agent) return;

    // [BUG FIX #2] 切换智能体时中断正在进行的流式响应
    // 防止旧SSE流在后台继续运行导致 isLoading 锁死、新聊天无法发送消息
    stopGeneration();

    currentAgentId = agentId;

    // Force agent mode (智能体强制使用agent模式)
    if (currentMode !== 'agent') {
        switchMode('agent');
    }

    // 智能体模式默认开启联网搜索
    if (!webSearchEnabled) {
        webSearchEnabled = true;
        document.getElementById('webSearchToggle').classList.add('active');
        localStorage.setItem('webSearch', '1');
    }

    // Update header title
    document.getElementById('chatTitle').textContent = agent.name;

    // 更新知识库按钮可见性（选中智能体时显示📚）
    updateKbUploadVisibility();
    updateHeaderKbVisibility();

    // Render agents list
    renderMyAgents();
    
    // 点击智能体：显示空白对话页面（含智能体欢迎信息）
    currentChatId = null;
    modeChatId['agent'] = null;
    clearChatUI();
    renderChatList();
    // 确保欢迎页可见
    const welcomeEl = document.getElementById('welcomeCenter');
    if (welcomeEl) welcomeEl.style.display = '';
    const chatContent = document.getElementById('chatContent');
    if (chatContent) chatContent.classList.add('centered');
}

function renderMyAgents() {
    const list = document.getElementById('myAgentsList');
    if (!list) return;
    list.innerHTML = '';

    myAgents.forEach(agent => {
        if (agent.id === 'dfmea-risk-agent') {
            const divider = document.createElement('div');
            divider.className = 'agent-group-divider';
            divider.textContent = '工作助手：';
            list.appendChild(divider);
        }
        const item = document.createElement('div');
        item.className = `agent-item${agent.id === currentAgentId ? ' active' : ''}`;
        item.setAttribute('data-agent-id', agent.id);
        const initial = (agent.name && agent.name[0] || '?').toUpperCase();
        item.innerHTML = `
            <div class="agent-item-info">
                <div class="agent-item-name">${escapeHtml(agent.name)}</div>
            </div>
            <button class="agent-action-btn new-chat" data-action="new-chat" data-agent-id="${agent.id}" title="新建对话" aria-label="新建对话"><svg width="22" height="22" viewBox="0 0 24 24" class="agent-new-chat-icon"><rect x="1" y="1" width="22" height="22" rx="6" ry="6" fill="#1051BF"/><path d="M9.5 6.5L18.5 12L9.5 17.5Z" fill="white"/></svg></button>
        `;
        list.appendChild(item);
    });

    // 事件委托：在列表容器上统一处理点击，避免 innerHTML 后事件丢失
    list.onclick = function(e) {
        const newChatBtn = e.target.closest('[data-action="new-chat"]');
        if (newChatBtn) {
            e.stopPropagation();
            e.preventDefault();
            const aid = newChatBtn.getAttribute('data-agent-id');
            console.log('[事件委托] 新建对话按钮点击, agentId=', aid);
            if (aid) {
                createNewChatForAgent(aid);
            }
            return;
        }
        const agentItem = e.target.closest('.agent-item');
        if (agentItem) {
            const aid = agentItem.getAttribute('data-agent-id');
            if (aid) {
                switchToAgent(aid);
                closeSidebarOnMobile();
            }
        }
    };
}

// ===== Agent Edit (disabled - prompt no longer user-editable) =====
let editingAgentId = null;

async function createNewChatForAgent(agentId) {
    console.log('[新建对话] 开始, agentId=', agentId, 'currentUser=', currentUser, 'currentMode=', currentMode);
    if (!currentUser) {
        console.warn('[新建对话] 未登录，跳过');
        showToast('请先登录');
        return;
    }

    // 切换到该智能体
    currentAgentId = agentId;
    currentMode = 'agent';
    localStorage.setItem('chatMode', 'agent');

    // 更新模式切换按钮样式
    const modeChatBtn = document.getElementById('modeChat');
    const modeAgentBtn = document.getElementById('modeAgent');
    if (modeChatBtn) modeChatBtn.classList.toggle('active', false);
    if (modeAgentBtn) modeAgentBtn.classList.toggle('active', true);

    try {
        const agent = myAgents.find(a => a.id === agentId);
        const chatTitle = agent ? agent.name : '新对话';
        console.log('[新建对话] 发送POST请求, title=', chatTitle, 'agent_id=', agentId);

        const resp = await fetch(`/api/v1/chats?username=${encodeURIComponent(currentUser)}&title=${encodeURIComponent(chatTitle)}&mode=agent&agent_id=${encodeURIComponent(agentId)}`, {
            method: 'POST',
            headers: apiHeaders()
        });
        const data = await resp.json();
        console.log('[新建对话] API返回:', JSON.stringify(data));

        if (data.success && data.chat) {
            currentChatId = data.chat.chat_id;
            modeChatId['agent'] = currentChatId;

            // 关联智能体
            if (agent) {
                if (!agent.chat_ids) agent.chat_ids = [];
                if (!agent.chat_ids.includes(data.chat.chat_id)) agent.chat_ids.push(data.chat.chat_id);
                agentActiveChatId[agentId] = data.chat.chat_id;
                saveAgentActiveChatIds();
                saveAgents();
            }

            // 刷新聊天列表
            await loadChatList();

            // 清空聊天区域，显示新对话界面
            clearChatUI();

            // 显示智能体专属欢迎页（居中模式）
            const welcomeEl = document.getElementById('welcomeCenter');
            if (welcomeEl) welcomeEl.style.display = '';
            const chatContent = document.getElementById('chatContent');
            if (chatContent) chatContent.classList.add('centered');
            updateWelcomeContent();

            // 刷新智能体列表高亮
            renderMyAgents();

            // 更新标题
            const titleEl = document.getElementById('chatTitle');
            if (titleEl && agent) titleEl.textContent = agent.name;

            // 更新知识库按钮
            updateKbUploadVisibility();
            updateHeaderKbVisibility();

            // 移动端关闭侧边栏
            closeSidebarOnMobile();

            showToast('已创建新对话');

            // 聚焦输入框
            setTimeout(() => {
                const input = document.getElementById('messageInput') || document.getElementById('msgInput');
                if (input) input.focus();
            }, 100);

            console.log('[新建对话] 完成, chatId=', currentChatId);
        } else {
            console.error('[新建对话] API返回失败:', data);
            showToast('创建对话失败');
        }
    } catch (e) {
        console.error('[新建对话] 异常:', e);
        showToast('创建对话异常: ' + e.message);
    }
}

function toggleMyAgents() {
    // No longer a collapsible section - agents are always visible in sidebar
    // This function kept for compatibility but does nothing
}

// ===== Agent KB Upload Toggle & Header KB Button Visibility =====
function updateHeaderKbVisibility() {
    const btn = document.getElementById('headerKbBtn');
    const skillsWrapper = document.getElementById('skillsWrapper');
    const skillsBtn = document.getElementById('headerSkillsBtn');
    const skillsText = skillsBtn ? skillsBtn.querySelector('.kb-btn-text') : null;
    if (skillsBtn) {
        skillsBtn.title = '质量工具Skills';
        skillsBtn.setAttribute('aria-label', '质量工具Skills');
    }
    if (skillsText) skillsText.textContent = '质量工具Skills';
    if (!btn) return;
    // 只在选中了某个智能体时才显示 header 知识库按钮和 Skills 按钮
    if (currentAgentId) {
        btn.style.display = 'inline-flex';
        if (skillsWrapper) skillsWrapper.style.display = 'inline-block';
    } else {
        btn.style.display = 'none';
        if (skillsWrapper) skillsWrapper.style.display = 'none';
        // 同时关闭知识库页面
        const kbPage = document.getElementById('kbPage');
        if (kbPage && kbPage.style.display !== 'none') {
            hideKbPage();
        }
    }
}

function updateKnowledgePermissionUi() {
    const uploadAllowed = canUploadKnowledgeBase();
    const deleteAllowed = canDeleteKnowledgeBase();
    ['uploadZone', 'kbPageUploadZone'].forEach(id => {
        const zone = document.getElementById(id);
        if (zone) zone.style.display = uploadAllowed ? '' : 'none';
    });
    ['kbFileInput', 'kbPageFileInput'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.disabled = !uploadAllowed;
    });
    const desc = document.getElementById('kbPageDesc');
    if (desc && currentAgentId) {
        if (!uploadAllowed) desc.textContent = '当前账号仅可查看该知识库，不能上传或删除文档';
        else if (!deleteAllowed) desc.textContent = '当前账号可上传和查看文档，但不能删除文档';
    }
}

function updateKbUploadVisibility() {
    const kbBtn = document.getElementById('kbUploadToggle');
    // 只在当前账号对所选知识库有上传权限时显示
    if (currentMode === 'agent' && canUploadKnowledgeBase()) {
        kbBtn.style.display = '';
    } else {
        kbBtn.style.display = 'none';
        // 同时关闭知识库上传模式
        if (agentKbUploadMode) {
            agentKbUploadMode = false;
            kbBtn.classList.remove('active');
            document.getElementById('agentKbBar').style.display = 'none';
        }
    }
}

function toggleAgentKbUpload() {
    if (!currentAgentId) {
        showToast('请先选择或创建一个智能体');
        return;
    }
    if (!canUploadKnowledgeBase()) {
        showToast('当前账号无权向数字郑老师知识库上传文档');
        return;
    }
    agentKbUploadMode = !agentKbUploadMode;
    document.getElementById('kbUploadToggle').classList.toggle('active', agentKbUploadMode);
    document.getElementById('kbUploadToggle').setAttribute('aria-pressed', agentKbUploadMode);
    document.getElementById('agentKbBar').style.display = agentKbUploadMode ? 'flex' : 'none';
}

// 每个模式独立记录当前会话ID，切换模式时恢复
let modeChatId = { agent: null, chat: null };
// Per-agent active chat tracking for conversation isolation
let agentActiveChatId = {};
// 初始化所有允许智能体的活跃聊天ID
ALLOWED_AGENT_IDS.forEach(id => { agentActiveChatId[id] = null; });

function saveAgentActiveChatIds() {
    localStorage.setItem('agentActiveChatIds', JSON.stringify(agentActiveChatId));
}

function loadAgentActiveChatIds() {
    try {
        const saved = localStorage.getItem('agentActiveChatIds');
        if (saved) agentActiveChatId = JSON.parse(saved);
    } catch(e) {}
}

// Load per-agent active chat IDs at startup
loadAgentActiveChatIds();

// ===== API Helper (with JWT Token) =====
function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
        headers['Authorization'] = 'Bearer ' + authToken;
    }
    return headers;
}

// ===== Theme =====
function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
    document.getElementById('themeBtn').textContent = isDark ? '🌙' : '☀️';
}

(function initTheme() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();

// ===== Web Search Toggle =====
function toggleWebSearch() {
    webSearchEnabled = !webSearchEnabled;
    const btn = document.getElementById('webSearchToggle');
    btn.classList.toggle('active', webSearchEnabled);
    localStorage.setItem('webSearch', webSearchEnabled ? '1' : '0');
}

(function initWebSearch() {
    const saved = localStorage.getItem('webSearch');
    if (saved === '1') {
        webSearchEnabled = true;
        document.getElementById('webSearchToggle').classList.add('active');
    }
})();

// ===== Mode Switch =====
function switchMode(mode) {
    if (currentMode === mode) return;

    // Before switching away from agent mode, save the current agent's active chat
    if (currentMode === 'agent' && currentAgentId) {
        agentActiveChatId[currentAgentId] = currentChatId;
        saveAgentActiveChatIds();
    }

    // 保存当前模式的 chatId
    modeChatId[currentMode] = currentChatId;

    currentMode = mode;
    localStorage.setItem('chatMode', mode);

    document.getElementById('modeChat').classList.toggle('active', mode === 'chat');
    document.getElementById('modeAgent').classList.toggle('active', mode === 'agent');

    const webToggle = document.getElementById('webSearchToggle');
    const thinkToggle = document.getElementById('deepThinkToggle');

    if (mode === 'chat') {
        webToggle.style.display = '';
        thinkToggle.classList.add('visible');
    } else {
        webToggle.style.display = '';
        thinkToggle.classList.remove('visible');
        thinkToggle.classList.remove('active');
        deepThinkEnabled = false;
    }

    const titleEl = document.getElementById('chatTitle');
    if (titleEl) {
        if (mode === 'agent' && currentAgentId) {
            const agent = myAgents.find(a => a.id === currentAgentId);
            titleEl.textContent = agent ? agent.name : '质量改进/精益 智能体';
        } else {
            titleEl.textContent = mode === 'agent' ? '质量改进/精益 智能体' : 'Chat';
        }
    }
    // Reset agent when switching to chat mode
    if (mode === 'chat') {
        currentAgentId = null;
        renderMyAgents();
    }

    // After switching to agent mode, restore from agentActiveChatId
    if (mode === 'agent' && currentAgentId) {
        const lastChat = agentActiveChatId[currentAgentId];
        if (lastChat) {
            modeChatId['agent'] = lastChat;
        }
    }

    // 更新知识库上传按钮可见性
    updateKbUploadVisibility();
    updateHeaderKbVisibility();

    // 切换模式时更新欢迎页内容
    updateWelcomeContent();

    // 切换模式时：筛选该模式的历史对话，恢复该模式上次的会话
    renderChatList();
    restoreModeChat();
}

// 恢复当前模式上次的活跃会话，如果没有则新建
async function restoreModeChat() {
    const modeChats = getModeChats();
    const savedId = modeChatId[currentMode];
    if (modeChats.length === 0) {
        // 该模式没有会话，新建一个
        await createNewChat();
    } else if (savedId && modeChats.some(c => c.chat_id === savedId)) {
        // 恢复上次该模式的会话
        currentChatId = savedId;
        renderChatList();
        await loadChatHistory(savedId);
    } else {
        // 选择该模式的第一个会话
        currentChatId = modeChats[0].chat_id;
        modeChatId[currentMode] = currentChatId;
        renderChatList();
        await loadChatHistory(currentChatId);
    }
}

// 判断对话是否属于某个智能体（同时参考本地 chat_ids 和服务端 agent_id）
function chatBelongsToAgent(chat, agentId) {
    // 1. 检查本地 localStorage 的 chat_ids
    const agent = myAgents.find(a => a.id === agentId);
    if (agent && agent.chat_ids && agent.chat_ids.includes(chat.chat_id)) {
        return true;
    }
    // 2. 检查服务端返回的 agent_id 字段（跨浏览器同步的关键）
    if (chat.agent_id && chat.agent_id === agentId) {
        return true;
    }
    return false;
}

// 判断对话是否属于任意智能体
function chatBelongsToAnyAgent(chat) {
    return myAgents.some(agent => chatBelongsToAgent(chat, agent.id));
}

// 获取当前模式的会话列表
function getModeChats() {
    // Chat mode: show chats with mode='chat'
    if (currentMode === 'chat') {
        return allChats.filter(chat => chat.mode === 'chat');
    }
    // Agent mode with specific agent: show that agent's chats
    if (currentMode === 'agent' && currentAgentId) {
        return allChats.filter(chat => chatBelongsToAgent(chat, currentAgentId));
    }
    // Agent mode but no specific agent: show agent-mode chats not belonging to any agent
    if (currentMode === 'agent' && !currentAgentId) {
        return allChats.filter(chat => {
            const modeMatch = chat.mode === 'agent' || (!chat.mode && currentMode === 'agent');
            if (!modeMatch) return false;
            return !chatBelongsToAnyAgent(chat);
        });
    }
    return [];
}

(function initMode() {
    const saved = localStorage.getItem('chatMode');
    if (saved === 'chat') {
        currentMode = 'chat';
        localStorage.setItem('chatMode', 'chat');
        document.getElementById('modeChat').classList.add('active');
        document.getElementById('modeAgent').classList.remove('active');
    }
    // 初始化时根据状态决定知识库按钮可见性
    updateKbUploadVisibility();
    updateHeaderKbVisibility();
})();

// ===== Deep Think Toggle =====
function toggleDeepThink() {
    deepThinkEnabled = !deepThinkEnabled;
    const btn = document.getElementById('deepThinkToggle');
    btn.classList.toggle('active', deepThinkEnabled);
    localStorage.setItem('deepThink', deepThinkEnabled ? '1' : '0');
}

(function initDeepThink() {
    const saved = localStorage.getItem('deepThink');
    if (saved === '1' && currentMode === 'chat') {
        deepThinkEnabled = true;
        document.getElementById('deepThinkToggle').classList.add('active');
    }
})();

// ===== Marked Config =====
if (typeof marked !== 'undefined') {
    marked.setOptions({
        highlight: function(code, lang) {
            if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
            }
            if (typeof hljs !== 'undefined') {
                try { return hljs.highlightAuto(code).value; } catch (e) {}
            }
            return code;
        },
        breaks: true,
        gfm: true,
    });

    const renderer = new marked.Renderer();
    renderer.code = function(code, language, escaped) {
        let codeText = '', lang = '';
        if (typeof code === 'object') {
            codeText = code.text || '';
            lang = code.lang || '';
        } else {
            codeText = code;
            lang = language || '';
        }
        let highlighted;
        if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try { highlighted = hljs.highlight(codeText, { language: lang }).value; } catch (e) { highlighted = escapeHtml(codeText); }
        } else if (typeof hljs !== 'undefined') {
            try { highlighted = hljs.highlightAuto(codeText).value; } catch (e) { highlighted = escapeHtml(codeText); }
        } else {
            highlighted = escapeHtml(codeText);
        }
        const langLabel = lang ? lang : 'code';
        const codeId = 'code-' + Math.random().toString(36).substr(2, 9);
        return `<pre><div class="code-block-header"><span>${langLabel}</span><button class="code-copy-btn" onclick="copyCodeBlock('${codeId}', this)" aria-label="复制代码">复制</button></div><code id="${codeId}" class="hljs language-${lang}">${highlighted}</code></pre>`;
    };
    marked.setOptions({ renderer: renderer });
}

// ===== Toast =====
let _toastTimer = null;
function showToast(msg, duration) {
    duration = duration || 2000;
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { toast.classList.remove('show'); _toastTimer = null; }, duration);
}

// ===== Clipboard =====
function copyToClipboard(text, onSuccess, onFail) {
    // 优先尝试 Clipboard API（需要 HTTPS 或 localhost）
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            if (onSuccess) onSuccess();
        }).catch(() => {
            if (!fallbackCopy(text)) { if (onFail) onFail(); } else { if (onSuccess) onSuccess(); }
        });
        return;
    }
    // HTTP 环境：使用 fallback
    if (!fallbackCopy(text)) { if (onFail) onFail(); } else { if (onSuccess) onSuccess(); }
}

function fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '0';
        ta.style.top = '0';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        ta.setAttribute('readonly', '');
        ta.style.fontSize = '16px'; // 防止 iOS 缩放
        document.body.appendChild(ta);
        ta.focus();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (e) { return false; }
}

// ===== Code Block Copy =====
function copyCodeBlock(codeId, btn) {
    const codeEl = document.getElementById(codeId);
    if (!codeEl) return;
    const text = codeEl.textContent;
    copyToClipboard(text, () => {
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000);
        showToast('代码已复制');
    }, () => { showToast('复制失败'); });
}

// ===== Model Management =====
let currentModelId = 'auto';
let modelSwitchInProgress = false;

async function loadModels() {
    const select = document.getElementById('modelSelect');
    if (!select) return;
    try {
        select.disabled = true;
        const resp = await fetch('/api/v1/models', { headers: apiHeaders() });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data.models) || data.models.length === 0) throw new Error('模型列表为空');
        select.innerHTML = '';
        data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id; opt.textContent = m.name; opt.title = m.desc;
            select.appendChild(opt);
        });
        const hasCurrent = data.models.some(m => m.id === data.current);
        currentModelId = hasCurrent ? data.current : (data.models.some(m => m.id === 'auto') ? 'auto' : data.models[0].id);
        select.value = currentModelId;
        select.title = currentModelId === 'auto'
            ? `Auto：当前实际使用 ${data.effective || 'GLM-5.2'}`
            : `当前模型：${select.options[select.selectedIndex].textContent}`;
    } catch (e) {
        console.error('加载模型列表失败', e);
        select.innerHTML = '<option value="auto">Auto（加载失败）</option>';
        select.value = 'auto';
        currentModelId = 'auto';
        showToast('模型列表加载失败，请稍后重试');
    } finally {
        select.disabled = false;
    }
}

async function switchModel() {
    const select = document.getElementById('modelSelect');
    if (!select || modelSwitchInProgress) return;
    const modelId = select.value;
    const previousModelId = currentModelId;
    if (modelId === previousModelId) return;

    modelSwitchInProgress = true;
    select.disabled = true;
    try {
        const resp = await fetch('/api/v1/models/set', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ model_id: modelId }) });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.message || `HTTP ${resp.status}`);

        currentModelId = data.current || modelId;
        select.value = currentModelId;
        const selectedOption = select.options[select.selectedIndex];
        const name = selectedOption ? selectedOption.textContent : currentModelId;
        select.title = currentModelId === 'auto'
            ? `Auto：当前实际使用 ${data.effective || 'GLM-5.2'}`
            : `当前模型：${name}`;
        showToast(currentModelId === 'auto'
            ? `已切换到 Auto，当前使用 ${data.effective || 'GLM-5.2'}`
            : `已切换到模型：${name}`);
    } catch (e) {
        console.error('切换模型失败', e);
        select.value = previousModelId;
        showToast('模型切换失败，已恢复原模型');
    } finally {
        modelSwitchInProgress = false;
        select.disabled = false;
    }
}

// ===== Auth =====
// ===== Login Modal =====
function openLoginModal() {
    document.getElementById('loginModalTitle').textContent = '用户登录';
    document.getElementById('loginModalSubtitle').textContent = 'USERS LOGIN';
    document.getElementById('loginModal').classList.add('show');
    setTimeout(() => document.getElementById('loginUser').focus(), 100);
}

function closeLoginModal() {
    document.getElementById('loginModal').classList.remove('show');
    const loginMsg = document.getElementById('loginMsg');
    if (loginMsg) { loginMsg.textContent = ''; loginMsg.className = 'msg-box'; }
    const regMsg = document.getElementById('regMsg');
    if (regMsg) { regMsg.textContent = ''; regMsg.className = 'msg-box'; }
}

function openTrialModal() {
    document.getElementById('loginModalTitle').textContent = '用户登录';
    document.getElementById('loginModalSubtitle').textContent = 'USERS LOGIN';
    document.getElementById('loginModal').classList.add('show');
    setTimeout(() => document.getElementById('loginUser').focus(), 100);
}

function switchTab(tab) {
    // Tab bar removed from login page, this function is kept for backward compat
    if (document.getElementById('loginForm')) {
        document.getElementById('loginForm').style.display = 'block';
    }
}

// 登录页作为首页：禁止点击背景关闭（已移除关闭按钮）
// 原逻辑：点击overlay背景会关闭登录弹窗，但现在登录页就是首页，不应被关闭
document.addEventListener('click', function(e) {
    // 不再允许通过点击背景关闭登录弹窗
});

// Close modals on Escape key — close the topmost active modal only
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    // Priority: rename > docs > login (topmost first)
    const renameOverlay = document.getElementById('renameOverlay');
    if (renameOverlay && renameOverlay.classList.contains('show')) { cancelRename(); return; }
    const docsModal = document.getElementById('docsModal');
    if (docsModal && docsModal.classList.contains('show')) { closeDocs(); return; }
    const loginModal = document.getElementById('loginModal');
    // 登录页作为首页，Escape键不关闭登录弹窗
    if (loginModal && loginModal.classList.contains('show') && currentUser) { closeLoginModal(); return; }
});

async function doLogin() {
    const username = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value.trim();
    const msgEl = document.getElementById('loginMsg');
    if (!username || !password) { msgEl.className = 'msg-box error'; msgEl.textContent = '请输入用户名和密码'; return; }
    try {
        const resp = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const data = await resp.json();
        if (data.success) {
            currentUser = username;
            userRole = data.role || 'user';
            if (data.token) { authToken = data.token; localStorage.setItem('authToken', data.token); }
            localStorage.setItem('userRole', userRole);
            msgEl.className = 'msg-box success'; msgEl.textContent = '登录成功！';
            setTimeout(async () => {
                // 初始化完成前保持聊天页隐藏，避免默认标题/欢迎页短暂闪现
                document.getElementById('chatPage').style.display = 'none';
                document.getElementById('headerUserName').textContent = username;
                document.getElementById('headerUserAvatar').textContent = username[0].toUpperCase();
                // 显示管理员标识
                if (userRole === 'admin') {
                    document.getElementById('headerUserName').textContent = username + ' (管理员)';
                }
                loadChatList();
                const modelLoadPromise = loadModels();
                await syncAgentsFromServer(true);  // [#12] 登录时强制同步一次，内部已调用 rebuildChatIdsFromServer（会GET /chats）
                await modelLoadPromise;
                renderMyAgents();
                updateKbUploadVisibility();
                updateHeaderKbVisibility();
                // [#14] 默认选中第一个智能体，避免进入空白的agent模式
                if (!currentAgentId && myAgents.length > 0) {
                    await switchToAgent(myAgents[0].id);
                }
                // 智能体、标题和欢迎页都准备好后，再一次性显示聊天页
                document.getElementById('chatPage').style.display = 'flex';
                document.getElementById('loginModal').classList.remove('show');
                document.body.classList.add('body-chat-mode');
                // [BUG FIX] Push history state so browser back button returns to login
                history.pushState({page: 'chat'}, '');
            }, 500);
        } else { msgEl.className = 'msg-box error'; msgEl.textContent = data.message || '登录失败'; }
    } catch (e) { msgEl.className = 'msg-box error'; msgEl.textContent = '网络错误'; }
}

async function doRegister() {
    // 注册功能已禁用，新用户只能由管理员在后端创建
    alert('注册功能已禁用，请联系管理员创建账号');
}

function doLogout() {
    currentUser = null; userRole = null; authToken = null; selectedFile = null; currentChatId = null; allChats = []; currentAgentId = null; agentKbUploadMode = false;
    localStorage.removeItem('authToken');
    localStorage.removeItem('userRole');
    // Hide KB page if open
    const kbPage = document.getElementById('kbPage');
    if (kbPage) kbPage.style.display = 'none';
    document.getElementById('chatPage').style.display = 'none';
    // 登出后直接显示登录页
    document.getElementById('loginModal').classList.add('show');
    document.body.classList.remove('body-chat-mode');
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
    // 清除header用户信息
    const headerUserName = document.getElementById('headerUserName');
    const headerUserAvatar = document.getElementById('headerUserAvatar');
    if (headerUserName) headerUserName.textContent = '';
    if (headerUserAvatar) headerUserAvatar.textContent = '';
    // [BUG FIX] 清除登录消息，避免登出后仍显示"登录成功"
    const logoutMsg = document.getElementById('loginMsg');
    if (logoutMsg) { logoutMsg.textContent = ''; logoutMsg.className = 'msg-box'; }
    updateHeaderKbVisibility();
    // [BUG FIX] Update history state so back button is consistent
    if (history.state && (history.state.page === 'chat' || history.state.page === 'kb')) {
        history.replaceState({page: 'login'}, '');
    }
}

// [BUG FIX] Handle browser back/forward navigation
// When user presses back from chat, return to login page (with logout).
// When user presses forward from login while authenticated, return to chat.
window.addEventListener('popstate', function(e) {
    const loginModal = document.getElementById('loginModal');
    const chatPage = document.getElementById('chatPage');
    const kbPage = document.getElementById('kbPage');
    const chatContent = document.getElementById('chatContent');
    const sidebar = document.getElementById('sidebar');

    if (e.state && e.state.page === 'chat') {
        // 回到聊天页 - 从知识库页返回 或 从登录页前进
        if (currentUser && authToken) {
            // [BUG FIX] 检测是否是 hideKbPage 主动触发的后退（从 kb 返回 chat）
            // 这种情况下绝不连续后退，直接显示 chat 页即可
            const fromKbNavigation = window._navigatingFromKb === true;
            if (fromKbNavigation) {
                // 清除标志位
                window._navigatingFromKb = false;
            } else {
                // 不是 hideKbPage 触发的，是用户主动点浏览器后退按钮
                // 此时 kbPage 本来就是关的，又后退到 chat 条目
                // 说明 history 栈有修复前的存量堆积（[login, chat, chat, ...]）
                // 但为了安全，不自动连续后退（可能误伤其他场景）
                // 只做正常的 UI 切换，让用户多按几次后退到达 login
                // 这样保证不会错误地退出登录
            }
            loginModal.classList.remove('show');
            chatPage.style.display = 'flex';
            document.body.classList.add('body-chat-mode');
            // [BUG FIX] 如果从知识库返回，关闭知识库页，恢复聊天页
            if (kbPage) kbPage.style.display = 'none';
            if (chatContent) chatContent.style.display = 'flex';
            if (sidebar) sidebar.style.display = '';
        } else {
            // Not authenticated anymore, go back to login
            history.replaceState({page: 'login'}, '');
        }
    } else if (e.state && e.state.page === 'kb') {
        // 前进到知识库页（用户按了前进按钮）
        if (currentUser && authToken && currentAgentId) {
            loginModal.classList.remove('show');
            chatPage.style.display = 'flex';
            document.body.classList.add('body-chat-mode');
            if (chatContent) chatContent.style.display = 'none';
            if (kbPage) kbPage.style.display = 'flex';
            // [BUG FIX] 知识库页隐藏侧边栏
            if (sidebar) sidebar.style.display = 'none';
            const sidebarOverlay = document.getElementById('sidebarOverlay');
            if (sidebarOverlay) sidebarOverlay.style.display = 'none';
        } else {
            history.replaceState({page: 'login'}, '');
        }
    } else {
        // Back to login - perform logout to ensure clean state
        if (currentUser) {
            // Clear session but don't push another history entry
            currentUser = null; userRole = null; authToken = null; selectedFile = null; currentChatId = null; allChats = []; currentAgentId = null; agentKbUploadMode = false;
            localStorage.removeItem('authToken');
            localStorage.removeItem('userRole');
            if (kbPage) kbPage.style.display = 'none';
            chatPage.style.display = 'none';
            loginModal.classList.add('show');
            document.body.classList.remove('body-chat-mode');
            document.getElementById('chatMessages').innerHTML = '';
            document.getElementById('loginUser').value = '';
            document.getElementById('loginPass').value = '';
            // [BUG FIX] 清除登录消息，避免回退到登录页后仍显示"登录成功"
            const loginMsg = document.getElementById('loginMsg');
            if (loginMsg) { loginMsg.textContent = ''; loginMsg.className = 'msg-box'; }
            updateHeaderKbVisibility();
        }
    }
});

// ===== Auto-login with JWT token =====
async function tryAutoLogin() {
    const token = localStorage.getItem('authToken');
    if (!token) return false;
    try {
        const resp = await fetch('/api/v1/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
        const data = await resp.json();
        if (data.valid && data.username) {
            currentUser = data.username;
            authToken = token;
            // 初始化完成前保持聊天页隐藏，避免默认标题/欢迎页短暂闪现
            document.getElementById('chatPage').style.display = 'none';
            document.getElementById('headerUserName').textContent = data.username;
            document.getElementById('headerUserAvatar').textContent = data.username[0].toUpperCase();
            loadChatList();
            const modelLoadPromise = loadModels();
            await syncAgentsFromServer(true);  // [#12] 自动登录时强制同步
            await modelLoadPromise;
            renderMyAgents();
            updateKbUploadVisibility();
            updateHeaderKbVisibility();
            // [#14] 默认选中第一个智能体，避免进入空白的agent模式
            if (!currentAgentId && myAgents.length > 0) {
                await switchToAgent(myAgents[0].id);
            }
            document.getElementById('chatPage').style.display = 'flex';
            document.getElementById('loginModal').classList.remove('show');
            document.body.classList.add('body-chat-mode');
            // [BUG FIX] Push history state so browser back button returns to login
            history.pushState({page: 'chat'}, '');
            return true;
        }
    } catch (e) { console.warn('自动登录失败', e); }
    localStorage.removeItem('authToken');
    // 自动登录失败：确保登录页可见
    document.getElementById('loginModal').classList.add('show');
    return false;
}

// ===== Centered Mode =====
function updateCenteredMode() {
    const content = document.getElementById('chatContent');
    const messages = document.getElementById('chatMessages');
    const hasMessages = messages.children.length > 0;
    content.classList.toggle('centered', !hasMessages);
    // 更新欢迎页内容（根据当前智能体动态显示）
    updateWelcomeContent();
}

// 根据当前智能体更新欢迎页内容
function updateWelcomeContent() {
    const welcomeEl = document.getElementById('welcomeCenter');
    if (!welcomeEl) return;

    const isZhengTeacher = currentAgentId === DIGITAL_TEACHER_AGENT_ID;
    welcomeEl.classList.toggle('zheng-profile-mode', isZhengTeacher);
    const chatContent = welcomeEl.closest('.chat-content');
    if (chatContent) chatContent.classList.toggle('zheng-welcome-active', isZhengTeacher);
    if (isZhengTeacher) {
        renderZhengTeacherWelcome(welcomeEl);
        return;
    }

    const config = currentAgentId ? getAgentWelcomeConfig(currentAgentId) : null;

    if (config) {
        // 将20个按钮分配到5行，每行至少2个，贪心平衡行宽
        const questions = config.questions;
        const NUM_ROWS = 5;
        let rowsHtml = '';

        if (questions.length === 20) {
            // 估算按钮宽度（与CSS font-size=13px对应）
            const charWidth = (ch) => {
                const code = ch.charCodeAt(0);
                if (code >= 0x4e00 && code <= 0x9fff) return 13; // 中文
                if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)) return 7.8; // 英文/数字
                return 6.5; // 其他
            };
            const estimateWidth = (label) => {
                let w = 0;
                for (const ch of label) w += charWidth(ch);
                return w + 30; // padding 14*2 + border 1*2
            };

            const CONTAINER = 660;
            const GAP = 8;

            // 按宽度降序排列
            const indexed = questions.map((q, i) => ({
                idx: i,
                w: estimateWidth(typeof q === 'object' && q.label ? q.label : String(q))
            }));
            indexed.sort((a, b) => b.w - a.w);

            // 动态选择行模式：检查中间5个按钮能否放进一行
            const middleFiveWidth = indexed.slice(10, 15).reduce((s, x) => s + x.w, 0) + 4 * GAP;

            // 不同智能体使用不同行模式，避免千篇一律
            // 按钮窄的智能体可用双5行模式，按钮宽的用单5行模式
            const agentIndex = ALLOWED_AGENT_IDS.indexOf(currentAgentId);
            const PATTERNS_TWO5 = [
                [3,5,4,5,3], [4,5,3,5,3], [3,5,3,5,4], [5,3,4,5,3], [3,5,5,4,3],
                [5,3,5,4,3], [3,5,4,3,5], [5,4,3,5,3], [3,4,5,3,5], [4,3,5,3,5],
            ];
            const PATTERNS_ONE5 = [
                [3,4,5,4,4], [4,3,5,4,4], [4,4,5,4,3], [4,4,5,3,4], [3,4,4,5,4],
                [4,3,4,5,4], [4,4,3,5,4], [5,4,4,4,3], [3,5,4,4,4], [4,4,4,3,5],
            ];

            const pattern = middleFiveWidth <= CONTAINER
                ? PATTERNS_TWO5[agentIndex >= 0 ? agentIndex % PATTERNS_TWO5.length : 0]
                : PATTERNS_ONE5[agentIndex >= 0 ? agentIndex % PATTERNS_ONE5.length : 0];

            // 按行目标数量分组：宽按钮→少行，窄按钮→多行
            const countToRows = {};
            for (let r = 0; r < NUM_ROWS; r++) {
                const c = pattern[r];
                if (!countToRows[c]) countToRows[c] = [];
                countToRows[c].push(r);
            }

            const rowItems = Array.from({length: NUM_ROWS}, () => []);
            let btnPtr = 0;
            for (const count of Object.keys(countToRows).map(Number).sort((a, b) => a - b)) {
                for (const rowIdx of countToRows[count]) {
                    for (let i = 0; i < count; i++) {
                        rowItems[rowIdx].push(indexed[btnPtr].idx);
                        btnPtr++;
                    }
                }
            }

            // 每行内部交替排列（最宽-最窄-次宽-次窄），增加视觉变化
            for (let r = 0; r < NUM_ROWS; r++) {
                const items = rowItems[r].map(idx => ({
                    idx,
                    w: indexed.find(x => x.idx === idx).w
                }));
                items.sort((a, b) => b.w - a.w);
                const reordered = [];
                let left = 0, right = items.length - 1;
                while (left <= right) {
                    reordered.push(items[left]);
                    if (left !== right) reordered.push(items[right]);
                    left++; right--;
                }
                rowItems[r] = reordered.map(x => x.idx);
            }

            // 生成5行HTML
            for (let r = 0; r < NUM_ROWS; r++) {
                const rowBtns = rowItems[r].map(idx => {
                    const q = questions[idx];
                    if (typeof q === 'object' && q.label) {
                        return `<span class="quick-action" onclick="fillQuick(this)" data-question="${escapeHtml(q.question)}" role="button" tabindex="0">${escapeHtml(q.label)}</span>`;
                    }
                    return `<span class="quick-action" onclick="fillQuick(this)" data-question="${escapeHtml(q)}" role="button" tabindex="0">${escapeHtml(q)}</span>`;
                }).join('');
                rowsHtml += `<div class="kw-row">${rowBtns}</div>`;
            }
        } else {
            // 非20个按钮时，使用原来的flex-wrap布局
            rowsHtml = `<div class="quick-actions${questions.length >= 8 ? ' many-questions' : ''}">` +
                questions.map(q => {
                    if (typeof q === 'object' && q.label) {
                        return `<span class="quick-action" onclick="fillQuick(this)" data-question="${escapeHtml(q.question)}" role="button" tabindex="0">${escapeHtml(q.label)}</span>`;
                    }
                    return `<span class="quick-action" onclick="fillQuick(this)" data-question="${escapeHtml(q)}" role="button" tabindex="0">${escapeHtml(q)}</span>`;
                }).join('') +
                `</div>`;
        }

        // 智能体专属欢迎页
        welcomeEl.innerHTML = `
            <h2 class="welcome-agent-name">${escapeHtml(config.name)}</h2>
            <p class="welcome-agent-desc">${escapeHtml(config.desc)}</p>
            <p class="welcome-agent-hint">(只有在知识库丰富且准确，智能体才能发挥最大作用)</p>
            <div class="quick-actions many-questions kw-five-rows">
                ${rowsHtml}
            </div>
            <p class="welcome-keyword-hint">(提示词仅供参考，需根据自己工作，进行修改)</p>
        `;
    } else {
        // 默认欢迎页
        welcomeEl.innerHTML = `
            <h2>质量改进/精益 智能体</h2>
            <p>面向质量改进与精益工作的专业智能体</p>
            <div class="quick-actions">
                <span class="quick-action" onclick="fillQuick(this)" data-question="模具设计评审有哪些关键节点？" role="button" tabindex="0">设计评审</span>
                <span class="quick-action" onclick="fillQuick(this)" data-question="VDA6.4过程审核要点是什么？" role="button" tabindex="0">过程审核</span>
                <span class="quick-action" onclick="fillQuick(this)" data-question="帮我分析DFMEA风险" role="button" tabindex="0">DFMEA分析</span>
                <span class="quick-action" onclick="fillQuick(this)" data-question="不合格品纠正措施怎么制定？" role="button" tabindex="0">CAPA建议</span>
            </div>
        `;
    }
}

// 数字郑老师不显示关键词问题，使用人物资料卡专属欢迎页。
// 用户发送第一条消息后，updateCenteredMode 会自动隐藏整个欢迎页。
function renderZhengTeacherWelcome(welcomeEl) {
    const profile = ZHENG_TEACHER_PROFILE;
    const defaultSection = profile.sections.expertise;
    const tagsHtml = profile.tags
        .map(tag => `<span class="zheng-profile-tag">${escapeHtml(tag)}</span>`)
        .join('');
    const tabsHtml = Object.entries(profile.sections)
        .map(([key, section], index) => `
            <button class="zheng-profile-tab${index === 0 ? ' active' : ''}"
                    type="button" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}"
                    data-profile-tab="${escapeHtml(key)}"
                    onclick="showZhengProfileTab(this, '${escapeHtml(key)}')">
                ${escapeHtml(section.label)}
            </button>`)
        .join('');

    welcomeEl.innerHTML = `
        <section class="zheng-profile-welcome" aria-label="郑伟老师AI分身介绍">
            <div class="zheng-profile-stage">
                <div class="zheng-profile-card">
                    <img class="zheng-profile-avatar" src="/static/images/zheng-wei-avatar.jpg" alt="郑伟老师头像">
                    <div class="zheng-profile-heading">
                        <h2>${escapeHtml(profile.name)}</h2>
                        <span class="zheng-ai-badge">${escapeHtml(profile.badge)}</span>
                    </div>
                    <div class="zheng-profile-tags">${tagsHtml}</div>
                    <p class="zheng-profile-meta">${escapeHtml(profile.meta)}</p>
                    <div class="zheng-profile-tabs" role="tablist" aria-label="郑伟老师资料分类">
                        ${tabsHtml}
                    </div>
                    <div class="zheng-profile-panel" id="zhengProfileContent" role="tabpanel">
                        ${renderZhengProfileSection(defaultSection)}
                    </div>
                </div>
            </div>
            <div class="zheng-profile-greeting">
                <h3>我是郑伟老师AI分身</h3>
                <p>有任何质量改进、精益、生产技术与制造运营提升方面的问题，直接问我吧</p>
            </div>
        </section>
    `;
}

function renderZhengProfileSection(section) {
    const imageHtml = section.image
        ? `<img class="zheng-wechat-image" src="${escapeHtml(section.image)}" alt="${escapeHtml(section.imageAlt || '郑伟老师个人微信二维码')}">`
        : '';
    return `<p class="zheng-profile-copy">${escapeHtml(section.content)}</p>${imageHtml}`;
}

function showZhengProfileTab(button, sectionKey) {
    const section = ZHENG_TEACHER_PROFILE.sections[sectionKey];
    const content = document.getElementById('zhengProfileContent');
    if (!button || !section || !content) return;

    document.querySelectorAll('.zheng-profile-tab').forEach(tab => {
        const active = tab === button;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    content.innerHTML = renderZhengProfileSection(section);
}

// 点击快捷问题：填入输入框（不自动发送），用户可编辑后发送
function fillQuick(el) {
    const text = el.getAttribute('data-question') || el.textContent;
    const input = document.getElementById('msgInput');
    if (input) {
        input.value = text;
        autoResize(input);
        input.focus();
    }
}

// ===== Chat List =====
async function loadChatList() {
    if (!currentUser) return;
    try {
        const resp = await fetch(`/api/v1/chats?username=${encodeURIComponent(currentUser)}`, { headers: apiHeaders() });
        const data = await resp.json();
        if (data.success) {
            allChats = data.chats;
            renderChatList();
            // 按当前模式恢复会话
            const modeChats = getModeChats();
            // 如果当前聊天仍然存在于全部聊天列表中，不要强制跳走
            // （避免智能体对话回复完成后，因过滤不同步导致跳转到空页面）
            const currentChatStillExists = currentChatId && allChats.some(c => c.chat_id === currentChatId);
            if (modeChats.length === 0 && !currentChatStillExists) {
                await createNewChat();
            } else if (!currentChatId || (!currentChatStillExists && !modeChats.some(c => c.chat_id === currentChatId))) {
                currentChatId = modeChats[0].chat_id;
                modeChatId[currentMode] = currentChatId;
                renderChatList();
                await loadChatHistory(currentChatId);
            }
        }
    } catch (e) { console.error('加载会话列表失败', e); }
}

function renderChatList() {
    const list = document.getElementById('chatList');
    list.innerHTML = '';
    // 只显示当前模式的会话
    const modeChats = getModeChats();
    // 控制底部提示文字的显示
    const footerHint = document.getElementById('sidebarFooterHint');
    if (footerHint) {
        if (currentAgentId && modeChats.length === 0) {
            footerHint.textContent = '暂无历史对话';
            footerHint.style.display = '';
        } else if (!currentAgentId) {
            footerHint.textContent = '选择智能体查看历史对话';
            footerHint.style.display = '';
        } else {
            footerHint.style.display = 'none';
        }
    }
    modeChats.forEach(chat => {
        const item = document.createElement('div');
        item.className = `chat-item${chat.chat_id === currentChatId ? ' active' : ''}`;
        item.onclick = (e) => {
            if (e.target.closest('.chat-action-btn')) return;
            switchChat(chat.chat_id);
            closeSidebarOnMobile();
        };
        const safeTitle = escapeHtml(chat.title || '新对话');
        const safeTitleJs = (chat.title || '新对话').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const timeStr = formatTime(chat.updated_at || chat.created_at);
        item.innerHTML = `
            <span class="chat-icon">💬</span>
            <span class="chat-title" title="${safeTitle}">${safeTitle}</span>
            <span class="chat-time">${timeStr}</span>
            <div class="chat-actions">
                <button class="chat-action-btn" onclick="openRename('${chat.chat_id}', '${safeTitleJs}')" title="重命名" aria-label="重命名对话">✏️</button>
                <button class="chat-action-btn delete" onclick="deleteChatItem('${chat.chat_id}')" title="删除" aria-label="删除对话">🗑️</button>
            </div>
        `;
        list.appendChild(item);
    });
}

async function createNewChat() {
    if (!currentUser) return;
    try {
        const chatTitle = currentAgentId ? (myAgents.find(a => a.id === currentAgentId)?.name || '新对话') : '新对话';
        const resp = await fetch(`/api/v1/chats?username=${encodeURIComponent(currentUser)}&title=${encodeURIComponent(chatTitle)}&mode=${currentMode}&agent_id=${currentAgentId || ''}`, { method: 'POST', headers: apiHeaders() });
        const data = await resp.json();
        if (data.success) {
            currentChatId = data.chat.chat_id;
            modeChatId[currentMode] = currentChatId;
            // Associate chat with current agent
            if (currentAgentId) {
                const agent = myAgents.find(a => a.id === currentAgentId);
                if (agent) {
                    if (!agent.chat_ids) agent.chat_ids = [];
                    if (!agent.chat_ids.includes(data.chat.chat_id)) agent.chat_ids.push(data.chat.chat_id);
                    agentActiveChatId[currentAgentId] = data.chat.chat_id;
                    saveAgentActiveChatIds();
                    saveAgents();
                }
            }
            await loadChatList();
            clearChatUI();
            closeSidebarOnMobile();
        }
    } catch (e) { console.error('创建会话失败', e); }
}

async function switchChat(chatId) {
    if (chatId === currentChatId) return;
    // [BUG FIX #2] 切换聊天时中断正在进行的流式响应
    // 防止旧SSE流在后台继续运行导致 isLoading 锁死、新聊天无法发送消息
    stopGeneration();
    currentChatId = chatId;
    modeChatId[currentMode] = chatId;

    // Determine which agent owns this chat (check both local chat_ids and server agent_id)
    let belongsToAgent = null;
    const chatData = allChats.find(c => c.chat_id === chatId);
    myAgents.forEach(agent => {
        if (chatBelongsToAgent(chatData || { chat_id: chatId }, agent.id)) {
            belongsToAgent = agent.id;
        }
    });
    if (belongsToAgent) {
        currentAgentId = belongsToAgent;
        agentActiveChatId[currentAgentId] = chatId;
        saveAgentActiveChatIds();
    }

    renderChatList();
    updateHeaderKbVisibility();
    await loadChatHistory(chatId);
}

async function loadChatHistory(chatId) {
    const container = document.getElementById('chatMessages');
    container.innerHTML = '';
    try {
        const resp = await fetch(`/api/v1/history/${chatId}`, { headers: apiHeaders() });
        const data = await resp.json();
        const messages = data.messages || [];
        if (messages.length > 0) {
            // [性能修复] 限制加载的消息数量，避免DOM过多导致页面卡顿
            const MAX_RENDER_MESSAGES = 50;
            let messagesToRender = messages;
            let hasOlderMessages = false;
            if (messages.length > MAX_RENDER_MESSAGES) {
                hasOlderMessages = true;
                messagesToRender = messages.slice(-MAX_RENDER_MESSAGES);
            }
            if (hasOlderMessages) {
                const hint = document.createElement('div');
                hint.className = 'message system';
                hint.innerHTML = '<div class="bubble" style="text-align:center;color:var(--text-secondary);font-size:13px;">已省略较早的 ' + (messages.length - MAX_RENDER_MESSAGES) + ' 条消息（完整记录已保存）</div>';
                container.appendChild(hint);
            }
            messagesToRender.forEach(m => addMessageToUI(m.role, m.content));
            scrollToBottom();
        }
        updateCenteredMode();
    } catch (e) { console.error('加载历史失败', e); }
}

async function deleteChatItem(chatId) {
    if (!confirm('确定删除这个对话？')) return;
    try {
        await fetch(`/api/v1/chats/${chatId}?username=${encodeURIComponent(currentUser)}`, { method: 'DELETE', headers: apiHeaders() });

        // Remove chat_id from all agents
        myAgents.forEach(agent => {
            if (agent.chat_ids) {
                agent.chat_ids = agent.chat_ids.filter(id => id !== chatId);
            }
            // Also clean agentActiveChatId
            if (agentActiveChatId[agent.id] === chatId) {
                agentActiveChatId[agent.id] = agent.chat_ids && agent.chat_ids.length > 0 ? agent.chat_ids[0] : null;
            }
        });
        saveAgentActiveChatIds();
        saveAgents();

        if (chatId === currentChatId) {
            currentChatId = null;
            modeChatId[currentMode] = null;
            clearChatUI();
        }
        await loadChatList();
        // 如果当前模式没有会话了，新建一个
        const modeChats = getModeChats();
        if (modeChats.length === 0) {
            await createNewChat();
        }
    } catch (e) { console.error('删除会话失败', e); }
}

function openRename(chatId, currentTitle) {
    renamingChatId = chatId;
    document.getElementById('renameInput').value = currentTitle;
    document.getElementById('renameOverlay').classList.add('show');
    setTimeout(() => document.getElementById('renameInput').focus(), 100);
}

function closeRename() {
    document.getElementById('renameOverlay').classList.remove('show');
    renamingChatId = null;
}

async function confirmRename() {
    const newTitle = document.getElementById('renameInput').value.trim();
    if (!newTitle || !renamingChatId) return;
    const username = currentUser || '';
    try {
        await fetch(`/api/v1/chats/${renamingChatId}/rename`, {
            method: 'PUT',
            headers: apiHeaders(),
            body: JSON.stringify({ username, chat_id: renamingChatId, new_title: newTitle })
        });
        document.getElementById('renameOverlay').classList.remove('show');
        await loadChatList();
    } catch (e) { showToast('重命名失败'); }
    renamingChatId = null;
}

function cancelRename() {
    document.getElementById('renameOverlay').classList.remove('show');
    renamingChatId = null;
}

function clearChatUI() {
    document.getElementById('chatMessages').innerHTML = '';
    updateCenteredMode();
}

async function clearCurrentChat() {
    if (!currentChatId) return;
    if (!confirm('确定清除当前对话的所有消息？')) return;
    try {
        await fetch(`/api/v1/history/${currentChatId}`, { method: 'DELETE', headers: apiHeaders() });
        clearChatUI();
    } catch (e) {}
}

// ===== Sidebar =====
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (window.innerWidth <= 768) {
        sidebar.classList.toggle('mobile-open');
        overlay.classList.toggle('active');
    } else {
        sidebar.classList.toggle('collapsed');
    }
}
function closeSidebarMobile() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarOverlay').classList.remove('active');
}
function closeSidebarOnMobile() {
    if (window.innerWidth <= 768) setTimeout(closeSidebarMobile, 200);
}

// ===== Scroll =====
function setupScrollDetection() {
    const el = document.getElementById('chatMessages');
    el.addEventListener('scroll', () => {
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        userScrolledUp = distFromBottom > 100;
        const btn = document.getElementById('scrollBottomBtn');
        btn.classList.toggle('show', userScrolledUp);
    });
}

function scrollToBottom() {
    const el = document.getElementById('chatMessages');
    setTimeout(() => {
        el.scrollTop = el.scrollHeight;
        userScrolledUp = false;
        document.getElementById('scrollBottomBtn').classList.remove('show');
    }, 50);
}

function smartScrollToBottom() {
    if (!userScrolledUp) scrollToBottom();
}

// ===== Stop Generation =====
function stopGeneration() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
    isLoading = false;
    document.getElementById('sendBtn').style.display = '';
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('sendBtn').disabled = false;
}

// ===== Thinking Status Texts =====
const THINKING_TEXTS = [
    '正在思考...',
    '分析问题中...',
    '整理思路...',
    '查找信息中...',
    '生成回答中...',
];
let thinkingTextIndex = 0;
let thinkingInterval = null;

// ===== Streaming Chat =====
function createStreamingBubble() {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.innerHTML = `
        <button class="msg-action-btn" title="复制" onclick="copyMessage(this)" aria-label="复制消息">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
        <button class="msg-action-btn" title="重新生成" onclick="regenerateMessage(this)" aria-label="重新生成">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
        </button>
    `;
    div.appendChild(bubble);
    div.appendChild(actions);
    container.appendChild(div);
    return bubble;
}

// 统一重置流式 UI 状态，防止按钮灰色/工具标签转圈等残留
function resetStreamingUI() {
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.style.display = '';
    }
    if (stopBtn) {
        stopBtn.style.display = 'none';
    }
    isLoading = false;
    currentAbortController = null;
    // [性能修复] 每次对话结束后清理过多的DOM节点，防止长时间运行后页面变慢
    cleanupExcessMessages();
}

function cleanupExcessMessages() {
    // 限制聊天区域DOM节点数量，超过100条消息时移除最早的
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const MAX_DOM_MESSAGES = 100;
    const messages = container.querySelectorAll('.message');
    if (messages.length > MAX_DOM_MESSAGES) {
        const toRemove = messages.length - MAX_DOM_MESSAGES;
        for (let i = 0; i < toRemove; i++) {
            messages[i].remove();
        }
        // 如果没有省略提示，加一个
        const existingHint = container.querySelector('.system .bubble');
        if (!existingHint || !existingHint.textContent.includes('省略')) {
            const hint = document.createElement('div');
            hint.className = 'message system';
            hint.innerHTML = '<div class="bubble" style="text-align:center;color:var(--text-secondary);font-size:13px;">已省略较早的消息（完整记录已保存）</div>';
            container.insertBefore(hint, container.firstChild);
        }
    }
}

    // [性能修复] 前端内存清理：页面长时间打开后定期清理
function cleanupFrontendMemory() {
    // 1. 清理过多的DOM消息节点
    cleanupExcessMessages();
    
    // 2. 清理已完成的 AbortController 引用
    if (currentAbortController && currentAbortController.signal.aborted) {
        currentAbortController = null;
    }
    
    // 3. 清理 thinkingInterval（如果残留）
    if (thinkingInterval && !isLoading) {
        clearInterval(thinkingInterval);
        thinkingInterval = null;
    }
    
    // 4. 清理 Blob URL（浏览器不会自动释放）
    try {
        document.querySelectorAll('a[href^="blob:"]').forEach(a => {
            // 只清理已下载过的（有download属性的）
            if (a.download) {
                try { URL.revokeObjectURL(a.href); } catch(e) {}
            }
        });
    } catch(e) {}
}

// [性能修复] 每5分钟自动执行一次前端内存清理，防止长时间打开页面变慢
setInterval(cleanupFrontendMemory, 5 * 60 * 1000);

async function streamChat(url, options, bubble) {
    let fullText = '';
    let cursorEl = null;
    let thinkingEl = null;

    currentAbortController = new AbortController();
    if (options && !options.signal) {
        options.signal = currentAbortController.signal;
    }

    // Show stop button
    document.getElementById('sendBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = '';

    function addThinking() {
        if (thinkingEl) return;
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'thinking-indicator';
        thinkingTextIndex = 0;
        thinkingEl.innerHTML = `<div class="spinner"></div><span class="think-status">${THINKING_TEXTS[0]}</span>`;
        bubble.appendChild(thinkingEl);
        smartScrollToBottom();
        // Rotate thinking text
        thinkingInterval = setInterval(() => {
            thinkingTextIndex = (thinkingTextIndex + 1) % THINKING_TEXTS.length;
            const statusEl = thinkingEl?.querySelector('.think-status');
            if (statusEl) statusEl.textContent = THINKING_TEXTS[thinkingTextIndex];
        }, 2000);
    }

    function removeThinking() {
        if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
        if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
    }

    function addToolTag(display, isDone) {
        removeThinking();
        // [BUG FIX] 当 isDone=true 时，找到已有的 running 标签并更新状态，
        // 而不是创建新标签。原代码总是创建新标签，导致工具完成时出现重复：
        // "搜索文档(spinner) ✓ 搜索文档" 而不是 "✓ 搜索文档"
        if (isDone) {
            // 查找已有的 running 状态的同名工具标签
            const runningTags = bubble.querySelectorAll('.tool-tag.running');
            for (const existingTag of runningTags) {
                // 提取标签中的工具名称文本（去除 spinner/icon 部分）
                const tagText = existingTag.textContent.trim();
                if (tagText === display || tagText.includes(display)) {
                    // 找到匹配的 running 标签，更新为 done 状态
                    existingTag.className = 'tool-tag done';
                    existingTag.innerHTML = `<span class="tool-icon">✓</span> ${escapeHtml(display)}`;
                    smartScrollToBottom();
                    return;  // 更新完成，不创建新标签
                }
            }
            // 如果没找到匹配的 running 标签（异常情况），仍创建新标签
            const tag = document.createElement('span');
            tag.className = 'tool-tag done';
            tag.innerHTML = `<span class="tool-icon">✓</span> ${escapeHtml(display)}`;
            bubble.appendChild(tag);
            bubble.appendChild(document.createTextNode(' '));
        } else {
            // isDone=false：创建新的 running 标签
            const tag = document.createElement('span');
            tag.className = 'tool-tag running';
            tag.innerHTML = `<span class="tool-spinner"></span> ${escapeHtml(display)}`;
            bubble.appendChild(tag);
            bubble.appendChild(document.createTextNode(' '));
        }
        smartScrollToBottom();
    }

    function addCursor() {
        // cursor 现在由 renderStreamMarkdown 负责追加，这里只触发首次渲染
        removeThinking();
        if (!streamRenderTimer) {
            renderStreamMarkdown();
        }
    }

    // [流式 Markdown 渲染] 节流：80ms 内最多渲染一次，避免高频 re-parse 卡顿
    // 长回复（几百字以上）时纯文本追加是 O(1)，marked.parse 是 O(n)，
    // 每个 token 都 re-parse 会掉帧；节流到 ~12fps 人眼无感但流畅
    let streamRenderTimer = null;
    const STREAM_RENDER_INTERVAL = 80;  // ms

    function renderStreamMarkdown() {
        if (streamRenderTimer) return;
        streamRenderTimer = setTimeout(() => {
            streamRenderTimer = null;
            doStreamRender();
        }, STREAM_RENDER_INTERVAL);
    }

    function doStreamRender() {
        // 保存 tool-tag（renderBubbleMarkdown 会覆盖 innerHTML）
        const toolTags = Array.from(bubble.querySelectorAll('.tool-tag'));
        if (fullText) {
            try {
                if (typeof marked !== 'undefined') {
                    bubble.innerHTML = marked.parse(fullText);
                    injectDownloadButtons(bubble);
                } else {
                    bubble.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
                }
            } catch (e) {
                bubble.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
            }
        }
        // 重新插入 tool-tag 到开头
        if (toolTags.length > 0) {
            const fragment = document.createDocumentFragment();
            toolTags.forEach(tag => fragment.appendChild(tag));
            fragment.appendChild(document.createTextNode(' '));
            bubble.insertBefore(fragment, bubble.firstChild);
        }
        // 追加流式光标
        if (cursorEl) {
            cursorEl.remove();
        }
        cursorEl = document.createElement('span');
        cursorEl.className = 'stream-cursor';
        cursorEl.textContent = '▊';
        bubble.appendChild(cursorEl);
        smartScrollToBottom();
    }

    function appendToken(text) {
        removeThinking();
        fullText += text;
        // 触发节流渲染（首次也会通过 addCursor 触发，这里做兜底）
        renderStreamMarkdown();
    }

    function finalize() {
        // 清除节流定时器，立即做最终渲染（不带 cursor）
        if (streamRenderTimer) {
            clearTimeout(streamRenderTimer);
            streamRenderTimer = null;
        }
        if (cursorEl) { cursorEl.remove(); cursorEl = null; }
    }

    try {
        const resp = await fetch(url, options);

        if (!resp.ok) {
            removeThinking();
            const errData = await resp.json().catch(() => ({}));
            if (resp.status === 401) {
                showToast('登录已过期，请重新登录');
                doLogout();
                return;
            }
            bubble.innerHTML = escapeHtml(errData.detail || `请求失败 (${resp.status})`);
            return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const jsonStr = line.slice(6).trim();
                if (!jsonStr) continue;

                try {
                    const data = JSON.parse(jsonStr);
                    switch (data.type) {
                        case 'thinking': addThinking(); break;
                        case 'tool': addToolTag(data.display || data.name, false); break;
                        case 'tool_done': addToolTag(data.display || data.name, true); break;
                        case 'token': addCursor(); appendToken(data.content); break;
                        case 'done': finalize(); break;
                        case 'error': removeThinking(); finalize(); { const errSpan = document.createElement('span'); errSpan.style.color = 'var(--error)'; errSpan.textContent = data.content; bubble.appendChild(document.createElement('br')); bubble.appendChild(errSpan); } break;
                    }
                } catch (e) { console.warn('SSE parse error:', e, jsonStr); }
            }
        }

        finalize();
        removeThinking();

        if (!fullText) {
            if (bubble.textContent.trim() === '') {
                bubble.innerHTML = '（未获取到回复）';
            }
        } else {
            // 保存已有的 tool 标签，renderBubbleMarkdown 会覆盖 innerHTML
            const toolTags = Array.from(bubble.querySelectorAll('.tool-tag'));
            renderBubbleMarkdown(bubble, fullText);
            // 将 tool 标签重新插入到 bubble 开头
            if (toolTags.length > 0) {
                const fragment = document.createDocumentFragment();
                toolTags.forEach(tag => fragment.appendChild(tag));
                fragment.appendChild(document.createTextNode(' '));
                bubble.insertBefore(fragment, bubble.firstChild);
            }
        }

    } catch (e) {
        removeThinking();
        finalize();
        if (e.name === 'AbortError') {
            if (fullText) {
                renderBubbleMarkdown(bubble, fullText);
                const stopSpan = document.createElement('span');
                stopSpan.style.cssText = 'color:var(--text-secondary);font-size:13px;';
                stopSpan.textContent = '（已停止生成）';
                bubble.appendChild(document.createElement('br'));
                bubble.appendChild(stopSpan);
            } else {
                bubble.innerHTML = '<span style="color:var(--text-secondary)">已停止生成</span>';
            }
        } else {
            bubble.innerHTML = `<span style="color:var(--error)">网络错误，请重试</span>`;
        }
    } finally {
        resetStreamingUI();
    }
}

// ===== Markdown Rendering =====
function renderBubbleMarkdown(bubble, text) {
    if (typeof marked !== 'undefined' && text) {
        try {
            // 先用 marked 渲染 Markdown
            bubble.innerHTML = marked.parse(text);
            // 渲染后再替换下载链接为可点击按钮（避免 marked 过滤 HTML 标签）
            injectDownloadButtons(bubble);
            return;
        } catch (e) { console.warn('Markdown渲染失败', e); }
    }
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
}

function injectDownloadButtons(container) {
    // [修复 v2] 更健壮的导出链接匹配：
    // 1. 容忍 URL 中的空格（流式渲染时 marked breaks:true 可能插入空格）
    // 2. 容忍 URL 被拆到多个文本节点（marked 可能把 URL 拆成 <em> 等子元素）
    // 3. 第三步兜底用 DOM 操作替代 innerHTML 字符串拼接（避免 onclick 引号转义问题）
    // 4. 处理 marked 自动把纯 URL 转成 <a href> 的情况（autolink 或 GFM）
    const EXPORT_URL_PATTERN = /\/api\/v1\/documents\/export[-\s]*download\/[^ \n\)<"\u0060]+\.(docx|xlsx|pdf|txt)/;
    const EXPORT_URL_GLOBAL = /(?:\/api\/v1\/documents\/export[-\s]*download\/[^ \n\)<"\u0060]+\.(docx|xlsx|pdf|txt))/g;
    const btnLabels = { docx: '点击下载Word文档', xlsx: '点击下载Excel表格', pdf: '点击下载PDF文档', txt: '点击下载文本文件' };

    // 工具函数：清理 URL（去除空格、修正格式）
    function cleanUrl(url) {
        return url
            .replace(/\s+/g, '')                    // 去除所有空格（流式渲染可能插入）
            .replace('/export/download/', '/export-download/')  // 修正斜杠格式
            .replace(/\/export-\s+download\//, '/export-download/');  // 修正 export- download 格式
    }

    // 1. 处理所有 <a> 标签中的导出链接
    //    覆盖：marked 渲染的 [文字](URL)、autolink 自动转的 <a href="URL">
    const existingLinks = container.querySelectorAll('a[href*="/api/v1/documents/export"], a[href*="api/v1/documents/export"]');
    existingLinks.forEach(a => {
        const href = a.getAttribute('href') || '';
        // 清理 href 后再匹配
        const cleanedHref = cleanUrl(href);
        if (!EXPORT_URL_PATTERN.test(cleanedHref)) return;
        const ext = cleanedHref.split('.').pop().toLowerCase();
        if (!['docx', 'xlsx', 'pdf', 'txt'].includes(ext)) return;
        const correctUrl = cleanUrl(cleanedHref.match(EXPORT_URL_PATTERN)[0]);
        a.className = 'doc-download-btn' + (ext === 'xlsx' ? ' xlsx-btn' : '');
        a.href = 'javascript:void(0)';
        a.removeAttribute('target');  // 防止新标签页打开
        a.textContent = btnLabels[ext] || '点击下载文档';
        // 用 addEventListener 而非 onclick 属性（避免 innerHTML 重写时丢失）
        a.onclick = function(e) { e.preventDefault(); e.stopPropagation(); downloadExportFile(correctUrl); };
    });

    // 2. 处理文本节点中的导出链接（LLM 直接输出 URL 文本，未被 marked 转成 <a>）
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    const nodesToReplace = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeValue && EXPORT_URL_PATTERN.test(node.nodeValue)) {
            nodesToReplace.push(node);
        }
    }
    nodesToReplace.forEach(node => {
        const text = node.nodeValue;
        const urlMatch = text.match(EXPORT_URL_PATTERN);
        if (urlMatch) {
            const url = urlMatch[0];
            // 修正URL格式：清理空格 + 修正斜杠
            const correctUrl = cleanUrl(url);
            const ext = correctUrl.split('.').pop().toLowerCase();
            const btn = document.createElement('a');
            btn.className = 'doc-download-btn' + (ext === 'xlsx' ? ' xlsx-btn' : '');
            btn.href = 'javascript:void(0)';
            btn.textContent = btnLabels[ext] || '点击下载文档';
            btn.onclick = function(e) { e.preventDefault(); e.stopPropagation(); downloadExportFile(correctUrl); };
            const parent = node.parentNode;
            const beforeText = text.substring(0, text.indexOf(url)).replace(/下载链接[：:]*\s*$/, '');
            if (beforeText.trim()) {
                parent.insertBefore(document.createTextNode(beforeText), node);
            }
            parent.insertBefore(btn, node);
            const afterText = text.substring(text.indexOf(url) + url.length);
            if (afterText.trim()) {
                parent.insertBefore(document.createTextNode(afterText), node);
            }
            parent.removeChild(node);
        }
    });

    // [修复 v2] 3. 兜底检查：用 DOM 操作替代 innerHTML 字符串拼接
    // 旧版用 innerHTML.replace 把 URL 替换成 <a onclick="downloadExportFile('URL')">
    // 当 URL 含中文/特殊字符时，onclick 字符串里的引号会破坏 HTML 解析
    // 新版：再次扫描文本节点（覆盖 marked 把 URL 包在 <code>/<strong> 等元素里的情况）
    // 用 DOM API 创建按钮，避免 innerHTML 字符串拼接
    const walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    const nodesToReplace2 = [];
    while (walker2.nextNode()) {
        const node = walker2.currentNode;
        // 跳过已经在按钮内的文本节点
        if (node.parentNode && node.parentNode.classList && node.parentNode.classList.contains('doc-download-btn')) continue;
        if (node.nodeValue && EXPORT_URL_PATTERN.test(node.nodeValue)) {
            nodesToReplace2.push(node);
        }
    }
    nodesToReplace2.forEach(node => {
        const text = node.nodeValue;
        const urlMatch = text.match(EXPORT_URL_PATTERN);
        if (urlMatch) {
            const url = urlMatch[0];
            const correctUrl = cleanUrl(url);
            const ext = correctUrl.split('.').pop().toLowerCase();
            const btn = document.createElement('a');
            btn.className = 'doc-download-btn' + (ext === 'xlsx' ? ' xlsx-btn' : '');
            btn.href = 'javascript:void(0)';
            btn.textContent = btnLabels[ext] || '点击下载文档';
            btn.onclick = function(e) { e.preventDefault(); e.stopPropagation(); downloadExportFile(correctUrl); };
            const parent = node.parentNode;
            const beforeText = text.substring(0, text.indexOf(url));
            if (beforeText.trim()) {
                parent.insertBefore(document.createTextNode(beforeText), node);
            }
            parent.insertBefore(btn, node);
            const afterText = text.substring(text.indexOf(url) + url.length);
            if (afterText.trim()) {
                parent.insertBefore(document.createTextNode(afterText), node);
            }
            parent.removeChild(node);
        }
    });
}

// ===== 导出文件下载（支持中文文件名） =====
async function downloadExportFile(url) {
    try {
        // [修复 v2] URL 完整性校验：防止流式渲染时点击到残缺 URL
        // 合法的导出 URL 必须以 /api/v1/documents/export-download/ 开头，且以文件扩展名结尾
        const validUrlPattern = /^\/api\/v1\/documents\/export-download\/[^]+\.(docx|xlsx|pdf|txt)$/i;
        if (!validUrlPattern.test(url)) {
            console.warn('下载URL不完整或格式错误:', url);
            showToast('文件链接尚未生成完毕，请稍候 1-2 秒后再试', 3000);
            return;
        }
        const headers = {};
        if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
        const response = await fetch(url, { headers });
        if (!response.ok) {
            showToast('下载失败：' + response.status + ' ' + response.statusText, 3000);
            return;
        }
        // 从Content-Disposition提取文件名
        const disposition = response.headers.get('Content-Disposition');
        // 根据URL中的扩展名决定默认文件名
        const urlExt = url.split('.').pop().toLowerCase();
        const defaultNames = { docx: '导出文档.docx', xlsx: '导出表格.xlsx', pdf: '导出文档.pdf', txt: '导出文本.txt' };
        let filename = defaultNames[urlExt] || '导出文档.docx';
        if (disposition) {
            const utf8Match = disposition.match(/filename\*=UTF-8''(.+)/i);
            if (utf8Match) {
                try { filename = decodeURIComponent(utf8Match[1]); } catch(e) { filename = utf8Match[1]; }
            } else {
                const plainMatch = disposition.match(/filename="?([^"]+)"?/);
                if (plainMatch) filename = plainMatch[1];
            }
        }
        // 从URL提取文件名（兜底：默认文件名未被服务端覆盖时才使用URL中的文件名）
        if (filename === defaultNames[urlExt] || filename === '导出文档.docx') {
            const urlParts = url.split('/');
            const lastPart = urlParts[urlParts.length - 1];
            if (lastPart) { try { filename = decodeURIComponent(lastPart); } catch(e) { filename = lastPart; } }
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
    } catch (e) {
        console.error('下载导出文件失败:', e);
        // 降级：直接在新标签页打开
        window.open(url, '_blank');
    }
}

// ===== Send Message =====
async function sendMessage() {
    if (isLoading) return;
    // [BUG FIX #1] 竞态条件修复：在 createNewChat() 之前就设置 isLoading
    // 防止快速双击/连按回车时，第二次调用在 await createNewChat() 期间
    // 仍通过 isLoading 检查（此时仍为 false），导致创建重复聊天会话
    isLoading = true;
    if (!currentChatId) {
        // 没有当前对话时自动创建新对话（点击智能体后直接发消息的场景）
        await createNewChat();
        if (!currentChatId) { isLoading = false; return; }  // 创建失败才退出，同时释放锁
    }
    const input = document.getElementById('msgInput');
    const message = input.value.trim();
    if (!message && !selectedFile) { isLoading = false; return; }
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;

    try {
    document.getElementById('chatContent').classList.remove('centered');

    if (selectedFile && message) {
        const isImage = selectedFile.type.startsWith('image/');
        const icon = isImage ? '🖼️' : '📎';
        if (isImage && selectedFileBase64) {
            addMessageToUI('user', `${icon} ${selectedFile.name}\n${message}`, selectedFileBase64);
        } else {
            addMessageToUI('user', `${icon} ${selectedFile.name}\n${message}`);
        }
        input.value = ''; autoResize(input);
        const bubble = createStreamingBubble();
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('message', message);
        formData.append('session_id', currentChatId);
        formData.append('web_search', webSearchEnabled);
        formData.append('mode', currentMode);
        formData.append('deep_think', deepThinkEnabled);
        formData.append('skill', selectedSkill || '');
        // 智能体ID和任务描述
        if (currentAgentId) {
            formData.append('agent_id', currentAgentId);
            const curAgent = myAgents.find(a => a.id === currentAgentId);
            if (curAgent) formData.append('agent_task', curAgent.task);
        } else {
            formData.append('agent_id', '');
        }
        // 聊天框上传文件仅用于临时分析，不存入知识库
        formData.append('store_to_kb', 'false');
        await streamChat('/api/v1/chat-with-file/stream', { method: 'POST', body: formData, headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {} }, bubble);
        removeFile();
        await loadChatList();
    } else if (selectedFile && !message) {
        // 文件无消息时，自动添加分析提示，走聊天流式分析（不存知识库）
        addMessageToUI('user', `[上传文档] ${selectedFile.name}`);
        const bubble = createStreamingBubble();
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('message', '请分析这个文件的内容');
        formData.append('session_id', currentChatId);
        formData.append('web_search', webSearchEnabled);
        formData.append('mode', currentMode);
formData.append('skill', selectedSkill || '');
        formData.append('deep_think', deepThinkEnabled);
        if (currentAgentId) {
            formData.append('agent_id', currentAgentId);
            const curAgent = myAgents.find(a => a.id === currentAgentId);
            if (curAgent) formData.append('agent_task', curAgent.task);
        }
        formData.append('store_to_kb', 'false');
        await streamChat('/api/v1/chat-with-file/stream', { method: 'POST', body: formData, headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {} }, bubble);
        removeFile();
        await loadChatList();
    } else {
        lastMessageText = message;
        addMessageToUI('user', message);
        input.value = ''; autoResize(input);
        const bubble = createStreamingBubble();
        await streamChat('/api/v1/chat/stream', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({ message, session_id: currentChatId, web_search: webSearchEnabled, mode: currentMode, deep_think: deepThinkEnabled, skill: selectedSkill || '', agent_id: currentAgentId || '', agent_task: (currentAgentId && myAgents.find(a => a.id === currentAgentId)) ? myAgents.find(a => a.id === currentAgentId).task : '' })
        }, bubble);
        await loadChatList();
    }
    scrollToBottom();
    } finally {
        resetStreamingUI();
    }
}

function sendQuick(text) {
    // 填入输入框但不自动发送，用户可编辑后发送
    const input = document.getElementById('msgInput');
    if (input) {
        input.value = text;
        autoResize(input);
        input.focus();
    }
}

function addMessageToUI(role, content, imageBase64) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (role === 'assistant') {
        renderBubbleMarkdown(bubble, content);
    } else {
        let htmlContent = escapeHtml(content).replace(/\n/g, '<br>');
        if (imageBase64) htmlContent += `<img class="chat-img" src="${imageBase64}" alt="上传的图片">`;
        bubble.innerHTML = htmlContent;
        bubble.style.whiteSpace = 'pre-wrap';
    }

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (role === 'assistant') {
        actions.innerHTML = `
            <button class="msg-action-btn" title="复制" onclick="copyMessage(this)" aria-label="复制消息">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            <button class="msg-action-btn" title="重新生成" onclick="regenerateMessage(this)" aria-label="重新生成">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
            </button>
        `;
    } else {
        actions.innerHTML = `
            <button class="msg-action-btn" title="复制" onclick="copyMessage(this)" aria-label="复制消息">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
        `;
    }

    div.appendChild(bubble);
    div.appendChild(actions);
    container.appendChild(div);

    document.getElementById('chatContent').classList.remove('centered');
    scrollToBottom();
}

// ===== Message Actions =====
function copyMessage(btn) {
    const messageDiv = btn.closest('.message');
    const bubble = messageDiv ? messageDiv.querySelector('.bubble') : null;
    if (!bubble) { showToast('复制失败：未找到消息内容'); return; }
    // 获取纯文本，排除代码块复制按钮的文字
    let text = bubble.innerText || bubble.textContent || '';
    // 去除代码块中的"复制"/"已复制"文字
    text = text.replace(/\n?复制\n?/g, '\n').replace(/\n?已复制\n?/g, '\n').trim();
    if (!text) { showToast('复制失败：内容为空'); return; }
    copyToClipboard(text, () => { showToast('已复制到剪贴板'); }, () => { showToast('复制失败，请手动复制'); });
}

async function regenerateMessage(btn) {
    if (isLoading) return;
    const messageDiv = btn.closest('.message');
    const prev = messageDiv.previousElementSibling;
    if (!prev || !prev.classList.contains('user')) { showToast('无法找到对应的用户消息'); return; }
    const userBubble = prev.querySelector('.bubble');
    const userText = userBubble.textContent || userBubble.innerText;
    messageDiv.remove();
    if (!currentChatId) return;
    isLoading = true;
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;

    try {
    const bubble = createStreamingBubble();
    await streamChat('/api/v1/chat/stream', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ message: userText, session_id: currentChatId, web_search: webSearchEnabled, mode: currentMode, deep_think: deepThinkEnabled,
        skill: selectedSkill || '', agent_id: currentAgentId || '', agent_task: (currentAgentId && myAgents.find(a => a.id === currentAgentId)) ? myAgents.find(a => a.id === currentAgentId).task : '' })
    }, bubble);
    } finally {
        resetStreamingUI();
    }
}

function showTyping(show) { document.getElementById('typingIndicator').style.display = show ? 'block' : 'none'; if (show) scrollToBottom(); }

// ===== File Handling =====
function onFileSelected(event) {
    const file = event.target.files[0];
    if (file) {
        if (file.size > MAX_FILE_SIZE) { showToast('文件大小不能超过 50MB'); event.target.value = ''; return; }
        setFilePreview(file);
    }
}

function setFilePreview(file) {
    selectedFile = file;
    selectedFileBase64 = null;
    const isImage = file.type.startsWith('image/');
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileIcon').textContent = isImage ? '🖼️' : '📎';
    document.getElementById('fileBar').style.display = 'flex';
    document.getElementById('msgInput').placeholder = '针对此文件输入问题，或修改要求...';
    if (isImage) {
        const reader = new FileReader();
        reader.onload = function(e) { selectedFileBase64 = e.target.result; };
        reader.readAsDataURL(file);
    }
}

function removeFile() {
    selectedFile = null;
    selectedFileBase64 = null;
    document.getElementById('fileInput').value = '';
    document.getElementById('fileBar').style.display = 'none';
    document.getElementById('fileIcon').textContent = '📎';
    document.getElementById('msgInput').placeholder = '输入问题，或粘贴/拖拽文件...';
}

// ===== Paste & Drag =====
document.addEventListener('DOMContentLoaded', function() {
    const msgInput = document.getElementById('msgInput');
    const inputContainer = document.querySelector('.input-container');

    msgInput.addEventListener('paste', function(e) {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) { if (file.size > MAX_FILE_SIZE) { showToast('图片大小不能超过 50MB'); return; } setFilePreview(file); showToast('已粘贴图片，输入问题后发送'); }
                return;
            }
            if (item.kind === 'file' && !item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) { setFilePreview(file); showToast('已粘贴文件，输入问题后发送'); }
                return;
            }
        }
    });

    inputContainer.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); inputContainer.style.borderColor = 'var(--accent)'; inputContainer.style.background = 'rgba(26,26,26,0.03)'; });
    inputContainer.addEventListener('dragleave', function(e) { e.preventDefault(); e.stopPropagation(); inputContainer.style.borderColor = ''; inputContainer.style.background = ''; });
    inputContainer.addEventListener('drop', function(e) { e.preventDefault(); e.stopPropagation(); inputContainer.style.borderColor = ''; inputContainer.style.background = ''; const files = e.dataTransfer.files; if (files.length > 0) { setFilePreview(files[0]); showToast('已添加文件，输入问题后发送'); } });
});

// ===== Knowledge Base Modal =====
async function showDocs() {
    updateKnowledgePermissionUi();
    document.getElementById('docsModal').classList.add('show');
    await loadDocList();
}
function closeDocs() { document.getElementById('docsModal').classList.remove('show'); document.getElementById('uploadProgress').style.display = 'none'; }

async function loadDocList() {
    const list = document.getElementById('docList');
    list.innerHTML = '<div class="doc-empty">加载中...</div>';
    try {
        // 按 agent_id 获取对应知识库的文档列表
        const agentParam = currentAgentId ? `?agent_id=${encodeURIComponent(currentAgentId)}` : '';
        const resp = await fetch(`/api/v1/documents${agentParam}`, { headers: apiHeaders() });
        const data = await resp.json();
        list.innerHTML = '';
        if (data.documents && data.documents.length > 0) {
            data.documents.forEach(doc => {
                const item = document.createElement('div');
                item.className = 'doc-item';
                let icon = '📄';
                if (doc.endsWith('.pdf')) icon = '📕';
                else if (doc.endsWith('.docx')) icon = '📘';
                else if (doc.endsWith('.xlsx') || doc.endsWith('.xls')) icon = '📊';
                else if (doc.endsWith('.txt')) icon = '📝';
                const safeName = escapeHtml(doc);
                const safeNameForAttr = doc.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                item.innerHTML = `<span class="doc-icon">${icon}</span><span class="doc-name">${safeName}</span><button class="doc-download-btn" onclick="downloadDocument('${safeNameForAttr}')" title="下载" aria-label="下载文档">📥</button>${canDeleteKnowledgeBase() ? `<button class="doc-delete-btn" onclick="deleteDocument('${safeNameForAttr}', this)">删除</button>` : ''}`;
                list.appendChild(item);
            });
        } else { list.innerHTML = '<div class="doc-empty">暂无文档，请上传</div>'; }
    } catch (e) { list.innerHTML = '<div class="doc-empty">加载失败</div>'; }
}

async function onKbFileSelected(event) {
    if (!canUploadKnowledgeBase()) { showToast('当前账号无权向该知识库上传文档'); event.target.value = ''; return; }
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) { await uploadToKnowledgeBase(files[i]); }
    document.getElementById('kbFileInput').value = '';
    await loadDocList();
}

async function deleteDocument(filename, btnEl) {
    if (!canDeleteKnowledgeBase()) { showToast('当前账号无权删除该知识库文档'); return; }
    if (!confirm(`确定要删除文档 "${filename}" 吗？此操作不可恢复！`)) return;
    const docItem = btnEl.closest('.doc-item');
    btnEl.disabled = true; btnEl.textContent = '删除中...';
    try {
        const agentParam = currentAgentId ? `?agent_id=${encodeURIComponent(currentAgentId)}` : '';
        const resp = await fetch(`/api/v1/documents/${encodeURIComponent(filename)}${agentParam}`, { method: 'DELETE', headers: apiHeaders() });
        const data = await resp.json();
        if (resp.ok && data.status === 'success') {
            docItem.style.transition = 'all 0.3s'; docItem.style.opacity = '0'; docItem.style.transform = 'translateX(20px)';
            setTimeout(() => { docItem.remove(); const list = document.getElementById('docList'); if (list.children.length === 0) list.innerHTML = '<div class="doc-empty">暂无文档，请上传</div>'; }, 300);
            // 同步刷新右侧KB面板
            if (currentAgentId) loadKbDocs();
        } else { alert('删除失败：' + (data.detail || '未知错误')); btnEl.disabled = false; btnEl.textContent = '删除'; }
    } catch (e) { alert('删除失败：网络错误'); btnEl.disabled = false; btnEl.textContent = '删除'; }
}

async function uploadToKnowledgeBase(file) {
    if (!canUploadKnowledgeBase()) { showToast('当前账号无权向该知识库上传文档'); return; }
    const progressEl = document.getElementById('uploadProgress');
    const fileNameEl = document.getElementById('progressFileName');
    const barFill = document.getElementById('progressBarFill');
    const statusEl = document.getElementById('progressStatus');
    progressEl.style.display = 'block';
    const isImage = file.type && file.type.startsWith('image/');
    const kbLabel = currentAgentId ? `智能体「${myAgents.find(a => a.id === currentAgentId)?.name || ''}」知识库` : '知识库';
    fileNameEl.textContent = `${isImage ? '🖼️' : '📎'} ${file.name} → ${kbLabel}${isImage ? '（VLM解析中）' : ''}`;
    barFill.style.width = '10%';
    statusEl.textContent = '上传中...';
    statusEl.className = 'progress-status';
    const formData = new FormData();
    formData.append('file', file);
    if (currentAgentId) formData.append('agent_id', currentAgentId);
    try {
        barFill.style.width = '30%';
        const resp = await fetch('/api/v1/upload', { method: 'POST', body: formData, headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {} });
        barFill.style.width = '80%';
        const data = await resp.json();
        if (resp.ok) { barFill.style.width = '100%'; statusEl.textContent = `✅ 上传成功！文档已索引到${kbLabel}`; statusEl.className = 'progress-status success'; }
        else { barFill.style.width = '100%'; barFill.style.background = 'var(--error)'; statusEl.textContent = '❌ 上传失败：' + (data.detail || '未知错误'); statusEl.className = 'progress-status error'; }
    } catch (e) { barFill.style.width = '100%'; barFill.style.background = 'var(--error)'; statusEl.textContent = '❌ 网络错误，请重试'; statusEl.className = 'progress-status error'; }
    setTimeout(() => { progressEl.style.display = 'none'; barFill.style.background = 'var(--accent)'; }, 3000);
}

function downloadDocument(filename) {
    // 在新标签页打开下载链接
    const agentParam = currentAgentId ? `?agent_id=${encodeURIComponent(currentAgentId)}` : '';
    const url = `/api/v1/documents/${encodeURIComponent(filename)}/download${agentParam}`;
    window.open(url, '_blank');
}

// ===== Utility Functions =====
function formatTime(timestamp) {
    if (!timestamp) return '';
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 604800) return Math.floor(diff / 86400) + '天前';
    const d = new Date(timestamp * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function handleKey(event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } }
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

// ===== Chat Search =====

// ===== Export Chat =====
function toggleExportDropdown() {
    const dropdown = document.getElementById('exportDropdown');
    dropdown.classList.toggle('show');
    // Close when clicking outside
    if (dropdown.classList.contains('show')) {
        setTimeout(() => {
            document.addEventListener('click', closeExportDropdown, { once: true });
        }, 0);
    }
}

function closeExportDropdown(e) {
    const dropdown = document.getElementById('exportDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        dropdown.classList.remove('show');
    }
}

// ===== Skills Dropdown =====
function toggleSkillsDropdown(event) {
    event.stopPropagation();
    const dropdown = document.getElementById('skillsDropdown');
    dropdown.classList.toggle('show');
    if (dropdown.classList.contains('show')) {
        setTimeout(() => {
            document.addEventListener('click', closeSkillsDropdown, { once: true });
        }, 0);
    }
}

function closeSkillsDropdown(e) {
    const dropdown = document.getElementById('skillsDropdown');
    const btn = document.getElementById('headerSkillsBtn');
    if (dropdown && !dropdown.contains(e.target) && btn && !btn.contains(e.target)) {
        dropdown.classList.remove('show');
    }
}

function selectSkill(skillId) {
    const dropdown = document.getElementById('skillsDropdown');
    if (dropdown) dropdown.classList.remove('show');
    selectedSkill = skillId;
    // 显示技能模式提示栏
    const bar = document.getElementById('skillModeBar');
    const text = document.getElementById('skillModeText');
    const hint = document.getElementById('skillModeHint');
    if (bar && text) {
        if (skillId === '8d-skill') {
            text.textContent = '8D SKILL模式';
            if (hint) hint.textContent = '当前启用了8D技能，AI将按8D流程生成报告';
        } else if (skillId === 'pfmea-dfmea-skill') {
            text.textContent = 'FMEA SKILL模式';
            if (hint) hint.textContent = '当前启用了FMEA技能，AI将按FMEA七步法生成报告';
        }
        bar.style.display = '';
    }
    // 同步隐藏知识库上传模式（互斥）
    if (agentKbUploadMode) toggleAgentKbUpload();
    const skillDisplay = skillId === 'pfmea-dfmea-skill' ? 'PFMEA/DFMEA' : '8D';
    showToast('已启用 ' + skillDisplay + ' SKILL 模式');
}

function clearSkill() {
    selectedSkill = null;
    const bar = document.getElementById('skillModeBar');
    if (bar) bar.style.display = 'none';
    showToast('已退出技能模式');
}

// 开发中 skill 点击：仅展示提示，不切换 selectedSkill
function showDevSkillToast(skillName) {
    const dropdown = document.getElementById('skillsDropdown');
    if (dropdown) dropdown.classList.remove('show');
    showToast('「' + skillName + '」 Skill需要公司资深专家参与，敬请期待', 3500);
}

async function exportChat(format) {
    if (!currentChatId) return;
    const dropdown = document.getElementById('exportDropdown');
    if (dropdown) dropdown.classList.remove('show');

    // 获取当前智能体名称，用于文件名
    let agentName = '';
    if (currentAgentId) {
        const agent = myAgents.find(a => a.id === currentAgentId);
        if (agent) agentName = agent.name;
    }

    try {
        const params = new URLSearchParams({ format });
        if (agentName) params.set('agent_name', agentName);
        const resp = await fetch(`/api/v1/export/${currentChatId}?${params.toString()}`, { headers: apiHeaders() });
        if (!resp.ok) { showToast('导出失败'); return; }

        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const extMap = { docx: 'docx', pdf: 'pdf', md: 'md' };
        const nameMap = { docx: 'Word', pdf: 'PDF', md: 'Markdown' };
        const ext = extMap[format] || 'md';
        // 文件名包含智能体名称
        const safeName = agentName ? agentName.replace(/[\\/:*?"<>|]/g, '_') : 'chat';
        a.download = `${safeName}_对话记录.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`已导出为 ${nameMap[format] || format.toUpperCase()}`);
    } catch (e) {
        showToast('导出失败');
    }
}

// ===== Knowledge Base Panel =====
function toggleKbPanel() {
    const panel = document.getElementById('kbPanel');
    if (!panel) return;
    const wasShown = panel.classList.contains('show');
    panel.classList.toggle('show');
    
    if (!wasShown) {
        // Update agent name display
        const agentNameEl = document.getElementById('kbAgentName');
        if (currentAgentId) {
            const agent = myAgents.find(a => a.id === currentAgentId);
            if (agentNameEl) agentNameEl.textContent = agent ? agent.name : '';
        } else {
            if (agentNameEl) agentNameEl.textContent = '（未选择智能体）';
        }
        const uploadBtn = document.querySelector('.kb-panel-upload');
        if (uploadBtn) uploadBtn.style.display = currentAgentId ? '' : 'none';
        loadKbDocs();
        setTimeout(() => { document.addEventListener('click', closeKbPanel, { once: true }); }, 0);
    }
}

function closeKbPanel(e) {
    const panel = document.getElementById('kbPanel');
    if (panel && !panel.contains(e.target) && !e.target.closest('.kb-btn')) {
        panel.classList.remove('show');
    }
}

async function loadKbDocs() {
    const listEl = document.getElementById('kbDocList');
    if (!currentAgentId) {
        listEl.innerHTML = '<div class="kb-empty">请先选择一个智能体</div>';
        return;
    }
    listEl.innerHTML = '<div class="kb-empty">加载中...</div>';
    try {
        const resp = await fetch(`/api/v1/documents?agent_id=${encodeURIComponent(currentAgentId)}`, { headers: apiHeaders() });
        const data = await resp.json();
        console.log('[KB] loadKbDocs response:', JSON.stringify(data));
        // Handle multiple response formats - docs can be strings or objects
        let docs = data.documents || data.files || [];
        if (!Array.isArray(docs)) docs = [];
        // Extract filenames from objects if needed
        docs = docs.map(d => typeof d === 'string' ? d : (d.filename || d.name || d.title || String(d)));
        
        if (docs.length === 0) {
            listEl.innerHTML = canUploadKnowledgeBase()
                ? '<div class="kb-empty">暂无文档，点击上方按钮上传</div>'
                : '<div class="kb-empty">暂无文档；当前账号对此知识库为只读</div>';
            return;
        }
        let html = '<div class="kb-doc-count">共 ' + docs.length + ' 个文档</div>';
        docs.forEach(docName => {
            const ext = docName.split('.').pop().toLowerCase();
            const icon = ext === 'pdf' ? '📕' : ext === 'docx' ? '📘' : '📄';
            html += '<div class="kb-doc-item">' +
                '<div class="kb-doc-info">' +
                '<span class="kb-doc-icon">' + icon + '</span>' +
                '<span class="kb-doc-name" title="' + escapeHtml(docName) + '">' + escapeHtml(docName) + '</span>' +
                '</div>' +
                (canDeleteKnowledgeBase() ? '<button class="kb-doc-delete" onclick="deleteKbDoc(\'' + docName.replace(/'/g, "\\'") + '\')" title="删除文档">🗑️</button>' : '') +
                '</div>';
        });
        listEl.innerHTML = html;
    } catch (e) {
        console.error('加载知识库文档列表失败', e);
        listEl.innerHTML = '<div class="kb-empty">加载失败，请重试</div>';
    }
}

async function uploadKbDoc(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    if (!currentAgentId) {
        showToast('请先选择一个智能体');
        input.value = '';
        return;
    }
    if (!canUploadKnowledgeBase()) {
        showToast('当前账号无权向该知识库上传文档');
        input.value = '';
        return;
    }
    showToast('正在上传并索引...');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('agent_id', currentAgentId);
    try {
        const resp = await fetch('/api/v1/upload', { method: 'POST', body: formData, headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {} });
        const data = await resp.json();
        if (data.status === 'success') {
            const chunks = data.detail?.chunks || 0;
            showToast(`文档已上传，共 ${chunks} 个分块`);
            loadKbDocs();
        } else {
            showToast(data.detail || '上传失败');
        }
    } catch (e) {
        showToast('上传失败，请重试');
    }
    input.value = '';
}

async function deleteKbDoc(filename) {
    if (!canDeleteKnowledgeBase()) { showToast('当前账号无权删除该知识库文档'); return; }
    if (!confirm(`确定删除文档「${filename}」？`)) return;
    try {
        const agentParam = currentAgentId ? `?agent_id=${encodeURIComponent(currentAgentId)}` : '';
        const resp = await fetch(`/api/v1/documents/${encodeURIComponent(filename)}${agentParam}`, { method: 'DELETE', headers: apiHeaders() });
        const data = await resp.json();
        if (data.status === 'success') {
            showToast('文档已删除');
            loadKbDocs();
        } else {
            showToast(data.detail?.message || data.message || '删除失败');
        }
    } catch (e) {
        showToast('删除失败，请重试');
    }
}

// ===== File Drag to Chat Area =====
(function() {
    const chatContent = document.getElementById('chatContent');
    if (!chatContent) return;
    chatContent.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); chatContent.classList.add('drag-over'); });
    chatContent.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); chatContent.classList.remove('drag-over'); });
    chatContent.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); chatContent.classList.remove('drag-over'); const files = e.dataTransfer.files; if (files.length > 0) handleDroppedFile(files[0]); });
})();

function handleDroppedFile(file) {
    const validExts = ['.pdf','.txt','.docx','.png','.jpg','.jpeg','.gif','.bmp','.webp','.csv','.xlsx','.xls','.doc','.ppt','.pptx','.md','.json','.py','.js','.html','.css'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!validExts.includes(ext)) { showToast('不支持的文件格式'); return; }
    if (file.size > 50 * 1024 * 1024) { showToast('文件大小超过50MB限制'); return; }
    selectedFile = file;
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileBar').style.display = 'flex';
    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => { selectedFileBase64 = e.target.result; };
        reader.readAsDataURL(file);
    } else { selectedFileBase64 = null; }
    showToast('文件已添加：' + file.name);
}

// ===== Mobile Keyboard =====
if (/Mobi|Android/i.test(navigator.userAgent)) {
    window.visualViewport && window.visualViewport.addEventListener('resize', () => {
        const chatContent = document.getElementById('chatContent');
        if (chatContent && document.activeElement && document.activeElement.tagName === 'TEXTAREA') {
            // Adjust layout for virtual keyboard
            const viewportHeight = window.visualViewport.height;
            chatContent.style.height = viewportHeight + 'px';
            setTimeout(() => scrollToBottom(), 100);
        } else {
            chatContent.style.height = '';
        }
    });
    window.visualViewport && window.visualViewport.addEventListener('scroll', () => {
        const chatContent = document.getElementById('chatContent');
        if (chatContent && document.activeElement && document.activeElement.tagName === 'TEXTAREA') {
            // Scroll input into view
            const inputArea = document.querySelector('.chat-input-area');
            if (inputArea) {
                inputArea.scrollIntoView({ block: 'end' });
            }
        }
    });
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', async function() {
    // Drag upload zone
    const uploadZone = document.getElementById('uploadZone');
    uploadZone.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', function(e) { e.preventDefault(); e.stopPropagation(); uploadZone.classList.remove('dragover'); });
    uploadZone.addEventListener('drop', function(e) {
        e.preventDefault(); e.stopPropagation(); uploadZone.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            (async () => { for (let i = 0; i < files.length; i++) { await uploadToKnowledgeBase(files[i]); } await loadDocList(); })();
        }
    });

    // Scroll detection
    setupScrollDetection();

    // Centered mode init
    updateCenteredMode();

    // [禁用自动登录] 每次访问必须手动输入用户名密码
    localStorage.removeItem('authToken');

    // [BUG FIX] Set initial history state for login page
    // This ensures the browser back button has a proper state to return to
    history.replaceState({page: 'login'}, '');

    // Landing page: nav scroll & smooth scroll (宣传页已删除，跳过)

    // Sync agents when tab becomes visible (cross-browser prompt sync)
    // [#12] 不传force=true，受5秒防抖限制，避免频繁Alt-Tab触发大量请求
    document.addEventListener('visibilitychange', async function() {
        if (!document.hidden && currentUser && authToken) {
            await syncAgentsFromServer();
        }
        // [性能修复] 页面隐藏时清理内存，防止长时间打开页面变慢
        if (document.hidden) {
            cleanupFrontendMemory();
        }
    });

    // Landing page: scroll-reveal animation with IntersectionObserver
    const revealElements = document.querySelectorAll('.reveal');
    if (revealElements.length > 0 && 'IntersectionObserver' in window) {
        // Add .reveal-init to enable animation (content visible by default without it)
        revealElements.forEach(function(el) { el.classList.add('reveal-init'); });
        const revealObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    revealObserver.unobserve(entry.target);
                }
            });
        }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
        revealElements.forEach(function(el) { revealObserver.observe(el); });
    }
});

// ===== Knowledge Base Full Page =====
function showKbPage() {
    if (!currentAgentId) {
        showToast('请先选择一个智能体');
        return;
    }
    const chatContent = document.getElementById('chatContent');
    const kbPage = document.getElementById('kbPage');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    chatContent.style.display = 'none';
    kbPage.style.display = 'flex';
    // 隐藏侧边栏
    if (sidebar) sidebar.style.display = 'none';
    if (sidebarOverlay) sidebarOverlay.style.display = 'none';
    // Update title
    const agent = myAgents.find(a => a.id === currentAgentId);
    const agentName = agent ? agent.name : '智能体';
    document.getElementById('kbPageTitle').textContent = agentName + ' - 知识库管理';
    document.getElementById('kbPageDesc').textContent = '上传和管理' + agentName + '相关文档，系统将自动进行向量化处理';
    updateKnowledgePermissionUi();
    // [BUG FIX] 推入历史状态，让浏览器←按钮能回到聊天页
    history.pushState({page: 'kb'}, '');
    // Load docs
    loadKbPageDocs();
    // Setup drag and drop
    setupKbPageDragDrop();
}

function hideKbPage() {
    const chatContent = document.getElementById('chatContent');
    const kbPage = document.getElementById('kbPage');
    const sidebar = document.getElementById('sidebar');
    kbPage.style.display = 'none';
    chatContent.style.display = 'flex';
    // 恢复侧边栏
    if (sidebar) sidebar.style.display = '';
    updateCenteredMode();
    // [BUG FIX] 使用 history.back() 弹出 kb 条目，而不是 replaceState 堆积 chat 条目
    // 旧代码 replaceState({page:'chat'}) 会把 kb 条目替换成 chat，导致 history 栈
    // 堆积大量 chat 条目，用户点后退时在 chat→chat 间跳转，UI 不变，看起来"没反应"
    // 改用 history.back() 让浏览器自动 pop kb 条目，回到前一个 chat 条目
    // popstate 监听器会接管 UI 切换（幂等，重复执行无副作用）
    if (history.state && history.state.page === 'kb') {
        // 设置标志位，告诉 popstate 监听器这是 hideKbPage 主动触发的后退
        // 不要误判为"chat→chat 堆积"而连续后退（那会错误地退到 login 页）
        window._navigatingFromKb = true;
        history.back();
    }
}

async function loadKbPageDocs() {
    const listEl = document.getElementById('kbPageDocList');
    if (!currentAgentId) {
        listEl.innerHTML = '<div class="kb-doc-empty">请先选择一个智能体</div>';
        return;
    }
    listEl.innerHTML = '<div class="kb-doc-empty">加载中...</div>';
    try {
        const resp = await fetch('/api/v1/documents?agent_id=' + encodeURIComponent(currentAgentId), { headers: apiHeaders() });
        const data = await resp.json();
        let docs = data.documents || data.files || [];
        if (!Array.isArray(docs)) docs = [];
        docs = docs.map(d => typeof d === 'string' ? d : (d.filename || d.name || d.title || String(d)));
        
        // Update stats
        document.getElementById('kbStatDocCount').textContent = docs.length;
        // Get chunk count from stats API
        let totalChunks = 0;
        try {
            const chunkResp = await fetch('/api/v1/documents/stats?agent_id=' + encodeURIComponent(currentAgentId), { headers: apiHeaders() });
            if (chunkResp.ok) {
                const chunkData = await chunkResp.json();
                totalChunks = chunkData.total_chunks || 0;
            }
        } catch(e) { console.warn('获取知识库统计失败', e); }
        document.getElementById('kbStatChunkCount').textContent = totalChunks;
        
        if (docs.length === 0) {
            listEl.innerHTML = canUploadKnowledgeBase()
                ? '<div class="kb-doc-empty">暂无文档，请点击上方区域上传</div>'
                : '<div class="kb-doc-empty">暂无文档；当前账号对此知识库为只读</div>';
            return;
        }
        let html = '';
        docs.forEach(docName => {
            const ext = docName.split('.').pop().toLowerCase();
            let iconHtml = '';
            if (ext === 'pdf') {
                iconHtml = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1051BF" stroke-width="1.5" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
            } else if (ext === 'docx' || ext === 'doc') {
                iconHtml = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
            } else if (ext === 'xlsx' || ext === 'xls') {
                iconHtml = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="1.5" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="12" width="8" height="6" rx="1"/></svg>';
            } else {
                iconHtml = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.5" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
            }
            const safeName = escapeHtml(docName);
            const safeNameForJs = docName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            html += '<div class="kb-doc-item">' +
                '<div class="kb-doc-icon">' + iconHtml + '</div>' +
                '<div class="kb-doc-info">' +
                '<div class="kb-doc-name" title="' + safeName + '">' + safeName + '</div>' +
                '<div class="kb-doc-meta">' + ext.toUpperCase() + '</div>' +
                '</div>' +
                (canDeleteKnowledgeBase() ? '<button class="kb-doc-delete-btn" onclick="deleteKbPageDoc(\'' + safeNameForJs + '\', this)" title="删除文档" aria-label="删除">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
                ' 删除</button>' : '') +
                '</div>';
        });
        listEl.innerHTML = html;
    } catch (e) {
        console.error('加载知识库文档失败', e);
        listEl.innerHTML = '<div class="kb-doc-empty">加载失败，请重试</div>';
    }
}

async function onKbPageFileSelected(event) {
    if (!canUploadKnowledgeBase()) { showToast('当前账号无权向该知识库上传文档'); event.target.value = ''; return; }
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
        await uploadToKbPage(files[i]);
    }
    event.target.value = '';
    await loadKbPageDocs();
}

async function uploadToKbPage(file) {
    if (!canUploadKnowledgeBase()) { showToast('当前账号无权向该知识库上传文档'); return; }
    const progressEl = document.getElementById('kbPageProgress');
    const fileNameEl = document.getElementById('kbProgressFileName');
    const barFill = document.getElementById('kbProgressBarFill');
    const statusEl = document.getElementById('kbProgressStatus');
    progressEl.style.display = 'block';
    const isImage = file.type && file.type.startsWith('image/');
    const agent = myAgents.find(a => a.id === currentAgentId);
    const kbLabel = agent ? agent.name + ' 知识库' : '知识库';
    fileNameEl.textContent = (isImage ? '🖼️ ' : '') + file.name + ' → ' + kbLabel + (isImage ? '（VLM解析中）' : '');
    barFill.style.width = '10%';
    statusEl.textContent = '上传中...';
    statusEl.className = 'kb-progress-status';
    const formData = new FormData();
    formData.append('file', file);
    if (currentAgentId) formData.append('agent_id', currentAgentId);
    try {
        barFill.style.width = '30%';
        const resp = await fetch('/api/v1/upload', { method: 'POST', body: formData, headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {} });
        barFill.style.width = '80%';
        const data = await resp.json();
        if (resp.ok && (data.status === 'success' || data.filename)) {
            barFill.style.width = '100%';
            const chunks = data.detail?.chunks || data.chunks || 0;
            statusEl.textContent = '上传成功！' + (chunks ? '共 ' + chunks + ' 个分块' : '');
            statusEl.className = 'kb-progress-status success';
        } else {
            barFill.style.width = '100%';
            barFill.style.background = '#1051BF';
            statusEl.textContent = '上传失败：' + (data.detail || '未知错误');
            statusEl.className = 'kb-progress-status error';
        }
    } catch (e) {
        barFill.style.width = '100%';
        barFill.style.background = '#1051BF';
        statusEl.textContent = '网络错误，请重试';
        statusEl.className = 'kb-progress-status error';
    }
    setTimeout(() => { progressEl.style.display = 'none'; barFill.style.background = ''; }, 3000);
}

async function deleteKbPageDoc(filename, btnEl) {
    if (!canDeleteKnowledgeBase()) { showToast('当前账号无权删除该知识库文档'); return; }
    if (!confirm('确定删除文档「' + filename + '」？此操作不可恢复！')) return;
    const docItem = btnEl.closest('.kb-doc-item');
    btnEl.disabled = true;
    btnEl.textContent = '删除中...';
    try {
        const agentParam = currentAgentId ? '?agent_id=' + encodeURIComponent(currentAgentId) : '';
        const resp = await fetch('/api/v1/documents/' + encodeURIComponent(filename) + agentParam, { method: 'DELETE', headers: apiHeaders() });
        const data = await resp.json();
        if (data.status === 'success') {
            docItem.style.transition = 'all 0.3s';
            docItem.style.opacity = '0';
            docItem.style.transform = 'translateX(20px)';
            setTimeout(() => {
                docItem.remove();
                const list = document.getElementById('kbPageDocList');
                if (list.children.length === 0) list.innerHTML = '<div class="kb-doc-empty">暂无文档，请点击上方区域上传</div>';
                // Update stats
                const countEl = document.getElementById('kbStatDocCount');
                const current = parseInt(countEl.textContent) || 0;
                countEl.textContent = Math.max(0, current - 1);
            }, 300);
        } else {
            showToast('删除失败：' + (data.detail?.message || data.message || '未知错误'));
            btnEl.disabled = false;
            btnEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> 删除';
        }
    } catch (e) {
        showToast('删除失败：网络错误');
        btnEl.disabled = false;
        btnEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> 删除';
    }
}

// [BUG FIX #3] 防重入守卫：标记拖拽事件是否已绑定，避免重复绑定
let _kbPageDragDropBound = false;

function setupKbPageDragDrop() {
    const zone = document.getElementById('kbPageUploadZone');
    if (!zone) return;
    // [BUG FIX #3] 如果已经绑定过事件监听器，直接返回，防止重复绑定
    // 每次打开知识库页面 showKbPage() 都会调用此函数，但事件监听器不会自动移除
    // 第N次打开后拖放文件会触发N次上传，导致同一文件被重复上传N次
    if (_kbPageDragDropBound) return;
    _kbPageDragDropBound = true;
    zone.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                uploadToKbPage(files[i]);
            }
            setTimeout(() => loadKbPageDocs(), 1500);
        }
    });
}

