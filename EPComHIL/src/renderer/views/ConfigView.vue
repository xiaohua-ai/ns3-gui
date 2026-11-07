<script setup lang="ts">
// W4 配置页：节点 / 协议(L2/L3) / 业务流 / 半实物（架构 5.2、7.4）。运行相关设置见拓扑页「运行设置」
import { reactive, ref, computed, watch, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Setting, Refresh } from '@element-plus/icons-vue';
import { useWorkbench } from '@/stores/workbench';
import { AUTO_NAME_RE, KIND_LABEL, KIND_ORDER } from '@/constants/nodeMeta';
import type { NodeKind, ProtocolType, FlowType, ProtocolConfig, FlowConfig } from '@core/types';

const store = useWorkbench();
const activeTab = ref('node');

const PROTO_LIST = ['MMS', 'GOOSE', 'MODBUS_TCP', 'MODBUS_RTU', 'CUSTOM'];
const FLOW_LIST: FlowType[] = ['CBR', 'ONOFF', 'PERIODIC', 'EVENT', 'CONTROL'];

// ---------- 节点 ----------
const nodeDlg = reactive({ show: false, kind: 'ied' as NodeKind, name: '' });
function openNodeAdd() {
  nodeDlg.kind = 'ied';
  nodeDlg.name = store.nextNodeName(nodeDlg.kind);
  nodeDlg.show = true;
}
// 切类型时，若名字还是「类型_序号」这种自动名（用户没手动改过），就跟着换成新类型的默认名
function onNodeKindChange() {
  if (!nodeDlg.name.trim() || AUTO_NAME_RE.test(nodeDlg.name.trim())) {
    nodeDlg.name = store.nextNodeName(nodeDlg.kind);
  }
}
function confirmNode() {
  if (!nodeDlg.name.trim()) return ElMessage.warning('请填写节点名称');
  // 与拓扑页共用同一发号器，杜绝两页各自自增导致 id 撞号
  const id = store.nextNodeId();
  const name = nodeDlg.name.trim();
  store.addNode({ id, name, kind: nodeDlg.kind });
  nodeDlg.show = false;
  ElMessage.success(`已新增节点 ${name}（id=${id}）`);
}

// ---------- 协议 ----------
const protoDlg = reactive({ show: false, type: 'MMS' as ProtocolType, layer: 'L3' as ProtocolConfig['layer'], nodeId: '', appId: 0x1001, localPort: 102 });
function openProtoAdd(layer: ProtocolConfig['layer']) {
  protoDlg.layer = layer;
  protoDlg.type = layer === 'L2' ? 'GOOSE' : 'MMS';
  protoDlg.show = true;
}
function confirmProto() {
  if (!store.nodeMap.has(protoDlg.nodeId)) return ElMessage.warning('请选择有效节点');
  const p: ProtocolConfig = { id: store.nextId('p'), type: protoDlg.type, layer: protoDlg.layer, nodeId: protoDlg.nodeId };
  if (protoDlg.layer === 'L2') p.appId = protoDlg.appId;
  if (protoDlg.layer === 'L3') p.localPort = protoDlg.localPort;
  store.addProtocol(p);
  protoDlg.show = false;
}

// ---------- 业务流 ----------
const flowDlg = reactive({ show: false, type: 'PERIODIC' as FlowType, src: '', dst: '', interval: 1, payloadSize: 512, transport: 'AUTO' as 'AUTO' | 'UDP' | 'TCP' });
function openFlowAdd() {
  flowDlg.type = 'PERIODIC';
  flowDlg.show = true;
}
function confirmFlow() {
  if (!store.nodeMap.has(flowDlg.src) || !store.nodeMap.has(flowDlg.dst)) return ElMessage.warning('请选择有效两端节点');
  const f: FlowConfig = { id: store.nextId('f'), type: flowDlg.type, src: flowDlg.src, dst: flowDlg.dst, interval: flowDlg.interval, payloadSize: flowDlg.payloadSize };
  if (flowDlg.transport === 'UDP' || flowDlg.transport === 'TCP') f.transport = flowDlg.transport;
  store.addFlow(f);
  flowDlg.show = false;
}

