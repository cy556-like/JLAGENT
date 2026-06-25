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
    'dfmea-risk-agent',            // 1. DFMEA与风险分析专家
    'part-design-agent',           // 2. 零部件智能设计助手
    'simulation-optimization-agent', // 3. 多学科仿真与优化代理
    'material-selection-agent',     // 4. 材料与轻量化选型顾问
    'manufacturing-process-agent',  // 5. 制造工艺仿真与工艺卡生成器
    'ee-design-agent',             // 6. 电子电气设计协同智能体
    'embedded-software-agent',     // 7. 嵌入式软件与功能安全助手
    'test-verification-agent',     // 8. 试验设计与智能验证伙伴
    'equipment-production-agent',  // 9. 装备与产线开发智能体
    'standards-innovation-agent',  // 10. 标准法规与技术创新检索
];

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

// 每个智能体的欢迎页配置（名称、描述、推荐问题）
const AGENT_WELCOME_CONFIG = {
    'dfmea-risk-agent': {
        name: 'DFMEA与风险分析专家',
        desc: '引导开展设计/过程失效模式分析，关联历史失效库，自动完成风险优先级评分，并推送预防措施',
        questions: [
            { label: '功能安全DFMEA结合', question: '针对燃料电池空压机的高速转子，其失效后果影响安全，请按ISO 26262与DFMEA结合的方法，推导安全目标并确定严重度等级。' },
            { label: '供应商DFMEA审核清单', question: '如何对外购的传感器进行供应商DFMEA审核？请提供一个审核检查单，涵盖功能、环境、可靠性等失效模式评审要点。' },
            { label: 'DFMEA验证报告框架', question: '在开发阶段后期，如何利用DFMEA的输出生成一份设计验证报告（DVR）的结构框架？请提供报告模板，包含风险项、验证状态和残余风险结论。' },
            { label: '工序PFMEA', question: '在发动机水泵的PFMEA中，如何分析叶轮压装工序的潜在失效？请帮助识别关键过程特性，并以RPN方式完成评分和优先措施推荐。' },
            { label: '频度评分建议', question: '塑料进气歧管的焊接工序PFMEA中，如何设定焊缝强度不足的频度评分？请结合历史返修数据，给出评分基准建议和过程控制措施。' },
            { label: '风险分析推送', question: '请用DFMEA方法对电动压缩机电机转子的退磁风险进行分析，关联历史高温退磁案例，给出磁钢选型与温度保护策略的预防措施。' },
            { label: '失效历史关联', question: '在设计48V BSG电机定子绕组时，如何系统识别绝缘失效模式？请关联我司历史上电机烧蚀案例库，给出预防措施和验证方法。' },
            { label: '风险预防推送', question: '在高强度螺栓连接的DFMEA中，"氢脆断裂"在历史库中有记录，如何评估当前设计中的残余风险，并自动推送除氢烘烤工艺参数？' },
            { label: 'AP法风险排序', question: '我们有一份转向机DFMEA初稿，风险项过多，请帮我依据严重度、频度和探测度，用行动优先级（AP）法重新排序，并给出需改进的前三项及建议措施。' },
            { label: '探测方法改进降险', question: '我正在评审一个齿轮箱的DFMEA，当前RPN值高于100的有5项，如何通过改进探测方法（如增加在线振动监控）来降低风险？请给出具体的评分变化推算。' },
            { label: '失效库模板设计', question: '我想建立一个企业内部的失效模式-原因-措施知识库模板，请提供一个结构化字段设计，并能自动关联类似零件的历史失效记录。' },
            { label: 'PFMEA探测评分', question: '对于电动助力转向控制器的PCB焊点，请引导完成过程FMEA，重点关注冷焊和虚焊，推荐检测方式并对比AOI与X-ray的探测度评分。' },
            { label: '冗余校验', question: '在汽车线控换挡执行器的DFMEA中，如何评估"位置信号跳变"的风险？请基于冗余传感器设计给出探测度打分说明，并推送交叉校验策略。' },
            { label: 'DFMEA引导', question: '我想对电子驻车制动卡钳做DFMEA，请引导我从功能分解、失效模式识别到风险评分，并针对"制动无法释放"给出完整的失效链和现行控制措施示例。' },
            { label: '设计准则', question: '对于ESC液压单元中的电磁阀，历史失效库显示"阀芯卡滞"比例高，如何在设计上预防，并自动生成防卡滞设计准则和试验验证建议？' },
            { label: '电池DFMEA', question: '如何对电池包密封结构进行DFMEA？请围绕密封垫、螺栓紧固和壳体刚度，识别潜在泄漏路径，并给出设计探测措施（如气密测试）的评分。' },
            { label: '预防建议', question: '在整车线束设计中，如何处理"端子退针"这类失效？请根据历史失效频次，给出发生的概率评级参考值，并推送防退针结构设计建议。' },
            { label: '历史失效关联推荐', question: '针对轮毂轴承单元，请根据历史售后失效数据（如微动磨损、密封失效）自动推荐应重点分析的失效模式，并说明如何将这些模式关联到DFMEA表中。' },
            { label: 'DFMEA驱动DVP关联', question: '我们正在制定DVP，请根据DFMEA中识别的高风险项，自动推导出必须包含的试验验证项目，并生成DVP与DFMEA的关联矩阵。' },
            { label: '售后数据映射频度', question: '我们想将售后索赔数据反向导入DFMEA用于频度更新，请给出一个映射规则设计，将故障率（ppm）转换为DFMEA频度等级。' }
        ]
    },
    'part-design-agent': {
        name: '零部件智能设计助手',
        desc: '辅助参数化建模、结构方案推荐、尺寸链计算与3D标注检查，加速零部件设计',
        questions: [
            { label: '位置度装配链分析', question: '制动器底板一组安装孔有位置度要求，与螺栓法兰孔存在间隙配合，请帮我建立考虑孔组位置度和浮动装配的尺寸链模型，并推导不干涉条件。' },
            { label: '跳动基准选择原则', question: '在旋转轴的3D标注中，圆柱度、径向圆跳动和全跳动容易混淆，请基于功能要求解释基准如何选择，并举例说明何时该用全跳动替代径向跳动。' },
            { label: '隔振连接方案对比', question: '高压油管支架需要隔振，请对比金属橡胶硫化粘接与机械卡扣式两种连接方案，给出各自的适用温度范围、疲劳可靠性及成本差异。' },
            { label: '基准体系审查清单', question: '请根据ISO 5459和我司常见规范，整理一份3D标注中基准体系的审查清单，涵盖基准目标设置、公共基准应用及基准顺序合理性，并以法兰轴为例说明。' },
            { label: '振动设计', question: '塑料进气歧管采用振动摩擦焊接，请给出焊接筋的推荐截面形状和尺寸（如三角筋高度、夹角），并说明与壁厚的关系及避免溢料的设计准则。' },
            { label: 'PMI标注模板', question: '请给我一个带花键、轴承位和油封配合面轴类零件的3D标注模板，说明位置度、轮廓度和跳动如何分配，并在花键处应用最大实体要求保证装配互换。' },
            { label: '减重布局', question: '铸铁差速器壳体想局部减重，请基于力流路径推荐几种挖孔或仿生筋布局，并用示意描述说明如何避开轴承孔和安装点附近的应力集中区。' },
            { label: '参数化模板', question: '请给我一个压缩弹簧的参数化建模流程，输入线径、中径、圈数、自由高度后能自动生成两端并紧磨平的实体，并说明螺旋线与端圈处理的要点。' },
            { label: '构型推荐', question: '设计铝合金转向节时，给定减震器叉耳和轴承安装法兰位置，请根据弯曲和制动扭矩工况，推荐2-3种过渡区加强筋构型，并定性比较刚度和铸造热节。' },
            { label: '衬套压装导向设计', question: '设计控制臂橡胶衬套压装时，为防止压入偏斜和刮伤，请推荐几种压装导向结构（如长倒角、阶梯定位），并给出基于过盈量的压装力估算公式。' },
            { label: '过盈有效修正计算', question: '对于电机轴与转子过盈配合，请给出考虑轴颈圆度、表面粗糙度压平量后的有效过盈量修正公式，并基于给定过盈量计算可传递扭矩的安全系数。' },
            { label: '规则驱动几何重建', question: '设计系列化冷却水道时，想通过几个关键参数（如水道直径、间距、拔模角）自动重构几何，请提供利用规则驱动重建的逻辑框架和检查方法。' },
            { label: '模型参数化重构', question: '我拿到一份STEP格式的悬置支架，需把它重构成可参数化的主模型，请给出详细的逆向重构步骤，包括基准选定、特征分解和表达式建立。' },
            { label: '侧隙概率法计算', question: '某行星齿轮机构中太阳轮齿厚、行星轮齿厚和内齿圈齿厚都有公差，请用统计法（RSS）推导总侧隙的公差带，并说明为什么在大批量生产时概率法比极限法更经济。' },
            { label: '表驱动建模脚本', question: '我想用Excel表驱动生成一组不同直径和厚度的制动盘变型，请给我一段可在CATIA或NX中使用的VBA/Python脚本示例，实现从Excel读取参数并更新模型。' },
            { label: '轴向间隙极限法', question: '已知端盖止口深度10±0.05，轴承宽度12(0/-0.1)，轴肩长度14±0.05，请用极限法帮我计算轴向装配间隙的封闭环尺寸及公差，并判定是否存在干涉风险。' },
            { label: 'PMI审查流程', question: '针对一个铸造铝合金箱体的PMI标注，如何系统检查壁厚、起模斜度、铸造圆角和加工余量是否已完整定义？请给出顺序审查流程和核对要点。' },
            { label: '草图约束管理', question: '在建立转向节全参数化模型时经常出现草图过约束和参考丢失，请系统列出避免过约束的建模顺序及约束优先级原则。' },
            { label: '工艺约束检查', question: '在参数化油底壳模型中，拔模角和最小壁厚需要满足铸造要求，我该如何在模型里嵌入规则，使得参数修改后自动检查是否违反工艺约束？' },
            { label: '壳体密封设计', question: '电池包下壳体需满足IP67密封和底部冲击，请推荐密封面截面方案（如双台阶胶槽、挡胶墙），并基于螺栓间距给出硅胶压缩率与永久变形控制建议。' }
        ]
    },
    'simulation-optimization-agent': {
        name: '多学科仿真与优化代理',
        desc: '自动驱动结构强度、刚度、NVH、热管理、流体等分析，并进行多目标优化，减少手动仿真迭代',
        questions: [
            { label: '液冷板多目标优化', question: '在电池包液冷板设计中，要同时最小化流道压降和表面温度标准差，请给出用CFD参数化模型进行DOE试验设计及响应面优化的完整设置，并推荐因子水平。' },
            { label: '多工况综合目标优化', question: '需要对多个工况（制动、转向、垂直冲击）下的转向节进行综合优化，请给出构建综合目标函数（加权和或妥协规划法）的方法，以及如何避免某一工况性能恶化。' },
            { label: '辐射噪声贡献量分析', question: '为降低变速器啸叫，要优化齿轮箱壳体辐射噪声，请说明如何设置声学有限元模型并进行面板贡献量分析，并给出ATV法计算的关键步骤。' },
            { label: '伴随法气动结构优化', question: '针对涡轮增压器压气机叶轮的离心应力与气动效率，请用伴随求解器驱动的优化思路设计自动流程，重点解释参数化网格变形与梯度优化器配合的方法。' },
            { label: '混合优化策略', question: '我在进行塑料进气歧管爆破压力分析，同时考虑材料非线性与加强筋形状优化，请推荐一种将拓扑优化与尺寸优化结合的混合策略，并说明如何定义响应约束。' },
            { label: '模态分析命令流', question: '对一个铝合金轮毂，我想自动进行自由模态和约束模态分析并提取前六阶频率，请写一段ANSYS APDL命令流模板，包含材料定义、约束施加和结果输出。' },
            { label: '接触非线性优化', question: '在结构优化中需考虑螺栓预紧力引起的接触非线性，请说明如何在参数化优化中处理接触状态突变，以及用哪种稳健优化方法能避免设计点震荡。' },
            { label: '多约束拓扑优化', question: '进行拓扑优化时，需同时约束体积分数、最大位移和第一阶固有频率，请给出在OptiStruct中设置多约束拓扑优化的卡片要点，并解释如何避免模态交换。' },
            { label: '多软件集成流程', question: '如何用Isight将CATIA参数化模型、ANSA网格划分、Fluent流体计算和Abaqus结构计算串联成自动化流程？请描述组件接口设置和参数映射逻辑。' },
            { label: '瞬态热控制耦合仿真', question: '如何对电机控制器散热器进行瞬态热仿真，并用PID控制逻辑自动调整风扇转速以保持结温？请给出系统耦合仿真（1D-3D联合）的设置思路。' },
            { label: '参数化静力分析脚本', question: '我想用脚本实现将悬置支架的几何参数（如厚度、肋板宽度）作为变量，自动生成Abaqus输入文件并提交静强度分析，请给我一个Python脚本框架，并说明关键步骤。' },
            { label: '热固耦合多目标优化', question: '在设计制动盘时，需要同时考虑热翘曲和重量，请给出一种联合Abaqus热固耦合分析与modeFRONTIER多目标优化的集成流程，重点说明数据文件传递和收敛判据。' },
            { label: '复特征值分析脚本', question: '为保证制动尖叫不发生，请解释复特征值分析中负阻尼因子的提取方法，并提供一个驱动Abaqus复特征值分析及结果判别的Python脚本逻辑。' },
            { label: '热模态多目标问题', question: '针对排气歧管的热应力与模态频率冲突，需要做多目标优化，请用数学形式定义设计变量、目标（最小热应力、特定频率避开）和约束，并给出一个适合的优化算法建议。' },
            { label: '代理模型加速优化', question: '如何利用代理模型（如Kriging）加速保险杠横梁的碰撞吸能与弯曲刚度多目标优化？请解释样本点选取、近似模型构建及NSGA-II优化的完整逻辑。' },
            { label: '随机载荷疲劳脚本', question: '电机轴承受随机转矩载荷，需预估高周疲劳寿命，请提供基于S-N曲线和雨流计数的疲劳分析脚本思路，可结合Ncode或FEMFAT的Python API。' },
            { label: '参数筛选DOE分析', question: '我想用实验设计（DOE）筛选出影响半轴扭转刚度的关键尺寸参数，请给出一个Plackett-Burman设计表和对应的回归分析Python代码示例。' },
            { label: '复合材料铺层优化', question: '对于一款复合材料板簧，想通过自由尺寸优化来最大化疲劳寿命和最小化重量，请给出设计变量（铺层角度、厚度）与优化设置的详细方案。' },
            { label: '操稳NVH联合优化', question: '控制臂衬套刚度对整车操稳和NVH敏感，需要基于K&C特性做硬点多学科优化，请说明如何在ADAMS/Car与Nastran间实现联合仿真及敏度分析。' },
            { label: '结果自动提取模板', question: '分析后处理时，需从大量ODB结果文件中自动提取最大Mises应力、节点位移并汇总成Excel，请提供使用Python对Abaqus odb进行后处理的代码模板。' }
        ]
    },
    'material-selection-agent': {
        name: '材料与轻量化选型顾问',
        desc: '基于性能、成本与工艺约束，从材料库中推荐金属、复合材料或轻量化方案，并预估减重效果',
        questions: [
            { label: '悬架弹簧轻量方案', question: '悬架螺旋弹簧需高应力低重量，请评估粉末冶金空心弹簧与超高强度钢的可行性，并预估减重与抗松弛性能变化。' },
            { label: '制动盘材料轻量化', question: '制动盘需减重并提升散热，请推荐碳陶瓷复合材料与低合金铸铁的替代性，预估减重幅度、热容量和成本倍数。' },
            { label: '车身骨架材料更替', question: '车身骨架用Q345钢，请比较升级为Q550高强钢、6082铝合金或碳纤维增强管的减重潜力、焊接/连接工艺限制及成本增幅。' },
            { label: '隔热罩轻量化选材', question: '排气歧管隔热罩需耐高温且减重，请推荐不锈钢-铝复合板或陶瓷纤维毯方案，预估隔热效率、重量和成本。' },
            { label: '连接杆材料比选', question: '底盘控制臂连接杆需高刚度、耐腐蚀，请推荐铝合金、球墨铸铁或连续纤维增强热塑复合材料的性价比，并预估减重。' },
            { label: '轮辋极致轻量化', question: '铝合金轮辋想进一步轻量化，请分析锻造镁合金或碳纤维轮辋的可行性，重点预估减重、耐久和成本提升倍数。' },
            { label: '材料轻量化对比', question: '缸体用灰铸铁，为减重考虑蠕墨铸铁或铝合金，请比较导热性、耐高温性能、NVH特性及制造成本，预估减重比例。' },
            { label: '涡壳耐热轻量化', question: '涡轮增压器涡壳需耐高温蠕变并减重，请对比耐热铸钢、镍基合金和陶瓷基复合材料，预估重量、热疲劳寿命和加工可行性。' },
            { label: '油底壳轻量方案', question: '油底壳需降噪减重，原为钢板冲压，请对比压铸铝合金和玻纤增强PA6方案，预估重量、NVH及密封可靠性。' },
            { label: '横梁多材料方案对比', question: '仪表板横梁需高刚度和低重量，请从镁合金压铸、铝合金挤压和碳纤维缠绕方案中推荐，并预估减重率和成本排序。' },
            { label: '车门内板轻量化选型', question: '车门内板现用低碳钢冲压，要求降重且满足刚度，请对比高强钢薄板、铝板和PP长玻纤注塑方案，给出推荐厚度和减重预估。' },
            { label: '转向节材料替代评估', question: '转向节原为球墨铸铁，受冲击载荷，能否用锻造铝合金或铝基复合材料替代？请对比强度、断裂韧性并预估减重效果。' },
            { label: '稳定杆轻量化选材', question: '设计横向稳定杆时，原用弹簧钢需减重30%，请推荐高强钢或玻纤/碳纤维复合材料替代方案，并对比疲劳性能和工艺成本。' },
            { label: '板簧复合材料减重', question: '商用车板簧需降重并保证疲劳寿命，请推荐玻纤增强环氧树脂复合材料与少片簧方案，预估减重效果及工艺限制。' },
            { label: '副车架轻量化选型', question: '副车架需碰撞吸能和疲劳耐久，请对比高强度钢、挤压铝合金和钢铝混合方案的重量、成本和性能，并给出减重百分比。' },
            { label: '悬置支架以塑代钢', question: '发动机悬置支架受振动和热，原用ADC12铸铝，是否可改用PA66+GF50？请预估减重，并分析模量和蠕变对NVH的影响。' },
            { label: '座椅骨架轻量对比', question: '汽车座椅骨架要求减重，请对比激光拼焊高强钢、镁合金压铸和碳纤维编织骨架的强度、成本与减重潜力。' },
            { label: '混合材料车门减重', question: '在有限成本下，如何通过钢塑混合实现车门模块减重？请给出钢材与纤维增强塑料的搭配方案，预估减重比例和关键工艺。' },
            { label: '防撞梁轻量化对比', question: '前防撞梁需满足低速碰撞吸能，请从钢改铝或碳纤维增强方案中推荐，并预估碰撞吸能、重量和制造成本差异。' },
            { label: '端板绝缘轻量方案', question: '电池模组端板要求绝缘、阻燃和轻量化，请推荐PPS+玻纤或环氧玻璃钢方案，比较重量、强度及成型工艺。' }
        ]
    },
    'manufacturing-process-agent': {
        name: '制造工艺仿真与工艺卡生成器',
        desc: '针对关键工艺，进行成形仿真、缺陷预测，并输出标准化工艺卡片',
        questions: [
            { label: '热处理工艺卡模板', question: '针对热处理工艺仿真，请设计一份标准化工艺卡，涵盖升温速率、保温温度、保温时间、淬火介质及转移时间等参数。' },
            { label: '注塑参数容差设定', question: '注塑工艺卡中需包含熔体温度、模温、注射压力和冷却时间，请结合仿真结果给出这些参数的推荐范围和波动容差。' },
            { label: '压铸工艺窗口计算', question: '针对离合器壳体的压铸，请提供PQ²图计算浇口速度和填充时间的公式，并给出工艺窗口的确认方法。' },
            { label: '冲压回弹补偿策略', question: '钢板冲压件回弹如何预测和补偿？请提供一个回弹分析的仿真步骤和几何补偿的迭代策略。' },
            { label: '缺陷控制', question: '连杆粉末锻造如何通过仿真控制密度分布和裂纹？请提供CIP到烧结再到锻造的全流程建模思路。' },
            { label: '缺陷预测准则', question: '针对铝合金转向节的低压铸造，请提供一个铸造仿真流程，并给出缩松缩孔缺陷的判定准则和工艺改进建议。' },
            { label: '温度优化', question: '针对涡轮增压器壳体的熔模铸造，请给出型壳预热温度和浇注温度的仿真参数设置，以及缩松预测的Niyama准则应用。' },
            { label: '补缩优化方案', question: '针对铝合金缸盖的砂型铸造，如何通过仿真优化冒口位置和尺寸？请提供冒口补缩距离的计算公式和设置原则。' },
            { label: '工艺卡模板', question: '如何根据成形仿真结果自动生成标准化的锻造工艺卡片？请提供一个包含加热温度、锻打次数、润滑、切边等信息的卡片模板。' },
            { label: '渗碳淬火变形预测', question: '汽车后桥齿轮渗碳淬火变形如何预测？请提供一个考虑相变塑性的热处理仿真流程和变形补偿建议。' },
            { label: '挤压截面变形预测', question: '如何通过挤压工艺仿真预测铝合金型材的截面变形和焊缝质量？请给出HyperXtrude的参数设置要点和缺陷判据。' },
            { label: '点焊参数仿真优化', question: '铝车身点焊容易出现飞溅和虚焊，请提供SORPAS仿真中电流、压力、时间的参数组合推荐，并说明如何预判熔核直径。' },
            { label: '注塑熔接痕优化', question: '塑料进气歧管注塑容易产生熔接痕，请给出在Moldflow中模拟熔接痕位置并优化浇口方案的脚本思路和评估准则。' },
            { label: '冲压成形参数设置', question: '我想通过冲压仿真分析翼子板的起皱和破裂风险，请给出AutoForm或Dynaform中关键工艺参数（压边力、摩擦系数、拉延筋）的设置范围和建议。' },
            { label: '热冲压相变预测', question: '高强钢板热冲压需控制马氏体相变，请说明如何通过仿真预测冷却速率和组织分布，并输出热冲压工艺窗口。' },
            { label: '复材RTM缺陷预测', question: '碳纤维复合材料高压RTM工艺中，如何通过仿真控制干斑和孔隙率？请推荐注射压力和模温的匹配原则。' },
            { label: '折叠缺陷预防', question: '齿轮热锻成形如何避免折叠和充不满？请给出模具圆角、飞边槽设计和坯料体积的推荐原则。' },
            { label: '冲压工艺卡生成', question: '请根据冲压仿真结果输出标准化工艺卡，包含材料牌号、料厚、压边力、润滑方式、工序排布和关键尺寸公差。' },
            { label: '压铸工艺卡模板', question: '在压铸工艺卡中应如何呈现浇注温度、快压射速度、增压压力和保压时间？请设计一个包含这些参数的标准模板。' },
            { label: '焊接工艺卡格式', question: '如何将焊接仿真结果（如热影响区宽度、熔深）转化为焊接工艺卡内容？请提供电阻点焊或激光焊工艺卡的标准化格式。' }
        ]
    },
    'ee-design-agent': {
        name: '电子电气设计协同智能体',
        desc: '协助汽车电子零部件（传感器、控制器等）的电路设计检查、信号完整性分析、原理图与PCB布局评审',
        questions: [
            { label: '高压隔离设计检查', question: '电机控制器原理图涉及高压与低压区域，如何确保隔离、爬电距离和绝缘配合满足功能安全要求？请列出检查项。' },
            { label: '混合信号PCB抗干扰', question: '开关电源与模拟小信号电路在同一PCB时，如何通过布局分割和接地策略防止开关噪声耦合到传感器前端？' },
            { label: 'TPMS天线匹配检查', question: '胎压监测系统（TPMS）的小型化PCB中，天线匹配网络与电池布局的关键检查点有哪些？' },
            { label: '功率PCB热设计评审', question: '点火控制器PCB包含大功率MOSFET，请提供功率器件布局和铜箔散热面积评估的热设计评审准则。' },
            { label: 'PDN设计检查', question: '汽车电子中，如何检查电源分配网络（PDN）的设计，确保瞬态电流下芯片电源引脚的电压跌落不超标？请提供目标阻抗法。' },
            { label: 'SPI信号过冲分析', question: '如何利用IBIS模型预估高速SPI总线上的过冲、下冲，并判断是否需加串联匹配？请给出分析步骤。' },
            { label: '射频微带线检查', question: '汽车雷达PCB中，如何检查射频微带线的阻抗连续性、拐角处理和参考层完整性，避免反射？' },
            { label: '地平面分割审查', question: '一个混合信号控制板采用地平面分割，如何审查分割方案是否导致回流路径断裂或EMI恶化？' },
            { label: '电平匹配检查表', question: '如何审查数字I/O的电平兼容性，防止3.3V MCU直接驱动5V外设造成漏电或损坏？请给出一份检查表。' },
            { label: 'DDR信号完整性评审', question: '从信号完整性角度评审DDR存储器与处理器的布局布线，应如何设置地址/命令/时钟组的等长约束和端接策略？' },
            { label: '传感器电路设计检查', question: '设计汽车轮速传感器信号调理电路时，如何系统检查输入滤波、钳位保护和ADC接口匹配，避免信号畸变？' },
            { label: '车载以太网EMI设计', question: '车载以太网设计时，如何检查差分对的共模噪声抑制措施？请给出共模扼流圈选型和对称布局建议。' },
            { label: '去耦电容选择原则', question: '控制器包含MCU、SBC和多个传感器，原理图中电源去耦电容的容值、数量和布局应如何选择？请给出计算原则。' },
            { label: '光电放大噪声抑制', question: '设计雨量光照传感器时，如何通过屏蔽、电源滤波和PCB走线降低光电二极管放大电路的本底噪声？' },
            { label: '霍尔传感器抗干扰', question: '制动踏板位置传感器使用霍尔元件，如何通过PCB布线和铺铜减少外部磁场干扰，提高测量稳定性？' },
            { label: '差分阻抗计算匹配', question: '处理高速LVDS视频信号，如何计算差分对线宽和间距以实现100Ω差模阻抗，并保持全程阻抗连续？' },
            { label: 'PCB评审报告模板', question: '请生成一份标准的PCB设计评审报告模板，覆盖布局、布线、EMC、热和可制造性等全部要点。' },
            { label: '晶振电路布局检查', question: '控制器PCB中，晶振电路布局不当易导致频偏或停振，请列出晶振电路布局布线的具体检查规则。' },
            { label: 'CAN总线电路审查', question: '车身控制器CAN总线原理图中，终端电阻、共模扼流圈和ESD保护器件的配置是否正确？请给出逐一审查要点。' },
            { label: 'LED驱动布局评审', question: '大功率LED驱动PCB布局中，怎样评估散热铜皮面积、电流均衡和热应力？请给出评审要点。' }
        ]
    },
    'embedded-software-agent': {
        name: '嵌入式软件与功能安全助手',
        desc: '自动生成基础代码、进行MISRA-C检查，辅助完成功能安全（ISO 26262）相关的安全分析与文档',
        questions: [
            { label: '安全需求文档模板', question: '针对"扭矩监控功能"的安全软件需求，请生成符合ISO 26262-6的软件安全需求规范模板，包含安全机制和故障响应。' },
            { label: 'SW-FMEA分析模板', question: '如何建立软件架构级别的安全分析（SW-FMEA），请以燃油喷射控制为例，列出功能块、失效模式、影响及检测措施模板。' },
            { label: 'MISRA位操作规则', question: '我在使用位操作时，经常违反MISRA-C规则12，请用示例解释规则12.1至12.4的含义，并给出合规的位域与掩码写法。' },
            { label: 'MISRA-C违规分析', question: '请对下面这段C代码进行MISRA-C:2012合规性检查，指出所有违规规则号、违规位置及修正建议。' },
            { label: 'ASIL分解示例', question: '请针对"自动驾驶域控制器核心软件架构"进行ASIL分解，从功能需求到技术安全需求的推导，并给出分解树示例。' },
            { label: 'SPI采集驱动生成', question: '我在做BMS单体电压采集，请生成一段通过SPI读取LTC6811电压的初始化与采集函数，包含CRC校验，代码需符合MISRA-C规范。' },
            { label: '软件FTA故障树', question: '我们需对EPS的转角传感器进行软件FTA，请以"转角信号错误输出"为顶事件，给出三个层级的故障树分支，并关联软件安全机制。' },
            { label: 'PWM安全输出代码', question: '制动灯控制器中，如何用软件实现PWM输出并监控占空比偏差，请生成带冗余检查的PWM安全控制代码。' },
            { label: 'MISRA goto重构', question: '我的一段代码用了goto语句，MISRA-C提示违反规则15，请分析规则15.1/15.2/15.3，并给出去除goto且保持状态机清晰的重构方案。' },
            { label: 'HARA危害分析示例', question: '我们正进行制动系统的危害分析与风险评估(HARA)，请给出整车级、系统级和软件级的危害示例，并说明如何分配ASIL等级。' },
            { label: '安全看门狗代码生成', question: '为满足ISO 26262 ASIL-B要求，请给出MCU内部看门狗刷新策略的代码框架，包含窗口看门狗配置和失效检测响应。' },
            { label: '传感器信号处理代码', question: '针对电动助力转向(EPS)的转矩传感器信号，请生成带有中位自学习功能的线性插值代码，并保证无数据溢出风险。' },
            { label: '安全手册大纲生成', question: '生成一份软件安全手册（Safety Manual）大纲，覆盖嵌入式软件的配置、操作、维护及安全机制使能说明，满足ISO 26262-10。' },
            { label: '安全数据转换模板', question: '请用MISRA-C:2012附录A的合规矩阵，针对"数据转换"类代码，列举常见违规并给出安全转换函数模板（如int到float）。' },
            { label: '电流故障检测逻辑', question: '如何对直流无刷电机FOC算法中的电流采样进行故障注入分析和检测？请提供过流、缺相和ADC滞死故障的软件检测逻辑。' },
            { label: '单元验证文档模板', question: '请生成一份满足ISO 26262的软件单元验证环境文档模板，说明测试覆盖、边界值分析及等效类划分的填写要求。' },
            { label: 'CAN通信代码生成', question: '如何用C语言实现带超时机制的CAN消息发送和接收，请生成完整的缓冲区管理代码，并确保函数可重入。' },
            { label: '健康监控代码框架', question: '为满足ASIL-D的故障处理时间间隔要求，请生成RTOS任务监控的健康监控代码框架，包含任务死循环检测和切出机制。' },
            { label: '安全NVM存储策略', question: '用软件实现NVM数据存储时，如何保证数据完整性和故障恢复，请提供E2E保护与回滚机制的伪代码及检查点策略。' },
            { label: '安全内存管理方案', question: '安全代码中使用了动态内存分配，违反MISRA-C规则21，请解释不安全原因并给出静态内存池替代方案，包括初始化与分配函数。' }
        ]
    },
    'test-verification-agent': {
        name: '试验设计与智能验证伙伴',
        desc: '根据DVP计划推荐试验方案（DOE），实时分析台架/道路试验数据，自动识别异常并生成验证报告',
        questions: [
            { label: '悬置刚度提取流程', question: '发动机悬置的静刚度试验数据存在蠕变效应，如何从力-位移曲线中区分粘弹性蠕变与永久变形，并自动提取静刚度？请给出数据处理流程。' },
            { label: '多信号PCA健康监测', question: '试验过程中，如何利用主成分分析（PCA）对多传感器信号降维，并构造综合健康指标，用于在线监测和早期预警？请提供步骤说明。' },
            { label: '焊点数据聚类分析', question: '车身焊点强度试验数据出现双峰分布，可能的原因是什么？如何用聚类或混合模型分离两组数据，并判定工艺是否受控？' },
            { label: '加速寿命试验设计', question: '我们在制定悬架弹簧疲劳试验DVP，请推荐一个加速寿命试验的应力水平组合，并给出基于逆幂律模型的加速因子计算示例。' },
            { label: 'DVP模板示例', question: '请设计一个完整的DVP&R模板，包含试验项目、接受准则、样本量、试验方法与设备，并以制动软管总成为例填写部分内容。' },
            { label: '载荷谱异常检测', question: '轮胎道路载荷谱数据中出现疑似异常高幅值冲击，如何用3σ原则和峭度指标自动识别并标记异常点？请给出判定逻辑。' },
            { label: '载荷谱加速编辑', question: '道路模拟试验中，我们想用损伤等效原理压缩载荷谱，请解释如何进行雨流计数及损伤保留编辑，并提供一个生成加速谱的步骤说明。' },
            { label: '温度场重构插值', question: '我们想对排气系统做热模态试验，但温度场不均匀，如何基于少量热电偶数据，结合仿真，用克里金插值重构全场温度，用于模态修正？' },
            { label: '轮速缺失值处理', question: '整车路试中，通过CAN总线采集的轮速信号丢失，如何设计一个缺失值插补算法（线性插值或基于ABS逻辑推断），并评价插补精度？' },
            { label: '制动热衰退DOE方案', question: '针对制动盘热衰退性能验证，请根据DVP计划给出一个中心复合试验设计（CCD）方案，说明因子（转速、压力、初始温度）水平及推荐样本量。' },
            { label: '催化剂老化等效设计', question: '对于催化器快速老化试验，如何设计一种超加速试验循环，使其与标准道路循环的贵金属烧结程度等效？请给出基于Arrhenius关系的等效策略。' },
            { label: '减震器示功数据分析', question: '已获得一组减震器台架示功试验数据，包含位移-力曲线，请提供Python代码片段，自动计算示功面积、复原/压缩阻尼系数，并判断是否超差。' },
            { label: '振动异常实时检测', question: '电池包振动台架试验中，某些测点加速度均方根值突然偏离，请提供一种实时异常检测算法思路（如CUSUM或滑动窗统计），并给出报警阈值设定依据。' },
            { label: '验证报告模板设计', question: '请用一张检测项-设备-频率矩阵的形式，推荐一套完整的智能验证报告模板，支持图片插入、P/F判定和趋势图生成。' },
            { label: '风扇噪声阶次分析', question: '在冷却风扇噪声试验中，如何对声压级频谱数据进行阶次跟踪分析，自动识别叶片通过频率及其谐波异常？请提供分析思路。' },
            { label: '自动验证报告生成', question: '台架试验结束后，如何自动生成一份验证结论报告？请给出文本生成框架：首先汇总P/F状态，然后对比设计目标与实测，最后给出偏离项分析和改进建议。' },
            { label: '磨损因子筛选DOE', question: '针对我们的转向拉杆球头耐久试验，需要分析7个因子（材料、热处理、润滑等）对磨损量的影响，请推荐一种筛选DOE方法（如Plackett-Burman），并给出试验次数和设计矩阵。' },
            { label: '齿轮寿命对比检验', question: '如何用假设检验比较两批变速箱齿轮接触疲劳寿命是否存在显著差异？请给出Weibull分布下的似然比检验方法，并提供计算示例。' },
            { label: '效率MAP数据清洗', question: '如何对电驱系统台架效率MAP数据进行自动平滑和离群点剔除？请提供LOESS或Savitzky-Golay滤波的参数选择原则和Python示例。' },
            { label: 'PSN曲线参数估计', question: '我们获得了高周疲劳S-N曲线的成组试验数据，请用极大似然法估计Basquin方程参数，并绘制P-S-N曲线，给出置信下限的计算代码逻辑。' }
        ]
    },
    'equipment-production-agent': {
        name: '装备与产线开发智能体',
        desc: '支持进行非标装备、智能产线及工装的初步方案设计、节拍分析、布局与虚拟调试',
        questions: [
            { label: '深孔钻削方案设计', question: '加工电机壳体深孔，深度/直径比大于10，如何设计枪钻加工方案？请推荐刀具、切削液压力流量及排屑策略。' },
            { label: '曲轴在线检具设计', question: '需要在线检测曲轴连杆颈磨削后的尺寸，请设计一套气动测量检具方案，给出测量精度、测头布置和标准件校准流程。' },
            { label: '随形冷却水路设计', question: '模具冲压公司希望降低覆盖件模具开发周期，请提出一种结合3D打印随形冷却水路的方案，并预估对注塑/冲压周期和温差的影响。' },
            { label: '齿轮刀具方案推荐', question: '接到新能源减速器齿轮订单，需要设计一套剃齿刀，请根据模数、压力角和齿数，推荐刀具材料和涂层方案，并给出刃磨周期建议。' },
            { label: '冲压线节拍提升', question: '模具冲压公司想提升顶盖外板冲压线效率，当前SPM为8，请分析如何通过拆垛、清洗、对中工序并行优化达到SPM12，并给出改进步骤。' },
            { label: '低压铸造模设计', question: '开发铝合金变速箱壳体低压铸造模具，请给出浇口和冒口布局原则，并说明如何通过仿真优化铸件冷却顺序。' },
            { label: '白车身焊装节拍', question: '焊装车间要建一条SUV白车身总拼线，如何通过节拍分析确定机器人数量？请给出一份包含地板线、侧围线和总拼站的布局草图说明。' },
            { label: '内花键拉刀设计', question: '加工新能源电机轴内花键，精度要求高，如何设计拉刀方案？请确定拉削方式（同廓/渐成）、齿升量和容屑槽参数。' },
            { label: '缸体机加线方案', question: '需要给商用车发动机缸体设计一条全自动机加线，如何根据年产10万件的纲领，推荐加工中心选型（卧加/立加）、排布方案和自动上下料方式？' },
            { label: '复合刀具方案设计', question: '需要设计一套用于曲轴法兰孔加工的复合刀具，请给出导条式镗铰刀方案，并说明加工余量分配和切削参数推荐。' },
            { label: '柔性夹具方案设计', question: '为变速箱壳体设计柔性产线，需兼容两种壳体型号，请设计一套可调式液压夹具方案，说明定位基准选择和快换策略。' },
            { label: '冲压模具快换方案', question: '针对模具冲压公司的侧围模具开发，请提供一种快速切换冲压模具的液压夹紧方案，并说明重复定位精度和防松设计要求。' },
            { label: '底盘合装AGV方案', question: '设计底盘合装线，发动机和后桥需在高节拍下自动对中拧紧，请推荐AGV合装方案及对中引导方式，并计算节拍。' },
            { label: '涂装前处理线计算', question: '为涂装线设计前处理输送系统，链速3m/min，请计算浸槽长度和各工序节拍，并说明如何避免串液。' },
            { label: 'SPS配送系统设计', question: '为总装线设计SPS物料配送系统，请说明料车设计要点、与AGV的接口规范和拣选防错逻辑。' },
            { label: '床身铸造缺陷预测', question: '计划为机床床身铸造设计浇注系统，如何通过仿真模型描述铁水充型和凝固过程，避免缩松缺陷？' },
            { label: '拉延模缺陷优化', question: '翼子板拉延模调试出现开裂和起皱，如何通过冲压仿真参数调整（压边力、拉延筋）平衡两种缺陷？请给出工艺优化步骤。' },
            { label: '3D打印砂芯设计', question: '引入3D砂型打印用于铸造，如何设计铸造工艺以保证复杂水套芯的排气和清砂？请给出砂芯结构优化建议。' },
            { label: '车桥装配线规划', question: '需要设计一套重型卡车车桥装配线，请规划主减速器、差速器和轮端的装配工序，并计算装配节拍和工位数。' },
            { label: '缸盖线产能提升', question: '现有缸盖线产能不足，需要从45JPH提升到60JPH，请通过节拍分析识别瓶颈工位，并提出钻削和攻丝工位的平衡改进建议。' }
        ]
    },
    'standards-innovation-agent': {
        name: '标准法规与技术创新检索',
        desc: '实时查询国内外零部件/装备的标准、法规及认证要求，同时提供专利、论文和TRIZ创新原理推送，激发技术突破',
        questions: [
            { label: '电池包EMC认证查询', question: '为48V轻混电池包进行CE认证时，涉及哪些EMC指令和测试标准？请按CISPR 25和ISO 11452列出辐射和传导测试项。' },
            { label: '电池热失控标准解读', question: '我们在开发满足GB 38031的电池包，请解释其中"热失控后5分钟不起火"条款的测试方法和判定条件，并对比联合国UN R100的差异。' },
            { label: '磁流变悬置专利分析', question: '请检索关于"磁流变悬置"的中文和外文专利，分析其技术成熟度和创新主体分布，并推送最相关的5篇核心专利摘要。' },
            { label: '转向器欧盟法规查询', question: '我们正在开发出口欧盟的电动助力转向器，请列出适用的法规（如ECE R79）和协调标准，并说明功能安全认证（ISO 26262）在其中的引用要求。' },
            { label: '轮毂标准对比', question: '设计一款供给北美市场的铝合金轮毂，需要满足哪些SAE和FMVSS标准？请对比SAE J2530与我国GB/T 3487的性能差异。' },
            { label: '制动法规工况对比', question: '商用车制动气室需通过ECE R13认证，请解释"动态制动性能"的具体测试工况及与GB 12676的差异点。' },
            { label: '复材传动轴标准', question: '我们在开发一种碳纤维复合材料传动轴，请查找国内外相关的疲劳试验标准（如ISO 1143、DIN 50100），并给出振动耐久性测试的规范要求。' },
            { label: 'DPF再生技术检索', question: '针对柴油机后处理系统的DPF再生策略，请查询相关美国专利和公开论文，总结主流的主动再生和被动再生技术路线。' },
            { label: '座椅KC认证对比', question: '出口韩国的汽车座椅需通过KC认证，请列出座椅总成需要满足的KMVSS条款及对应的韩国标准号，并与3C认证进行差异比较。' },
            { label: '电驱桥专利预警分析', question: '为电驱桥设计开展专利预警，请对"集成式电驱桥减速机构"进行全球专利检索，并分析主要竞争对手的布局点和潜在侵权风险。' },
            { label: '传感器E-mark认证流程', question: '我司一款轮速传感器要申请ECE R10的e-mark认证，请梳理认证流程、所需文档和测试样件数量要求。' },
            { label: '换挡器TRIZ进化预测', question: '在换挡执行器设计中，如何通过TRIZ技术进化法则预测下一代产品可能的创新方向？请以"小型化"和"模块化"为例进行趋势分析。' },
            { label: '线控制动专利检索', question: '请检索近三年关于"线控制动用电磁阀"的发明专利和实用新型，给出专利号、申请人及核心权利要求摘要，并指出技术热点。' },
            { label: '注塑周期TRIZ应用', question: '如何运用TRIZ的40个发明原理对"降低传感器壳体注塑成型周期"进行方案生成？请推荐原理15动态化、原理28机械替代的具体应用方式。' },
            { label: 'PCB过孔TRIZ改进', question: '车辆控制器的PCB过孔设计常出现断裂，请用TRIZ物场分析给出改进方案，并推送可能的发明原理（如分割、复合材料等）。' },
            { label: '涡壳TRIZ矛盾解决', question: '如何利用TRIZ矛盾矩阵解决"提高涡轮增压器涡壳耐热强度"与"降低镍基合金重量"之间的技术冲突？请推荐相应的发明原理。' },
            { label: '水泵绝缘标准要求', question: '电子水泵的绝缘性能需要满足GB/T 18384和ISO 6469-3，请列出具体的绝缘电阻和耐压测试参数，并说明爬电距离的设计要求。' },
            { label: '车灯日本标准对比', question: '车灯模组即将出口日本，请提供JIS D 5500标准的照明光型要求，并与GB 25991进行配光性能对比。' },
            { label: '振动标准差异对比', question: '请对比ISO 16750-3与GB/T 28046.3对控制器机械振动试验的量级和持续时间要求，指出两者在商用车应用中的适用差异。' },
            { label: '热泵论文检索总结', question: '针对"新能源汽车热泵系统"的关键技术，请检索近五年Web of Science上的高被引论文，总结主要研究方向（如制冷剂替代、压缩机优化）。' }
        ]
    }
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
        'dfmea-risk-agent': { name: 'DFMEA与风险分析专家', task: '引导开展设计/过程失效模式分析，关联历史失效库，自动完成风险优先级评分，并推送预防措施', summary: 'DFMEA与风险分析' },
        'part-design-agent': { name: '零部件智能设计助手', task: '辅助参数化建模、结构方案推荐、尺寸链计算与3D标注检查，加速零部件设计', summary: '零部件设计' },
        'simulation-optimization-agent': { name: '多学科仿真与优化代理', task: '自动驱动结构强度、刚度、NVH、热管理、流体等分析，并进行多目标优化，减少手动仿真迭代', summary: '仿真与优化' },
        'material-selection-agent': { name: '材料与轻量化选型顾问', task: '基于性能、成本与工艺约束，从材料库中推荐金属、复合材料或轻量化方案，并预估减重效果', summary: '材料与轻量化' },
        'manufacturing-process-agent': { name: '制造工艺仿真与工艺卡生成器', task: '针对关键工艺，进行成形仿真、缺陷预测，并输出标准化工艺卡片', summary: '制造工艺' },
        'ee-design-agent': { name: '电子电气设计协同智能体', task: '协助汽车电子零部件（传感器、控制器等）的电路设计检查、信号完整性分析、原理图与PCB布局评审', summary: '电子电气设计' },
        'embedded-software-agent': { name: '嵌入式软件与功能安全助手', task: '自动生成基础代码、进行MISRA-C检查，辅助完成功能安全（ISO 26262）相关的安全分析与文档', summary: '嵌入式与功能安全' },
        'test-verification-agent': { name: '试验设计与智能验证伙伴', task: '根据DVP计划推荐试验方案（DOE），实时分析台架/道路试验数据，自动识别异常并生成验证报告', summary: '试验与验证' },
        'equipment-production-agent': { name: '装备与产线开发智能体', task: '支持进行非标装备、智能产线及工装的初步方案设计、节拍分析、布局与虚拟调试', summary: '装备与产线' },
        'standards-innovation-agent': { name: '标准法规与技术创新检索', task: '实时查询国内外零部件/装备的标准、法规及认证要求，同时提供专利、论文和TRIZ创新原理推送，激发技术突破', summary: '标准法规与技术创新' }
    };

    const correctAgents = Object.keys(defaults).map(id => {
        const def = defaults[id];
        const ex = existingMap[id];
        return {
            id: id,
            name: ex ? (ex.name || def.name) : def.name,
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
    const filtered = agents.filter(a => ALLOWED_AGENT_IDS.includes(a.id) || (a.id && a.id.startsWith('agent_')));
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
        document.getElementById('chatTitle').textContent = '东风科技研发智能体平台';
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
        const item = document.createElement('div');
        item.className = `agent-item${agent.id === currentAgentId ? ' active' : ''}`;
        item.setAttribute('data-agent-id', agent.id);
        const initial = (agent.name && agent.name[0] || '?').toUpperCase();
        item.innerHTML = `
            <div class="agent-item-info">
                <div class="agent-item-name">${escapeHtml(agent.name)}</div>
            </div>
            <button class="agent-action-btn new-chat" data-action="new-chat" data-agent-id="${agent.id}" title="新建对话" aria-label="新建对话"><svg width="22" height="22" viewBox="0 0 24 24" class="agent-new-chat-icon"><rect x="1" y="1" width="22" height="22" rx="6" ry="6" fill="#C62828"/><path d="M9.5 6.5L18.5 12L9.5 17.5Z" fill="white"/></svg></button>
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

function updateKbUploadVisibility() {
    const kbBtn = document.getElementById('kbUploadToggle');
    // 只在 agent 模式 且 选中了某个智能体 时才显示知识库上传按钮
    if (currentMode === 'agent' && currentAgentId) {
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
            titleEl.textContent = agent ? agent.name : '东风科技研发智能体平台';
        } else {
            titleEl.textContent = mode === 'agent' ? '东风科技研发智能体平台' : 'Chat';
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
async function loadModels() {
    try {
        const resp = await fetch('/api/v1/models');
        const data = await resp.json();
        const select = document.getElementById('modelSelect');
        select.innerHTML = '';
        data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id; opt.textContent = m.name; opt.title = m.desc;
            if (m.id === data.current) opt.selected = true;
            select.appendChild(opt);
        });
    } catch (e) { console.error('加载模型列表失败', e); }
}

async function switchModel() {
    const modelId = document.getElementById('modelSelect').value;
    try {
        const resp = await fetch('/api/v1/models/set', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ model_id: modelId }) });
        const data = await resp.json();
        if (data.success) {
            const select = document.getElementById('modelSelect');
            const name = select.options[select.selectedIndex].textContent;
            addMessageToUI('assistant', `✅ 已切换到模型: ${name}`);
        }
    } catch (e) { console.error('切换模型失败', e); }
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
                document.getElementById('loginModal').classList.remove('show');
                document.getElementById('chatPage').style.display = 'flex';
                document.body.classList.add('body-chat-mode');
                // [BUG FIX] Push history state so browser back button returns to login
                history.pushState({page: 'chat'}, '');
                document.getElementById('headerUserName').textContent = username;
                document.getElementById('headerUserAvatar').textContent = username[0].toUpperCase();
                // 显示管理员标识
                if (userRole === 'admin') {
                    document.getElementById('headerUserName').textContent = username + ' (管理员)';
                }
                loadChatList();
                loadModels();
                await syncAgentsFromServer(true);  // [#12] 登录时强制同步一次，内部已调用 rebuildChatIdsFromServer（会GET /chats）
                renderMyAgents();
                updateKbUploadVisibility();
                updateHeaderKbVisibility();
                // [#14] 默认选中第一个智能体，避免进入空白的agent模式
                if (!currentAgentId && myAgents.length > 0) {
                    await switchToAgent(myAgents[0].id);
                }
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
            // 自动登录成功：隐藏登录页，显示聊天页
            document.getElementById('loginModal').classList.remove('show');
            document.getElementById('chatPage').style.display = 'flex';
            document.body.classList.add('body-chat-mode');
            // [BUG FIX] Push history state so browser back button returns to login
            history.pushState({page: 'chat'}, '');
            document.getElementById('headerUserName').textContent = data.username;
            document.getElementById('headerUserAvatar').textContent = data.username[0].toUpperCase();
            loadChatList();
            loadModels();
            await syncAgentsFromServer(true);  // [#12] 自动登录时强制同步
            renderMyAgents();
            updateKbUploadVisibility();
            updateHeaderKbVisibility();
            // [#14] 默认选中第一个智能体，避免进入空白的agent模式
            if (!currentAgentId && myAgents.length > 0) {
                await switchToAgent(myAgents[0].id);
            }
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
            <h2>东风科技研发智能体平台</h2>
            <p>专业模具AI智能体，独立赋能研发与质量管理</p>
            <div class="quick-actions">
                <span class="quick-action" onclick="fillQuick(this)" data-question="模具设计评审有哪些关键节点？" role="button" tabindex="0">设计评审</span>
                <span class="quick-action" onclick="fillQuick(this)" data-question="VDA6.4过程审核要点是什么？" role="button" tabindex="0">过程审核</span>
                <span class="quick-action" onclick="fillQuick(this)" data-question="帮我分析DFMEA风险" role="button" tabindex="0">DFMEA分析</span>
                <span class="quick-action" onclick="fillQuick(this)" data-question="不合格品纠正措施怎么制定？" role="button" tabindex="0">CAPA建议</span>
            </div>
        `;
    }
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
                item.innerHTML = `<span class="doc-icon">${icon}</span><span class="doc-name">${safeName}</span><button class="doc-download-btn" onclick="downloadDocument('${safeNameForAttr}')" title="下载" aria-label="下载文档">📥</button><button class="doc-delete-btn" onclick="deleteDocument('${safeNameForAttr}', this)">删除</button>`;
                list.appendChild(item);
            });
        } else { list.innerHTML = '<div class="doc-empty">暂无文档，请上传</div>'; }
    } catch (e) { list.innerHTML = '<div class="doc-empty">加载失败</div>'; }
}

