// W7 注入切换器：按模式/HIL/时钟源/采样 生成注入段
// L2 保守步进同步引擎：外部真实时钟（PTP 优先、墙钟回退）为令，仿真绝不对墙钟超前；
// 步进滞后判定 + 连续超预算降级回退（架构 4.1/4.2 约束：同步判断不依赖 Simulator::Now()）。
import type { BuildOptions } from './builder';
// 遥测前缀的单一来源在 core/simOutput.ts（解析器从中取，这里拼进产物）
import { EPC_PREFIX } from '../core/simOutput';

/**
 * 采样节流说明（头部注释）：precise = 精确采样逐点输出，rough = 粗略采样抽稀。
 * 只描述生成态配置，不落地运行时可切换逻辑（先行版产物里采样节流由 HIL 引擎接管）。
 */
export function samplingDoc(precise: boolean): string {
  return precise
    ? `// 采集：precise（精确采样，逐采样点输出，数据峰值高）`
    : `// 采集：rough（粗略采样，抽稀输出以控数据量）`;
}

/**
 * main 顶部注入：启用实时仿真器实现。
 * RealtimeSimulatorImpl 让 ns-3 事件调度与墙钟对齐——仿真时间绝不跑在真实时间前面，
 * 这是"挂钟实时"模式（REALTIME / HIL）的时间基准。
 *
 * **位置纪律（踩过坑，别再挪）**：这段必须是 main 体里**第一条**会被执行的语句，
 * 早于任何 `Simulator::` 调用。`Simulator::GetImpl()` 是懒加载单例
 * （见 ns-3 `src/core/model/simulator.cc`：`static SimulatorImpl* impl = nullptr;`，
 * 首次为空时读 `g_simTypeImpl` 建对象并缓存）——一旦被触碰，就按**当时**的 GlobalValue
 * 定下实现类型；之后再 `GlobalValue::Bind` 只改默认值，**不会重建已缓存的实例**。
 *
 * 曾经的写法把启动遥测（内部是 `Simulator::Now()`）排在绑定之前，于是首次触碰发生在
 * 绑定之前 → 缓存了 `DefaultSimulatorImpl` → 实时模式名义上在跑、实际全速：
 * 实测 10s 仿真时间在 ~1ms 墙钟内跑完，`[EPC-HIL]` 十条 tick 的 jitter 线性增长到 ~9s,
 * Runtime 曲线不再随墙钟滚动（"实时"这个前提直接失效）。
 *
 * REALTIME 模式：纯软件实时，直接无条件绑定 RealtimeSimulatorImpl。
 * HIL 模式：受 --hil 参数控制（保留与历史命令行兼容）。
 */
export function buildRealtimeBind(opts: BuildOptions): string | undefined {
  if (opts.mode === 'OFFLINE') return undefined;
  if (opts.mode === 'REALTIME') {
    // 同步模式由运行设置的「同步」项决定：默认 HARD_LIMIT（硬墙钟），
    // 选 BEST_EFFORT 才会退化为"尽力追赶"（强机上提前跑完）。HIL 不在此列（走保守步进恒为 HardLimit）。
    const sync = (opts.syncMode ?? 'HARD_LIMIT') === 'HARD_LIMIT' ? 'HardLimit' : 'BestEffort';
    const doc =
      sync === 'HardLimit'
        ? `  //   同步模式=${sync}(HardLimit，硬墙钟极限)：仿真净时绝不超过墙钟——若用 BestEffort，`
        : `  //   同步模式=${sync}(BestEffort，尽力追赶)：允许仿真超前墙钟，强机上 10s 仿真可能几秒墙钟就跑完。`;
    return [
      `  // [REALTIME] 挂钟实时模式：仿真时间与墙钟对齐，绝不超前。`,
      `  //   必须最先绑定：GetImpl() 是懒加载单例，首次触碰（哪怕只是 Simulator::Now()）`,
      `  //   就会缓存 DefaultSimulatorImpl，之后 Bind 换不掉 —— 实时会静默退化成全速仿真。`,
      `  GlobalValue::Bind("SimulatorImplementationType", StringValue("ns3::RealtimeSimulatorImpl"));`,
      doc,
      `  Config::SetDefault("ns3::RealtimeSimulatorImpl::SynchronizationMode", StringValue("${sync}"));`,
    ].join('\n');
  }
  // HIL
  return [
    `  // [HIL] 保守步进：以外部真实时钟为令，仿真绝不超前墙钟。`,
    `  //   必须最先绑定：GetImpl() 是懒加载单例，首次触碰（哪怕只是 Simulator::Now()）`,
    `  //   就会缓存 DefaultSimulatorImpl，之后 Bind 换不掉 —— HIL 会静默退化成全速仿真。`,
    `  if (hil) {`,
    `    GlobalValue::Bind("SimulatorImplementationType", StringValue("ns3::RealtimeSimulatorImpl"));`,
    `    Config::SetDefault("ns3::RealtimeSimulatorImpl::SynchronizationMode", StringValue("HardLimit"));`,
    `  }`,
  ].join('\n');
}

