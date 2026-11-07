<script setup lang="ts">
// 多工程标签栏（通用）：每个打开的工程一条标签，默认「Untitled」。点击切换，× 关闭，＋ 新建。
// 样式：深色 IDE 标签条，活动标签为纯色实心高亮块（对齐参考图 1）。
import { onMounted, onBeforeUnmount } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useWorkbench } from '@/stores/workbench';

const store = useWorkbench();

/** 标签展示名是否未保存（活动标签看镜像 dirty，非活动标签看会话自身的 dirty） */
function tabDirty(id: string): boolean {
  return id === store.activeId ? store.dirty : Boolean(store.sessions.find((s) => s.id === id)?.dirty);
}

function onSelect(id: string) {
  store.switchSession(id);
}

async function onClose(id: string) {
  if (tabDirty(id)) {
    const ok = await ElMessageBox.confirm('该工程有未保存的更改，关闭将丢失这些更改。继续关闭？', '关闭工程', {
      type: 'warning',
      confirmButtonText: '关闭',
      cancelButtonText: '取消',
    })
      .then(() => true)
      .catch(() => false);
    if (!ok) return;
  }
  store.closeSession(id);
}

function onNew() {
  store.openNewUntitled();
}

function onDocKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'w') return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  void onClose(store.activeId);
}

onMounted(() => document.addEventListener('keydown', onDocKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onDocKey));
</script>

<template>
  <div class="proj-tabs">
    <div
      v-for="s in store.sessions"
      :key="s.id"
      class="pt-tab"
      :class="{ active: s.id === store.activeId }"
      :title="s.title"
      @click="onSelect(s.id)"
    >
      <svg class="pt-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M2 5.5C2 4.7 2.7 4 3.5 4h4l1.4 1.8H16.5c.8 0 1.5.7 1.5 1.5v7.2c0 .8-.7 1.5-1.5 1.5h-13C2.7 16 2 15.3 2 14.5z"
          stroke="currentColor"
          stroke-width="1.5"
        />
      </svg>
      <span class="pt-title">{{ s.title }}</span>
      <span v-if="tabDirty(s.id)" class="pt-dot" title="有未保存的更改"></span>
      <button class="pt-close" title="关闭 (Ctrl+W)" @click.stop="onClose(s.id)">×</button>
    </div>
    <button class="pt-new" title="新建工程 (Ctrl+N)" @click="onNew">
      <svg class="pt-plus" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.proj-tabs {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 8px;
  background: #1f232a;
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  flex-shrink: 0;
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 34px;
}
.pt-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 5px 2px 7px;
  color: var(--ech-fg-dim);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  max-width: 118px;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: all 0.16s;
  user-select: none;
}
.pt-tab:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--ech-fg);
}
/* 活动标签：纯色实心高亮块（对齐参考图 1 的活动态） */
.pt-tab.active {
  color: #fff;
  font-weight: 600;
  background: linear-gradient(135deg, var(--ech-accent), #1258b0);
  border-color: rgba(46, 163, 255, 0.4);
  box-shadow: 0 0 12px var(--ech-glow);
}
.pt-ico {
  width: 13px;
  height: 13px;
  flex: none;
}
.pt-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 未保存圆点：琥珀色，在实心蓝底上仍清晰 */
.pt-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ffd76a;
  box-shadow: 0 0 6px rgba(255, 215, 106, 0.8);
  flex: none;
}
.pt-close {
  width: 14px;
  height: 14px;
  margin-left: -4px;
  display: grid;
  place-items: center;
  line-height: 1;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.75;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  flex: none;
}
.pt-close:hover {
  background: rgba(0, 0, 0, 0.2);
  opacity: 1;
  color: #fff;
}
.pt-new {
  flex: none;
  width: 24px;
  height: 24px;
  margin: 0 4px 0 2px;
  align-self: center;
  display: grid;
  place-items: center;
  border: 1px dashed var(--ech-border);
  border-radius: 6px;
  background: transparent;
  color: var(--ech-fg-dim);
  cursor: pointer;
  padding: 0;
}
.pt-plus {
  width: 14px;
  height: 14px;
  display: block;
}
.pt-new:hover {
  color: var(--ech-accent-strong);
  border-color: var(--ech-accent);
}
</style>