async function onKbFileSelected(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) { await uploadToKnowledgeBase(files[i]); }
    document.getElementById('kbFileInput').value = '';
    await loadDocList();
}

async function deleteDocument(filename, btnEl) {
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
    if (bar && text) {
        if (skillId === '8d-skill') {
            text.textContent = '8D SKILL模式';
        }
        bar.style.display = '';
    }
    // 同步隐藏知识库上传模式（互斥）
    if (agentKbUploadMode) toggleAgentKbUpload();
    showToast('已启用 8D SKILL 模式');
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
            listEl.innerHTML = '<div class="kb-empty">暂无文档，点击上方按钮上传</div>';
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
                (userRole === 'admin' ? '<button class="kb-doc-delete" onclick="deleteKbDoc(\'' + docName.replace(/'/g, "\\'") + '\')" title="删除文档">🗑️</button>' : '') +
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
    if (userRole !== 'admin') { showToast('仅管理员可删除文档'); return; }
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
    // [BUG FIX] 确保历史状态回到chat（手动关闭知识库时）
    if (history.state && history.state.page === 'kb') {
        history.replaceState({page: 'chat'}, '');
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
            listEl.innerHTML = '<div class="kb-doc-empty">暂无文档，请点击上方区域上传</div>';
            return;
        }
        let html = '';
        docs.forEach(docName => {
            const ext = docName.split('.').pop().toLowerCase();
            let iconHtml = '';
            if (ext === 'pdf') {
                iconHtml = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
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
                (userRole === 'admin' ? '<button class="kb-doc-delete-btn" onclick="deleteKbPageDoc(\'' + safeNameForJs + '\', this)" title="删除文档" aria-label="删除">' +
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
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
        await uploadToKbPage(files[i]);
    }
    event.target.value = '';
    await loadKbPageDocs();
}

async function uploadToKbPage(file) {
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
            barFill.style.background = '#ef4444';
            statusEl.textContent = '上传失败：' + (data.detail || '未知错误');
            statusEl.className = 'kb-progress-status error';
        }
    } catch (e) {
        barFill.style.width = '100%';
        barFill.style.background = '#ef4444';
        statusEl.textContent = '网络错误，请重试';
        statusEl.className = 'kb-progress-status error';
    }
    setTimeout(() => { progressEl.style.display = 'none'; barFill.style.background = ''; }, 3000);
}

async function deleteKbPageDoc(filename, btnEl) {
    if (userRole !== 'admin') { showToast('仅管理员可删除文档'); return; }
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