/**
 * main 前注入：L2 保守步进同步引擎类。
 * 时钟抽象：PTP(外部主时钟) 优先；PTP 不可用回退内置墙钟并告警（对齐架构：时钟源可选，
 * PTP 无网卡/未同步时自动降级内置 + 告警）。滞后判定 + 连续超预算降级回退。
 */
export function buildHilSyncClass(opts: BuildOptions): string | undefined {
  if (opts.mode !== 'HIL') return undefined;
  const stepMs = opts.stepMs ?? 1000;
  const budgetRatio = opts.stepBudgetRatio ?? 0.8;
  const degradeAfter = opts.stepDegradeAfter ?? 3;
  return [
    `// [HIL] L2 保守步进同步引擎（外部真实时钟为令，绝不超前；PTP 回退内置；滞后超预算 + 降级回退）`,
    `//   - 同步判断一律用外部墙钟（std::chrono），不依赖 Simulator::Now()。`,
    `//   - PTP 主时钟经 hilPtpNowMs() 读取；返回负值视为不可用 → 回退内置墙钟并告警。`,
    `//   - 第 k 步在时间轴上应到达 k×stepMs；墙钟若已走到该时刻之后，多出的部分即"滞后"。`,
    `//     滞后 > stepMs×budgetRatio 记一次超预算，连续 degradeAfter 次 → 降级回退。`,
    `class HilStepGuardian {`,
    `public:`,
    `  enum ClockSource { PTP, INTERNAL };`,
    `  HilStepGuardian(ClockSource src, double stepMs, double budgetRatio, uint32_t degradeAfter)`,
    // 初始化列表顺序**必须**与下方成员声明顺序一致，否则 gcc 报 -Wreorder（Clang/MSVC 同）；
    // 顺序不符时实际初始化顺序仍按声明来，易在"后面成员依赖前面成员"时埋真 bug。
    `    : m_src(src), m_stepMs(stepMs), m_budgetMs(stepMs * budgetRatio),`,
    `      m_degradeAfter(degradeAfter), m_overrun(0), m_steps(0),`,
    `      m_latestDriftMs(0.0), m_epoch(std::chrono::steady_clock::now()),`,
    `      m_ptpUsable(false), m_degraded(false) {`,
    `    if (src == PTP) {`,
    `      // 探测 PTP 主时钟：可用则锁定 PTP，否则立即回退内置墙钟并告警`,
    `      m_ptpUsable = hilPtpNowMs() >= 0;`,
    `      if (!m_ptpUsable) {`,
    `        m_src = INTERNAL;`,
    `        std::cerr << "[HIL][fallback] PTP 时钟不可用（无网卡或未同步），回退内置墙钟。" << std::endl;`,
    `      }`,
    `    }`,
    `  }`,
    `  `,
    `  // 保守步进一次：核校本步相对外部真实时钟的滞后，返回是否落在算力预算内。`,
    `  // 判据不读 Simulator::Now()（架构约束）：第 k 步（k 自 0 起）在时间轴上应到达 k×stepMs，`,
    `  // 而墙钟此刻已走 wallNow；两者之差即滞后，为正说明仿真跟不上真实时钟（算力不足）。`,
    `  bool Step() {`,
    `    const auto now = std::chrono::steady_clock::now();`,
    `    const double wallNow = std::chrono::duration<double, std::milli>(now - m_epoch).count();`,
    `    const double dueMs = static_cast<double>(m_steps) * m_stepMs;`,
    `    m_latestDriftMs = wallNow - dueMs;`,
    `    ++m_steps;`,
    `    const bool ok = m_latestDriftMs <= m_budgetMs;`,
    `    if (ok) { m_overrun = 0; return true; }`,
    `    if (++m_overrun >= m_degradeAfter) Degrade();`,
    `    return false;`,
    `  }`,
    `  `,
    `  // 步数 / 最新滞后(ms) / 是否已降级`,
    `  uint64_t Steps() const { return m_steps; }`,
    `  double DriftMs() const { return m_latestDriftMs; }`,
    `  bool Degraded() const { return m_degraded; }`,
    `  ClockSource Source() const { return m_src; }`,
    `  double StepMs() const { return m_stepMs; }`,
    `private:`,
    `  // PTP 真读接口由 L3 硬件适配层替换实现；当前桩返回 -1 → 触发回退内置墙钟`,
    `  static double hilPtpNowMs() { return -1.0; }`,
    `  void Degrade() {`,
    `    if (m_degraded) return;`,
    `    m_degraded = true;`,
    `    std::cerr << "[HIL][downgrade] 连续 " << m_degradeAfter << " 步滞后超出预算，"`,
    `              << "进入降级回退（放宽步进预算、稀疏化采样）。" << std::endl;`,
    `  }`,
    `  ClockSource m_src;`,
    `  double m_stepMs;`,
    `  double m_budgetMs;`,
    `  uint32_t m_degradeAfter;`,
    `  uint32_t m_overrun;`,
    `  uint64_t m_steps;`,
    `  double m_latestDriftMs = 0.0;`,
    `  std::chrono::steady_clock::time_point m_epoch;`,
    `  bool m_ptpUsable;`,
    `  bool m_degraded;`,
    `};`,
    `  `,
    `// 周期保守步进校验：每 periodMs 校时一次（由外部真实时钟驱动的校时 tick，`,
    `// 配合 RealtimeSimulatorImpl 使仿真绝不超前；滞后超预算上报，连续超限由引擎降级回退）。`,
    `static void HilStepGuardianTick(HilStepGuardian* g, double periodMs) {`,
    `  const bool ok = g->Step();`,
    `  // [EPC-HIL] 遥测行：Runtime「HIL 同步」组件的数据源（时钟源 / 步长 / 滞后抖动 / 降级位）。`,
    `  // 无论是否超预算都发 —— 曲线要能看出"从哪一步开始劣化"，只在超限时发就只剩孤点、画不出趋势。`,
    `  // jitter 取滞后绝对值：滞后有正负（超前为负），而组件展示的是「抖动幅度」。`,
    `  const int64_t lagUs = static_cast<int64_t>(g->DriftMs() * 1000.0);`,
    `  std::cout << "${EPC_PREFIX.hil}t=" << Simulator::Now().GetMicroSeconds()`,
    `            << " src=" << (g->Source() == HilStepGuardian::PTP ? "PTP" : "INTERNAL")`,
    `            << " step=" << static_cast<int64_t>(g->StepMs() * 1000.0)`,
    `            << " jitter=" << (lagUs < 0 ? -lagUs : lagUs)`,
    `            << " degraded=" << (g->Degraded() ? 1 : 0) << std::endl;`,
    `  if (!ok) std::cerr << "[HIL] 步进#" << g->Steps() << " 落后真实时钟 " << g->DriftMs() << "ms，超出算力预算" << std::endl;`,
    `  Simulator::Schedule(MilliSeconds(periodMs), &HilStepGuardianTick, g, periodMs);`,
    `}`,
  ].join('\n');
}