// ---------- 半实物 ----------
const newTap = reactive({ tapName: '', nodeId: '', mac: '' });
function addTap() {
  if (!store.project.halfPhysical) {
    store.project.halfPhysical = { taps: [], physicalNic: '' };
  }
  if (!newTap.tapName.trim() || !newTap.nodeId.trim()) return ElMessage.warning('请填写 tap 名与映射节点');
  if (!store.nodeMap.has(newTap.nodeId)) return ElMessage.warning('映射节点不存在');
  store.project.halfPhysical.taps.push({ ...newTap });
  newTap.tapName = ''; newTap.nodeId = ''; newTap.mac = '';
}
function removeTap(i: number) {
  store.project.halfPhysical!.taps.splice(i, 1);
}

// ---------- 仿真服务器状态（SSH） ----------
const SRV_HISTORY_KEY = 'epcomhil_srv_history';
const SRV_DEFAULT_PASS = 'ASDqwe123!@#';

type SrvHistoryItem = { host: string; port: number; username: string; password: string };

// 从 localStorage 读历史记录（含密码，本地明文存储；生产环境建议用安全存储）
function loadHistory(): SrvHistoryItem[] {
  try {
    const raw = localStorage.getItem(SRV_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x: any) => x && x.host) : [];
  } catch {
    return [];
  }
}
function saveHistory(list: SrvHistoryItem[]) {
  try { localStorage.setItem(SRV_HISTORY_KEY, JSON.stringify(list.slice(0, 10))); } catch { /* ignore */ }
}
// 把一条记录加到历史（同 host 覆盖，最新的排最前，最多 10 条）
function upsertHistory(item: SrvHistoryItem) {
  const list = loadHistory().filter((x) => x.host !== item.host);
  list.unshift(item);
  saveHistory(list);
  return list;
}

const srvHistory = ref<SrvHistoryItem[]>(loadHistory());

// 下拉选项的 label：显示 host + username
const srvHostOptions = computed(() =>
  srvHistory.value.map((h) => ({
    value: h.host,
    label: `${h.host}  (${h.username})`,
    item: h,
  })),
);

const srv = reactive<{
  visible: boolean;
  loading: boolean;
  error: string;
  data: ServerStatus | null;
  target: { host: string; port: number; username: string } | null;
  // 连接参数编辑（展开后用户可改）
  editing: boolean;
  form: { host: string; port: number; username: string; password: string };
  saving: boolean;
}>({
  visible: false,
  loading: false,
  error: '',
  data: null,
  target: null,
  editing: false,
  // 默认值：有历史就用第一条，没有就用默认值
  form: (() => {
    const h = loadHistory();
    if (h.length > 0) return { ...h[0] };
    return { host: '172.24.4.10', port: 22, username: 'root', password: SRV_DEFAULT_PASS };
  })(),
  saving: false,
});

// 选了历史 IP 后，自动带出端口、用户名、密码
function onHostSelect(val: string) {
  const found = srvHistory.value.find((h) => h.host === val);
  if (found) {
    srv.form.port = found.port;
    srv.form.username = found.username;
    srv.form.password = found.password;
  }
}
function removeHistory(host: string) {
  const list = loadHistory().filter((x) => x.host !== host);
  saveHistory(list);
  srvHistory.value = list;
}

async function loadServerStatus() {
  srv.loading = true;
  srv.error = '';
  try {
    const t = await window.epcomhil?.getServerStatusTarget?.();
    if (t) {
      srv.target = t;
      // 把当前目标同步到表单（密码不回传，留空让用户按需填）
      srv.form.host = t.host;
      srv.form.port = t.port;
      srv.form.username = t.username;
    }
    let s: ServerStatus | null | undefined = await window.epcomhil?.getServerStatus?.();

    // IPC 不可用时的 dev 回退：走 vite dev server 的 HTTP 代理
    if (!s && !window.epcomhil?.getServerStatus) {
      try {
        const resp = await fetch('/__epcomhil_server_status', { cache: 'no-store' });
        if (resp.ok) {
          s = (await resp.json()) as ServerStatus;
        } else {
          srv.error = `HTTP 回退失败（${resp.status}）`;
        }
      } catch (fe) {
        srv.error = `IPC 不可用且 HTTP 回退也失败：${String((fe as Error)?.message || fe)}`;
      }
    }

    if (s) {
      srv.data = s;
      if (!s.ok && !srv.error) srv.error = s.error || '采集失败';
    } else if (!srv.error) {
      srv.error = window.epcomhil?.getServerStatus
        ? '主进程未返回服务器状态'
        : '当前不在 Electron 环境，且 dev 回退接口不可用。请用 npm run dev 以 Electron 窗口启动。';
    }
  } catch (e) {
    srv.error = String((e as Error)?.message || e);
  } finally {
    srv.loading = false;
  }
}

