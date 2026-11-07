// 「运行模式只有一个来源」的架构守卫。
//
// 背景：模式曾同时活在三个地方 —— 工程的 `hil.mode`（随文件保存）、renderer store 顶层的
// 内存 `run.mode`（真正被跑的那个）、以及通道自己推导出来的那个。三者靠"导出/运行前把 run
// 抄进 hil"来维持一致。任何一条路径漏抄，界面上就会出现「首行 REALTIME、阶段行 OFFLINE」
// 这种同屏打架，而用户无从分辨哪个是真的。
//
// 统一后唯一来源是 `project.run`（见 core/types.ts 的 RunConfig），随工程保存与切换。
//
// 为什么需要文本扫描而不是只靠类型：编译器只能守 TypeScript 的类型面，
// 守不住"某人又加回一个 store 级 run""通道又自己猜一次模式"这类退化 ——
// electron/serverMonitor.cjs 根本不在 tsc 的视野里，而它恰恰最危险
// （独立进程 + 模块缓存，源码改了不重启不生效，漂移是静默的）。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 剥掉注释：只留下真正会被执行的代码 —— 免得注释里提到旧字段名就误报 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|vue)$/.test(e)) out.push(rel);
  }
  return out;
}

/** src 下参与扫描的文件（排除内置场景数据：那里是纯 JSON，不是逻辑） */
const files = sourceFiles('src').filter((f) => !f.includes('/scenarios/'));

function codeOf(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

describe('运行模式：唯一来源是工程的运行设置（架构守卫）', () => {
  it('不再存在第二份运行设置（store 级 / wb 级 run）', () => {
    const bad = files.filter((f) => /\bstore\.run\b|\bwb\.run\b/.test(codeOf(f)));
    expect(bad, '运行设置只应存在于 project.run').toEqual([]);
  });

  it('模式与时钟源不再从 hil 段读写（那是旧的寄生位置，会造出第二个真相）', () => {
    const bad = files.filter((f) => /hil\??\.(mode|clockSource)\b/.test(codeOf(f)));
    expect(bad, 'hil 段只应保留引擎参数（timestepUs / simulatorAddr）').toEqual([]);
  });

  it('不再有"把运行设置覆盖进工程"的同步动作（project.hil = …）', () => {
    const bad = files.filter((f) => /project\.hil\s*=\s*\{/.test(codeOf(f)));
    expect(bad, '运行设置本就长在工程里，不需要任何拷贝').toEqual([]);
  });

  it('生成器默认值取自 run，而不是回头去读 hil', () => {
    const code = codeOf('src/generator/generator.ts');
    expect(code).toContain('config.run ?? DEFAULT_RUN');
    expect(code).not.toMatch(/config\.hil\??\.mode/);
  });

  it('通道不自己推导模式（独立进程 + 模块缓存，任何"猜"都会与渲染端漂移）', () => {
    const code = stripComments(readFileSync(join(ROOT, 'electron/serverMonitor.cjs'), 'utf8'));
    // 不得出现三值白名单式的推导（曾把 REALTIME 静默塌成 OFFLINE）
    expect(code).not.toMatch(/p\.mode\s*===\s*'HIL'\s*\?/);
    // 也不得在阶段行里复述模式名：模式只在会话首行出现一次
    expect(code).not.toContain('· ${mode}');
  });

  it('每一处模式选择器都给全三个选项（少一个 = 那个模式在界面上无处可选）', () => {
    // 工程可以合法持有 REALTIME（文件层三值、旧工程迁移也认它），
    // 而某个页面只列了"离线/HIL"的话，那个 radio 组会匹配不上任何一项 → 一个都不选，
    // 用户以为"没设模式"，实际设置里躺着个界面看不见的值。这正是"第二个真相"的另一种形态。
    const MODES = ['OFFLINE', 'REALTIME', 'HIL'];
    const offenders: string[] = [];
    for (const f of files) {
      const raw = codeOf(f);
      const picked = new Set<string>();
      for (const m of raw.matchAll(/<el-radio-button\s+value="(OFFLINE|REALTIME|HIL)"/g)) picked.add(m[1]);
      if (picked.size && [...MODES].some((m) => !picked.has(m))) {
        offenders.push(`${f}: 只有 ${[...picked].join('/')}`);
      }
    }
    // 用 join 拼进字符串：数组断言的 diff 会被报告截短，看不到是哪一个文件缺哪一项
    expect(offenders.join(' | '), '模式选择器少选项 = 那个模式在界面上无处可选').toBe('');
  });
});