export function buildHilBlock(opts: BuildOptions): string | undefined {
  if (opts.mode !== 'HIL') return undefined;
  const clock = opts.clockSource;
  const stepMs = opts.stepMs ?? 1000;
  return [
    `// [HIL 注入] 主从保守步进闭环（${clock}）`,
    `if (hil) {`,
    `  //  电力仿真器为主时钟，本 ns-3 为从时钟，绝不超前。`,
    `  //  时序: 量测 + 步进指令 → 外部事件入 ns-3 事件队列 → 通信域计算 → 步进确认。`,
    `  //  同步判断基于外部真实时钟(时钟源 ${clock})，不依赖 Simulator::Now()。`,
    `//  装配 L2 保守步进同步引擎（每 ${stepMs}ms 一个步进，滞后预算 = 步长 × 预算比，连续超预算降级回退）`,
    `  //  必须是「函数内 static」：周期 tick 把 &sync 存进 ns-3 事件队列，会活到本 if 块之外；`,
    `  //  普通块内局部量在块尾即结束生命周期，之后每个 tick 都在读已失效的内存 ——`,
    `  //  实测症状极具迷惑性：第一步读数正常，第二步起 step/预算被邻居栈槽改写 →`,
    `  //  滞后算出来是垃圾值、降级位从第 3 步起永久为 1（曲线一直显示"降级"）。`,
    `  //  与半实物 EpcTapCounter 同一条纪律（见 telemetry.ts）。`,
    `  static HilStepGuardian sync(`,
    `      ${clock === 'PTP' ? 'HilStepGuardian::PTP' : 'HilStepGuardian::INTERNAL'},`,
    `      ${stepMs}.0, ${(opts.stepBudgetRatio ?? 0.8).toFixed(2)}, ${opts.stepDegradeAfter ?? 3});`,
    `  // 时钟可用性由构造期探测（PTP 不可用即回退内置），此处只报状态。`,
    `  // **不要**在这里先调一次 sync.Step()：那会把步数提前 +1，使调度器第一次 tick（t=0）`,
    `  // 的 due 变成 1×stepMs，滞后恒为 -stepMs —— Runtime 的「HIL 同步」组件会凭空出现一个`,
    `  // ~1s 的抖动尖峰，看曲线的人只会以为同步坏了。步数就应严格等于已发生的 tick 数。`,
    `  std::cerr << "[HIL] 保守步进引擎就绪: 时钟源=" << (sync.Source() == HilStepGuardian::PTP ? "PTP" : "内置墙钟")`,
    `            << " 预算=" << ${(opts.stepBudgetRatio ?? 0.8).toFixed(2)} << "x 步长=" << ${stepMs}.0 << "ms" << std::endl;`,
    `  // 同一条就绪信息也走遥测通道，让 Runtime 的「操作日志」组件能直接看到（stderr 不进遥测管道）`,
    `  EpcLog("info", "hil", std::string("保守步进引擎就绪 时钟源=")`,
    `      + (sync.Source() == HilStepGuardian::PTP ? "PTP" : "INTERNAL")`,
    `      + " 步长=" + std::to_string(static_cast<int>(${stepMs}.0)) + "ms");`,
    `  // 启动周期保守步进校验：整段仿真运行期内持续校时 / 超预算上报 / 连续超限降级`,
    `  HilStepGuardianTick(&sync, ${stepMs}.0);`,
    `}`,
  ].join('\n');
}