async function saveAndConnect() {
  if (!srv.form.host.trim()) return ElMessage.warning('请填写服务器地址');
  if (!srv.form.username.trim()) return ElMessage.warning('请填写用户名');
  srv.saving = true;
  srv.error = '';
  try {
    const patch = {
      host: srv.form.host.trim(),
      port: Number(srv.form.port) || 22,
      username: srv.form.username.trim(),
      password: srv.form.password,
    };
    let ok = false;
    if (window.epcomhil?.setServerConfig) {
      const r = await window.epcomhil.setServerConfig(patch);
      ok = Boolean(r?.ok);
      if (r?.config) srv.target = r.config;
    } else {
      // dev HTTP 回退：POST 到 vite 代理接口设置参数
      const resp = await fetch('/__epcomhil_server_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const r = await resp.json();
      ok = Boolean(r?.ok);
      if (r?.config) srv.target = r.config;
    }
    if (!ok) {
      srv.error = '保存连接参数失败';
      return;
    }
    // 保存成功 → 写入历史记录（同 host 覆盖，最新放最前）
    const record: SrvHistoryItem = {
      host: srv.form.host.trim(),
      port: Number(srv.form.port) || 22,
      username: srv.form.username.trim(),
      password: srv.form.password,
    };
    srvHistory.value = upsertHistory(record);
    ElMessage.success('连接参数已更新');
    srv.editing = false;
    // 保存完立即用新参数拉一次状态
    await loadServerStatus();
  } catch (e) {
    srv.error = String((e as Error)?.message || e);
  } finally {
    srv.saving = false;
  }
}

function openServerStatus() {
  // 打开时先把本地表单里的参数推到后端（避免后端还停留在环境变量默认值、密码不对）
  syncConfigToBackend().finally(() => {
    loadServerStatus();
  });
}

// 把当前表单参数同步到后端（IPC 或 HTTP 回退），不弹提示，失败静默
async function syncConfigToBackend() {
  try {
    const patch = {
      host: srv.form.host.trim(),
      port: Number(srv.form.port) || 22,
      username: srv.form.username.trim(),
      password: srv.form.password,
    };
    if (window.epcomhil?.setServerConfig) {
      const r = await window.epcomhil.setServerConfig(patch);
      if (r?.config) srv.target = r.config;
    } else {
      await fetch('/__epcomhil_server_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    }
  } catch {
    /* 静默失败，后面 loadServerStatus 会报具体错 */
  }
}
function closeServerStatus() {
  // 关掉弹层就清掉加载状态
  srv.loading = false;
}
// 用 watch 跟踪可见性，不依赖 el-popover 的 @show/@hide（更稳）
watch(
  () => srv.visible,
  (v) => (v ? openServerStatus() : closeServerStatus()),
);
onUnmounted(() => {
  if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
});

// ---------- 齿轮图标旁的状态指示灯：后台静默轮询，不显示 loading ----------
// 页面加载后开始每 15 秒拉一次，只更新状态点颜色，不干扰用户操作
let bgTimer: number | null = null;
const bgStatus = ref<'good' | 'bad' | 'warn' | 'unknown'>('unknown');

async function bgTick() {
  try {
    let s: ServerStatus | null | undefined = null;
    if (window.epcomhil?.getServerStatus) {
      s = await window.epcomhil.getServerStatus();
    } else {
      try {
        const resp = await fetch('/__epcomhil_server_status', { cache: 'no-store' });
        if (resp.ok) s = (await resp.json()) as ServerStatus;
      } catch { /* ignore */ }
    }
    if (s?.ok) {
      bgStatus.value = s.connState === 'busy' ? 'warn' : 'good';
      // 后台拉到的新数据也同步到主数据，用户点开卡片就是最新的
      if (!srv.visible || !srv.loading) srv.data = s;
    } else {
      bgStatus.value = 'bad';
    }
  } catch {
    bgStatus.value = 'bad';
  }
}
// 页面挂载后启动：先拉一次，再 15 秒轮询
function startBgPolling() {
  if (bgTimer) return;
  bgTick();
  bgTimer = window.setInterval(bgTick, 15000);
}
startBgPolling();

function fmtHz(mh: number | undefined | null): string {
  if (mh == null) return '-';
  return mh >= 1000 ? `${(mh / 1000).toFixed(2)} GHz` : `${mh.toFixed(1)} MHz`;
}
function fmtMem(mb: number | undefined | null): string {
  if (mb == null) return '-';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

// 连接与资源派生状态
const connCls = computed(() => {
  if (srv.loading) return 'warn';
  if (srv.error && !srv.data?.ok) return 'bad';
  return srv.data?.connState === 'busy' ? 'warn' : 'good';
});
const connText = computed(() => {
  if (srv.loading) return '连接中';
  if (srv.error && !srv.data?.ok) return '离线';
  return '在线';
});
const memPct = computed(() => srv.data?.mem?.usedPct ?? 0);
const loadText = computed(() => (srv.data?.load ? srv.data.load.map((n) => Number(n).toFixed(2)).join(' / ') : '-'));
</script>

<template>
  <div class="config-page panel">
    <!-- 右上角齿轮：仿真服务器状态入口 -->
    <el-popover v-model:visible="srv.visible" trigger="click" placement="bottom-end" :width="400" popper-class="srv-popover" @show="openServerStatus" @hide="closeServerStatus">
      <template #reference>
        <span class="srv-trigger" title="仿真服务器状态">
          <el-icon :size="20"><Setting /></el-icon>
          <span :class="['srv-badge', bgStatus]" :title="bgStatus === 'good' ? '在线' : bgStatus === 'bad' ? '离线' : bgStatus === 'warn' ? '繁忙' : '检测中'"></span>
        </span>
      </template>

      <div class="srv-card">
        <div class="srv-head">
          <span class="srv-title">仿真服务器状态</span>
          <span :class="['srv-dot', connCls]"></span>
          <span class="srv-conn">
            {{ connText }}
            <template v-if="srv.target">· {{ srv.target.username }}@{{ srv.target.host }}:{{ srv.target.port }}</template>
          </span>
          <el-button link size="small" class="srv-edit-btn" @click="srv.editing = !srv.editing">
            {{ srv.editing ? '收起' : '连接设置' }}
          </el-button>
        </div>

        <!-- 连接设置展开区 -->
        <div v-if="srv.editing" class="srv-edit">
          <div class="srv-edit-row">
            <label>服务器地址</label>
            <el-select
              v-model="srv.form.host"
              size="small"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入 IP"
              style="width: 100%"
              @change="onHostSelect"
            >
              <el-option
                v-for="opt in srvHostOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              >
                <div class="srv-host-opt">
                  <span>{{ opt.label }}</span>
                  <el-button
                    link
                    type="danger"
                    size="small"
                    @click.stop="removeHistory(opt.value)"
                  >删除</el-button>
                </div>
              </el-option>
            </el-select>
          </div>
          <div class="srv-edit-row">
            <label>端口</label>
            <el-input-number v-model="srv.form.port" :min="1" :max="65535" size="small" controls-position="right" style="width: 100%" />
          </div>
          <div class="srv-edit-row">
            <label>用户名</label>
            <el-input v-model="srv.form.username" size="small" placeholder="如 root" />
          </div>
          <div class="srv-edit-row">
            <label>密码</label>
            <el-input v-model="srv.form.password" size="small" type="password" show-password placeholder="SSH 登录密码" />
          </div>
          <el-button type="primary" size="small" :loading="srv.saving" @click="saveAndConnect" style="width: 100%; margin-top: 4px">
            保存并连接
          </el-button>
        </div>

        <div v-if="srv.loading" class="srv-loading"><el-icon class="is-loading"><Refresh /></el-icon> 正在读取…</div>

        <div v-else-if="srv.error && !srv.data?.ok" class="srv-error">
          <div class="srv-line"><span class="k">连接</span><b class="v bad">离线</b></div>
          <div class="srv-line"><span class="k">目标</span><span class="v">{{ srv.target ? `${srv.target.username}@${srv.target.host}:${srv.target.port}` : '-' }}</span></div>
          <div class="srv-line"><span class="k">原因</span><span class="v err">{{ srv.error }}</span></div>
          <div class="srv-tip">请确认已用网线连接 Linux 仿真机、SSH 服务已启动，或通过环境变量 EPCOMHIL_SRV_HOST/USER/PASS 指定目标。</div>
        </div>

        <template v-else-if="srv.data">
          <div class="srv-sec">CPU</div>
          <div class="srv-line"><span class="k">核心数</span><span class="v">{{ srv.data.cores }} 核</span></div>
          <div class="srv-line"><span class="k">型号</span><span class="v">{{ srv.data.cpuModel }}</span></div>
          <div class="srv-line"><span class="k">主频</span><span class="v mono">{{ fmtHz(srv.data.mhz?.avg) }}<span v-if="srv.data.mhz" class="dim">（{{ fmtHz(srv.data.mhz.min) }} ~ {{ fmtHz(srv.data.mhz.max) }}）</span></span></div>

          <div class="srv-sec">内存</div>
          <div class="srv-mem-bar"><i :style="{ width: memPct + '%' }" :class="{ over: memPct > 90 }"></i></div>
          <div class="srv-line"><span class="k">已用</span><span class="v mono">{{ fmtMem(srv.data.mem?.usedMB) }} / {{ fmtMem(srv.data.mem?.totalMB) }}（可用 {{ fmtMem(srv.data.mem?.availMB) }}，{{ memPct }}%）</span></div>

          <div class="srv-sec">负载 / 运行</div>
          <div class="srv-line"><span class="k">负载均值</span><span class="v mono">{{ loadText }}</span></div>
          <div class="srv-line"><span class="k">运行仿真</span><b :class="['v', srv.data.simRunning ? 'good' : 'dim']">{{ srv.data.simRunning ? '运行中' : '未运行' }}</b></div>
          <div v-if="srv.data.simProcs && srv.data.simProcs.length" class="srv-procs">
            <div v-for="(p, i) in srv.data.simProcs" :key="i" class="srv-proc">{{ p }}</div>
          </div>
        </template>

        <div class="srv-foot">
          <span class="srv-time">更新于 {{ srv.data?.fetchedAt ? new Date(srv.data.fetchedAt).toLocaleTimeString() : '-' }}</span>
          <el-button size="small" :loading="srv.loading" @click="loadServerStatus">刷新</el-button>
        </div>
      </div>
    </el-popover>

    <el-tabs v-model="activeTab">
      <!-- 节点 -->
      <el-tab-pane name="node">
        <template #label><span class="tab-label">节点</span></template>
        <div class="pane">
          <div class="pane-head">
            <span>电力终端与通信设备（{{ store.project.nodes.length }}）</span>
            <el-button size="small" type="primary" @click="openNodeAdd">新增节点</el-button>
          </div>
          <el-table :data="store.project.nodes" height="420" size="small">
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column prop="name" label="名称" />
            <el-table-column label="类型" width="130">
              <template #default="{ row }">{{ KIND_LABEL[row.kind as NodeKind] ?? row.kind }}</template>
            </el-table-column>
            <el-table-column label="实物" width="70">
              <template #default="{ row }"><el-tag :type="row.physical ? 'success' : 'info'" size="small">{{ row.physical ? '实物' : '虚拟' }}</el-tag></template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button link type="danger" @click="store.removeNode(row.id)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- 协议 -->
      <el-tab-pane name="proto">
        <template #label><span class="tab-label">协议</span></template>
        <div class="pane">
          <div class="pane-head">
            <span>协议装载 · L3(MMS/Modbus走Socket) 与 L2(GOOSE二层帧) 分离（{{ store.project.protocols.length }}）</span>
            <div>
              <el-button size="small" @click="openProtoAdd('L2')">+ L2 GOOSE</el-button>
              <el-button size="small" type="primary" @click="openProtoAdd('L3')">+ L3 协议</el-button>
            </div>
          </div>
          <el-table :data="store.project.protocols" height="420" size="small">
            <el-table-column prop="id" label="ID" width="90" />
            <el-table-column prop="type" label="协议" width="120" />
            <el-table-column prop="layer" label="承载层" width="80">
              <template #default="{ row }"><el-tag size="small">{{ row.layer }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="nodeId" label="归属节点" />
            <el-table-column label="参数">
              <template #default="{ row }">{{ row.layer === 'L2' ? `appId=0x${(row.appId ?? 0).toString(16)}` : `port=${row.localPort ?? '-'}` }}</template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ row }"><el-button link type="danger" @click="store.removeProtocol(row.id)">删除</el-button></template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- 业务流 -->
      <el-tab-pane name="flow">
        <template #label><span class="tab-label">业务流</span></template>
        <div class="pane">
          <div class="pane-head">
            <span>电力业务流：周期遥测/偶发遥信/控制下发（{{ store.project.flows.length }}）</span>
            <el-button size="small" type="primary" @click="openFlowAdd">新增业务流</el-button>
          </div>
          <el-table :data="store.project.flows" height="420" size="small">
            <el-table-column prop="id" label="ID" width="90" />
            <el-table-column prop="type" label="类型" width="110" />
            <el-table-column prop="src" label="源" />
            <el-table-column prop="dst" label="目的" />
            <el-table-column label="载荷/间隔">
              <template #default="{ row }">{{ row.payloadSize ?? '-' }}B / {{ row.interval ?? '-' }}s</template>
            </el-table-column>
            <el-table-column label="承载" width="70">
              <template #default="{ row }">
                <el-tag size="small" :type="row.transport === 'TCP' ? 'primary' : 'info'" effect="plain">
                  {{ row.transport ?? '自动' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ row }"><el-button link type="danger" @click="store.removeFlow(row.id)">删除</el-button></template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- 半实物 -->
      <el-tab-pane name="half">
        <template #label><span class="tab-label">半实物</span></template>
        <div class="pane">
          <div class="block-title">虚拟网卡 → 模型内节点 一一映射（Linux 单一物理网口汇聚）</div>
          <div class="half-box">
            <el-input v-model="store.project.halfPhysical!.physicalNic" placeholder="Linux 物理网口，如 eth0" style="width: 220px" />
            <span class="muted">单网口汇聚</span>
          </div>
          <div class="half-add">
            <el-input v-model="newTap.tapName" placeholder="tap 名" style="width: 130px" />
            <el-input v-model="newTap.nodeId" placeholder="模型内节点 id" style="width: 140px" />
            <el-input v-model="newTap.mac" placeholder="MAC" style="width: 160px" />
            <el-button type="primary" size="small" @click="addTap">添加映射</el-button>
          </div>
          <el-table :data="store.project.halfPhysical?.taps ?? []" height="300" size="small">
            <el-table-column prop="tapName" label="tap 虚拟网卡" width="160" />
            <el-table-column prop="nodeId" label="模型内节点" />
            <el-table-column prop="mac" label="真实 MAC" />
            <el-table-column label="操作" width="80">
              <template #default="{ $index }"><el-button link type="danger" @click="removeTap($index)">删除</el-button></template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 节点新增对话框 -->
    <el-dialog v-model="nodeDlg.show" title="新增节点" width="400px">
      <el-form label-width="76px" label-position="left">
        <el-form-item label="类型">
          <el-select v-model="nodeDlg.kind" style="width: 100%" @change="onNodeKindChange">
            <el-option v-for="k in KIND_ORDER" :key="k" :label="KIND_LABEL[k]" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="nodeDlg.name" placeholder="默认按「类型_序号」自动填，可改" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="nodeDlg.show = false">取消</el-button>
        <el-button type="primary" @click="confirmNode">确定</el-button>
      </template>
    </el-dialog>

    <!-- 协议新增对话框 -->
    <el-dialog v-model="protoDlg.show" :title="`新增${protoDlg.layer === 'L2' ? ' L2 GOOSE' : ' L3 协议'}`" width="440px">
      <el-form label-width="90px" label-position="left">
        <el-form-item label="承载层">
          <el-tag>{{ protoDlg.layer }}</el-tag>
          <span class="muted">{{ protoDlg.layer === 'L2' ? '二层以太网帧 (EtherType 0x88B8)' : 'IP Socket (TCP/UDP)' }}</span>
        </el-form-item>
        <el-form-item label="协议类型">
          <el-select v-model="protoDlg.type" style="width: 100%" :disabled="protoDlg.layer === 'L2'">
            <el-option v-for="p in PROTO_LIST" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="归属节点">
          <el-select v-model="protoDlg.nodeId" filterable style="width: 100%">
            <el-option v-for="n in store.project.nodes" :key="n.id" :label="`${n.id} (${n.name})`" :value="n.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="protoDlg.layer === 'L2'" label="appId">
          <el-input-number v-model="protoDlg.appId" :min="0" :step="16" />
        </el-form-item>
        <el-form-item v-else label="本地端口">
          <el-input-number v-model="protoDlg.localPort" :min="1" :max="65535" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="protoDlg.show = false">取消</el-button>
        <el-button type="primary" @click="confirmProto">确定</el-button>
      </template>
    </el-dialog>

    <!-- 业务流新增对话框 -->
    <el-dialog v-model="flowDlg.show" title="新增业务流" width="440px">
      <el-form label-width="90px" label-position="left">
        <el-form-item label="类型">
          <el-select v-model="flowDlg.type" style="width: 100%">
            <el-option v-for="f in FLOW_LIST" :key="f" :label="f" :value="f" />
          </el-select>
        </el-form-item>
        <el-form-item label="源节点">
          <el-select v-model="flowDlg.src" filterable style="width: 100%">
            <el-option v-for="n in store.project.nodes" :key="n.id" :label="n.id" :value="n.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="目的节点">
          <el-select v-model="flowDlg.dst" filterable style="width: 100%">
            <el-option v-for="n in store.project.nodes" :key="n.id" :label="n.id" :value="n.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="载荷(B)">
          <el-input-number v-model="flowDlg.payloadSize" :min="1" />
        </el-form-item>
        <el-form-item label="间隔(s)">
          <el-input-number v-model="flowDlg.interval" :min="0.001" :step="0.5" />
        </el-form-item>
        <el-form-item label="承载">
          <el-select v-model="flowDlg.transport" style="width: 220px">
            <el-option value="AUTO">自动（跟随目标 Server 承载，其默认按协议推断）</el-option>
            <el-option value="UDP">UDP</el-option>
            <el-option value="TCP">TCP</el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="flowDlg.show = false">取消</el-button>
        <el-button type="primary" @click="confirmFlow">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.config-page {
  position: relative;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  padding: 6px 14px 14px;
  min-height: 100%;
}
/* 右上角齿轮入口 */
.srv-trigger {
  position: absolute;
  top: 10px;
  right: 16px;
  z-index: 12;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  color: var(--ech-fg-dim);
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
  transition: all 0.18s ease;
}
.srv-trigger:hover {
  color: var(--ech-accent);
  border-color: rgba(46, 163, 255, 0.5);
  box-shadow: 0 0 0 1px rgba(46, 163, 255, 0.2);
}
/* 齿轮右上角的状态指示灯 */
.srv-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--ech-bg-panel, #1b2027);
  box-sizing: content-box;
  transition: all 0.25s ease;
}
.srv-badge.good   { background: #2ecc71; box-shadow: 0 0 6px #2ecc71; }
.srv-badge.bad    { background: #e74c3c; box-shadow: 0 0 6px #e74c3c; }
.srv-badge.warn   { background: #f39c12; box-shadow: 0 0 6px #f39c12; }
.srv-badge.unknown{ background: #55606c; box-shadow: none; }
</style>
<style>
/* 状态卡片（scoped 之外的弹层样式：el-popover 挂载到 body，需全局） */
.srv-popover.el-popover {
  background: #1b2027;
  border: 1px solid var(--ech-border, #2a3039);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  color: #c9d1dc;
}
.srv-card {
  font-size: 13px;
  line-height: 1.6;
}
.srv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid #2a3039;
  margin-bottom: 10px;
}
.srv-title {
  font-weight: 700;
  color: #fff;
}
.srv-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
}
.srv-dot.good { background: #2ecc71; box-shadow: 0 0 6px #2ecc71; }
.srv-dot.warn { background: #f39c12; box-shadow: 0 0 6px #f39c12; }
.srv-dot.bad  { background: #e74c3c; box-shadow: 0 0 6px #e74c3c; }
.srv-dot.dim  { background: #55606c; }
.srv-conn {
  color: #9aa4b0;
  font-size: 12px;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srv-loading {
  color: #9aa4b0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
}
.srv-sec {
  font-size: 12px;
  font-weight: 600;
  color: var(--ech-accent, #2ea3ff);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 10px 0 4px;
  border-left: 3px solid var(--ech-accent, #2ea3ff);
  padding-left: 6px;
}
.srv-line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 3px 0;
}
.srv-line .k { color: #8b95a1; flex: none; }
.srv-line .v { color: #e3e9f0; text-align: right; word-break: break-all; }
.srv-line .v.mono { font-family: Consolas, 'Courier New', monospace; }
.srv-line .v.good { color: #2ecc71; }
.srv-line .v.bad, .srv-line .v.err { color: #e74c3c; }
.srv-line .v.dim { color: #8b95a1; }
.dim { color: #8b95a1; font-weight: 400; }
.srv-mem-bar {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: #232a33;
  overflow: hidden;
  margin: 4px 0 6px;
}
.srv-mem-bar i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #2ea3ff, #00d4ff);
  transition: width 0.4s ease;
}
.srv-mem-bar i.over { background: linear-gradient(90deg, #f39c12, #e74c3c); }
.srv-procs {
  margin-top: 6px;
  background: #161a20;
  border: 1px solid #252c35;
  border-radius: 6px;
  padding: 6px 8px;
  max-height: 92px;
  overflow: auto;
}
.srv-proc {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 11px;
  color: #9fb6cc;
  line-height: 1.5;
  white-space: nowrap;
}
.srv-error .srv-line .k { color: #8b95a1; }
.srv-tip {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(231, 76, 60, 0.08);
  border: 1px solid rgba(231, 76, 60, 0.3);
  border-radius: 6px;
  color: #e8a9a3;
  font-size: 12px;
  line-height: 1.6;
}
.srv-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #2a3039;
}
.srv-time { color: #8b95a1; font-size: 12px; }
/* 连接设置展开按钮 */
.srv-edit-btn {
  margin-left: auto;
  padding: 0 4px !important;
  font-size: 12px;
}
/* 连接设置表单 */
.srv-edit {
  padding: 10px 0;
  border-bottom: 1px solid #2a3039;
  margin-bottom: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.srv-edit-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.srv-edit-row label {
  flex: none;
  width: 70px;
  color: #8b95a1;
  font-size: 12px;
  text-align: right;
}
.srv-edit-row .el-input,
.srv-edit-row .el-input-number,
.srv-edit-row .el-select {
  flex: 1;
}
/* 历史 IP 下拉选项：左文右删 */
.srv-host-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-size: 13px;
}
.srv-host-opt .el-button {
  opacity: 0;
  transition: opacity 0.15s;
}
.srv-host-opt:hover .el-button {
  opacity: 1;
}
</style>
<style scoped>
.tab-label {
  font-weight: 600;
}
/* 配置页顶部标签：未激活保持纯净清晰白色，激活项由 Element Plus 保持蓝色原样 */
.config-page :deep(.el-tabs__item:not(.is-active) .tab-label),
.config-page :deep(.el-tabs__item:not(.is-active)) {
  color: #ffffff;
}
.pane {
  padding-top: 6px;
}
.tab-pane-label {
  display: flex;
  align-items: center;
}
.pane-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--ech-fg-dim);
  font-size: 13px;
  margin-bottom: 10px;
}
.block-title {
  font-size: 13px;
  font-weight: 600;
  color: #eef2f6;
  margin-bottom: 10px;
}
.half-box {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.half-add {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  align-items: center;
}
.muted {
  color: var(--ech-fg-dim);
  font-size: 12px;
  line-height: 1.5;
}
</style>