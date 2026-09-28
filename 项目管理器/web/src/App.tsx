import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// 文件查看器带 CodeMirror（约 900KB），按需加载
const FileViewer = lazy(() => import('./components/FileViewer.tsx'));
import {
  api,
  type AssetDetail,
  type AssetListItem,
  type ImportState,
  type Ping,
  type ProjectRow,
  type ScanState,
  type Stats,
  type TrashProjectRow,
} from './api.ts';
import Sidebar, { type SideView } from './components/Sidebar.tsx';
import Header, { type ViewMode } from './components/Header.tsx';
import ModalityFilter from './components/ModalityFilter.tsx';
import VirtualGrid from './components/VirtualGrid.tsx';
import ContentCard from './components/ContentCard.tsx';
import ContentList from './components/ContentList.tsx';
import Inspector from './components/Inspector.tsx';
import FocusOverlay from './components/FocusOverlay.tsx';
import ProjectDialog from './components/ProjectDialog.tsx';
import AddContentDialog from './components/AddContentDialog.tsx';
import LibraryDialog from './components/LibraryDialog.tsx';
import ConfirmDialog from './components/ConfirmDialog.tsx';
import { subtreeIds } from './projects.ts';
import { projectDotClass, type Modality } from './modality.tsx';

const EMPTY_SCAN: ScanState = {
  running: false, phase: 'idle', processed: 0, total: 0, current: '',
  startedAt: null, finishedAt: null, error: null, last: null,
};

const EMPTY_IMPORT: ImportState = {
  running: false, processed: 0, total: 0, current: '',
  startedAt: null, finishedAt: null, error: null, last: null,
};

function useDebounced<T>(value: T, delay = 220): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function humanBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 面板开合状态记在浏览器里，下次打开保持你习惯的布局 */
const PANEL_KEY = 'pm-panels';
interface PanelState { sidebar: boolean; inspector: boolean }

/** 七类模态都有专注模式主体了 */
const FOCUSABLE: ReadonlySet<Modality> = new Set<Modality>([
  'image', 'video', 'text', 'code', 'mixed',
]);

function loadPanels(): PanelState {
  const fallback: PanelState = { sidebar: true, inspector: true };
  try {
    const raw = window.localStorage.getItem(PANEL_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return { sidebar: parsed.sidebar !== false, inspector: parsed.inspector !== false };
  } catch {
    return fallback;
  }
}

function savePanels(state: PanelState): void {
  try {
    window.localStorage.setItem(PANEL_KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式下写不进去也不该影响使用 */
  }
}

export default function App() {
  const [view, setView] = useState<SideView>('all');
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [modality, setModality] = useState<Modality | null>(null);
  /** 来源筛选：ai = AI 生成，real = 非 AI，other = 其他，unset = 未标注 */
  const [originFilter, setOriginFilter] = useState<'ai' | 'real' | 'other' | 'unset' | null>(null);
  /** 只看某件提示词生成的素材（从素材详情的"只看这 N 件"进来） */
  const [promptFilter, setPromptFilter] = useState<number | null>(null);
  /** 按生成模型筛选（候选来自当前列表里出现过的模型） */
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query);

  const [items, setItems] = useState<AssetListItem[]>([]);
  /** 回收站里"可以整项目恢复"的项目（删项目时记下来的） */
  const [trashProjects, setTrashProjects] = useState<TrashProjectRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [ping, setPing] = useState<Ping | null>(null);
  const [scan, setScan] = useState<ScanState>(EMPTY_SCAN);
  const [importState, setImportState] = useState<ImportState>(EMPTY_IMPORT);
  const [selected, setSelected] = useState<AssetListItem | null>(null);
  /** 专注模式：打开的是哪件素材（所有模态共用一个入口） */
  const [focusId, setFocusId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  /** 新建项目时预设的上级项目（从侧栏某个项目的 + 进来） */
  const [projectParent, setProjectParent] = useState<number | null>(null);
  /** 等待确认删除的项目 */
  const [pendingDelete, setPendingDelete] = useState<ProjectRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 批量动作进行中（回收站多选恢复等），用来禁用按钮防重复触发 */
  const [batchBusy, setBatchBusy] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [panels, setPanels] = useState<PanelState>(loadPanels);
  /** 卡片右下角那个删除按钮的"再点一次确认"状态 */
  const [cardArmed, setCardArmed] = useState<number | null>(null);
  /** 已经展开的组（bundle）：没在里面的组在画廊里只显示一张代表卡 */
  const [expandedBundles, setExpandedBundles] = useState<number[]>([]);
  /** 回收站里勾选的素材（批量恢复用）；切换视图或刷新后清空 */
  const [trashSelection, setTrashSelection] = useState<number[]>([]);
  /** 批量"彻底删除"的再点一次确认态 */
  const [batchPurgeArmed, setBatchPurgeArmed] = useState(false);
  /** 单件彻底删除的再点一次确认态 */
  const [purgeArmedId, setPurgeArmedId] = useState<number | null>(null);
  /** 正在查看/编辑的磁盘文件（文件浏览里点文件打开） */
  const [filePath, setFilePath] = useState<string | null>(null);

  const toggleSidebar = useCallback(() => {
    setPanels((prev) => {
      const next = { ...prev, sidebar: !prev.sidebar };
      savePanels(next);
      return next;
    });
  }, []);


  // Ctrl+B / Ctrl+I 开合面板；在输入框里打字时不要抢快捷键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const editing = target
        ? target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
        : false;
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'b') { event.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  /** Esc 取消选中 → 详情栏随之收起（面板显隐完全由"有没有选中素材"决定） */
  useEffect(() => {
    const onEsc = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      const editing = target ? target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable : false;
      if (editing) return;
      setSelected(null);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, []);

  const reload = useCallback(async () => {
    try {
      if (view === 'trash') {
        const [trash, s, p] = await Promise.all([api.trashList(), api.stats(), api.projects()]);
        setItems(trash.items);
        setTrashProjects(trash.projects ?? []);
        setStats(s);
        setProjects(p.items);
      } else {
        const [list, s, p] = await Promise.all([
          api.assets({
            q: debouncedQuery,
            project: selectedProject ?? undefined,
            limit: 1000,
          }),
          api.stats(),
          api.projects(),
        ]);
        setItems(list.items);
        setStats(s);
        setProjects(p.items);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [debouncedQuery, selectedProject, view]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    void api.ping().then(setPing).catch(() => undefined);
    void api.scanStatus().then(setScan).catch(() => undefined);
    void api.importStatus().then(setImportState).catch(() => undefined);
  }, []);

  // 成功的提示会自己消失；出错的提示留着，等用户看到或下一次成功再清
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 扫描 / 导入进度轮询
  useEffect(() => {
    if (!scan.running) return;
    const timer = window.setTimeout(() => {
      void api.scanStatus().then(setScan).catch((err: unknown) => setError((err as Error).message));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [scan]);

  useEffect(() => {
    if (!importState.running) return;
    const timer = window.setTimeout(() => {
      void api.importStatus().then(setImportState).catch((err: unknown) => setError((err as Error).message));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [importState]);

  // 作业结束后刷新
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = scan.running || importState.running;
    if (wasBusy.current && !busy) void reload();
    wasBusy.current = busy;
  }, [scan.running, importState.running, reload]);

  // 模态计数与筛选：与参考设计一致，在当前作用域内客户端计算，计数与展示必然一致
  const modalityCounts = useMemo(() => {
    const totals = new Map<Modality, number>();
    for (const item of items) totals.set(item.modality, (totals.get(item.modality) ?? 0) + 1);
    return [...totals.entries()].map(([m, count]) => ({ modality: m, count }));
  }, [items]);

  const filtered = useMemo(() => {
    let list = modality ? items.filter((item) => item.modality === modality) : items;
    if (modelFilter) list = list.filter((item) => (item.model ?? '') === modelFilter);
    if (promptFilter !== null) list = list.filter((item) => item.promptAssetId === promptFilter);
    if (originFilter) {
      list = list.filter((item) => (originFilter === 'unset' ? !item.origin : item.origin === originFilter));
    }
    // 回收站接口不带搜索词（它按删除时间给完整列表），所以搜索在客户端做，库内列表是双保险
    const keyword = query.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter(
      (item) => item.title.toLowerCase().includes(keyword)
        || item.sourcePath.toLowerCase().includes(keyword)
        || (item.prompt ?? '').toLowerCase().includes(keyword),
    );
  }, [items, modality, query, originFilter, promptFilter, modelFilter]);

  /** 回收站里这些素材占的体积，清空前让用户看清要删掉多少 */
  const trashBytes = useMemo(
    () => (view === 'trash' ? items.reduce((sum, item) => sum + (item.size ?? 0), 0) : 0),
    [items, view],
  );

  /**
   * 组（bundle）折叠：默认一个组只显示一张代表卡（封面优先），点开才铺开成员。
   * 用户反馈"综合里一次加的内容被分开放了"——它们本来是一组，所以这里默认收起来。
   */
  const visible = useMemo(() => {
    const out: AssetListItem[] = [];
    const at = new Map<number, number>();
    // 同一件素材只渲染一次：查询层已经 GROUP BY，这里再兜一层，
    // 免得任何一处列表来源（文件夹范围映射等）把同一件塞两次 ——
    // 两张一模一样的卡其实是同一份数据，改一张另一张跟着变（用户反馈的现象）。
    const seenIds = new Set<number>();
    for (const item of filtered) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      const bundleId = item.bundleId;
      if (bundleId === null || expandedBundles.includes(bundleId)) {
        out.push(item);
        continue;
      }
      const index = at.get(bundleId);
      if (index === undefined) {
        at.set(bundleId, out.length);
        out.push(item);
      } else if (item.bundleCover && !out[index].bundleCover) {
        // 封面那一张优先当代表（用户先看到的是他自己放第一位的）
        out[index] = item;
      }
    }
    return out;
  }, [filtered, expandedBundles]);

  const project = projects.find((entry) => entry.id === selectedProject) ?? null;

  const selectAll = (): void => {
    setView('all');
    setSelectedProject(null);
    setModality(null);
  };

  const selectProject = (id: number): void => {
    setView('all');
    setSelectedProject(id);
    setModality(null);
  };

  const selectTrash = (): void => {
    setView('trash');
    setSelectedProject(null);
    setModality(null);
    setSelected(null);
    setPurgeArmed(false);
  };

  /**
   * 批量恢复：逐件调用已有接口，把失败原因收集起来一起报——
   * 一件失败不该让其余的都不动，用户也需要知道到底哪几件没回来。
   */
  const restoreMany = async (ids: number[]): Promise<void> => {
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      let ok = 0;
      const failed: string[] = [];
      for (const id of ids) {
        try {
          await api.restore(id);
          ok += 1;
        } catch (err) {
          failed.push(`#${id} ${(err as Error).message}`);
        }
      }
      setTrashSelection([]);
      setSelected(null);
      setNotice(
        `已恢复 ${ok} 件`
        + (failed.length > 0 ? `，失败 ${failed.length} 件：${failed.slice(0, 3).join('；')}` : ''),
      );
      await reload();
    } finally {
      setBatchBusy(false);
    }
  };

  /** 批量彻底删除（不可恢复）：只删所选，磁盘上的原始文件不动 */
  const purgeMany = async (ids: number[]): Promise<void> => {
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      const report = await api.purgeTrash(ids);
      setTrashSelection([]);
      setSelected(null);
      setNotice(`已彻底删除 ${report.assets} 件（移除对象 ${report.removedObjects} 个，磁盘原文件保留 ${report.keptOriginalFiles} 个）`);
      await reload();
    } catch (err) {
      setError(`彻底删除失败：${(err as Error).message}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const restoreWholeProject = async (row: TrashProjectRow): Promise<void> => {
    try {
      const result = await api.restoreTrashProject(row.trashId);
      setNotice(`已恢复项目「${result.name}」：${result.restored} 件素材回到项目里${result.skipped > 0 ? `，${result.skipped} 件已在别处（跳过）` : ''}`);
      await reload();
    } catch (err) {
      setError(`恢复项目失败：${(err as Error).message}`);
    }
  };

  const purgeTrash = async (): Promise<void> => {
    try {
      await api.purgeTrash();
      setPurgeArmed(false);
      setSelected(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSelect = async (item: AssetListItem): Promise<void> => {
    setSelected(item);
    // 用户要求：点中间窗口里的素材，右侧详情栏自动打开（关着的话顺手打开并记住）
    setPanels((prev) => {
      if (prev.inspector) return prev;
      const next = { ...prev, inspector: true };
      savePanels(next);
      return next;
    });
    try {
      setSelected(await api.asset(item.id, view === 'trash'));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startScan = async (): Promise<void> => {
    try {
      const result = await api.startScan();
      setScan({ ...EMPTY_SCAN, running: true, phase: 'walk', current: `正在扫描 ${result.target ?? ''}` });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startImport = async (): Promise<void> => {
    try {
      await api.startImport();
      setImportState({ ...EMPTY_IMPORT, running: true, current: '准备导入' });
      setAddOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /**
   * 删除项目 = 项目连同子项目一起删，项目里的素材全部移入回收站（可恢复）。
   * 所以确认文案必须说清"东西去哪了"，否则用户不敢点。
   */
  const confirmDeleteProject = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    // 删之前先算清哪些项目会一起消失，用来判断"当前选中的是不是正好被删了"
    const doomed = subtreeIds(projects, pendingDelete.id);
    try {
      const result = await api.deleteProject(pendingDelete.id);
      const name = pendingDelete.name;
      setPendingDelete(null);
      setSelected(null);
      if (selectedProject !== null && doomed.includes(selectedProject)) {
        setSelectedProject(null);
        setView('all');
      }
      setError(null);
      await reload();
      const bits: string[] = [`已删除「${name}」`];
      if (result.removedChildren > 0) bits.push(`连同 ${result.removedChildren} 个子项目`);
      bits.push(`${result.trashedAssets} 件素材移入回收站，可随时恢复`);
      if (result.referencedLeftAlone > 0) bits.push(`${result.referencedLeftAlone} 件引用型素材的原文件未改动`);
      setNotice(bits.join(' · '));
    } catch (err) {
      setError(`删除项目失败：${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  const busy = scan.running || importState.running;
  const scanPercent = scan.total > 0 ? Math.round((scan.processed / scan.total) * 100) : 0;
  const importPercent = importState.total > 0 ? Math.round((importState.processed / importState.total) * 100) : 0;

  const title = project ? project.name : view === 'trash' ? '回收站' : '全部内容';
  const parentOfProject = project?.parentId != null ? projects.find((entry) => entry.id === project.parentId) ?? null : null;
  const titleHintParts: string[] = [];
  if (parentOfProject) titleHintParts.push(`上级项目：${parentOfProject.name}`);
  if (project && project.childCount > 0) titleHintParts.push(`含 ${project.childCount} 个子项目，共 ${project.totalCount} 件素材`);
  if (project?.description) titleHintParts.push(project.description);
  const titleHint = titleHintParts.length > 0 ? titleHintParts.join('\n') : undefined;

  return (
    <div className={`app${panels.sidebar ? '' : ' app--no-sidebar'}${selected ? '' : ' app--no-inspector'}`}>
      {panels.sidebar ? (
      <Sidebar
        projects={projects}
        assetCount={stats?.assets ?? 0}
        trashCount={stats?.trashed ?? 0}
        librarySize={`${stats?.assets ?? 0} 件 · ${humanBytes(stats?.bytes ?? 0)}`}
        view={view}
        selectedProject={selectedProject}
        onSelectAll={selectAll}
        onSelectTrash={selectTrash}
        onSelectProject={selectProject}
        onCreateProject={() => { setProjectParent(null); setProjectOpen(true); }}
        onCreateSubProject={(parentId) => { setProjectParent(parentId); setProjectOpen(true); }}
        onDeleteProject={(entry) => setPendingDelete(entry)}
        onRenameProject={async (project, name) => {
          try {
            const result = await api.renameProject(project.id, name);
            setNotice(`已重命名：${result.oldName} → ${result.name}`);
            await reload();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        onOpenLibrary={() => setLibraryOpen(true)}
      />
      ) : null}

      <main className="main">
        {scan.running || importState.running ? (
          <div className="status-bar">
            {scan.running ? (
              <>
                <span>扫描 {scan.phase} {scan.processed}/{scan.total}</span>
                <div className="progress"><i style={{ width: `${scanPercent}%` }} /></div>
                <span className="truncate mono" style={{ maxWidth: 420 }}>{scan.current}</span>
              </>
            ) : (
              <>
                <span>导入 {importState.processed}/{importState.total}</span>
                <div className="progress"><i style={{ width: `${importPercent}%` }} /></div>
                <span className="truncate mono" style={{ maxWidth: 420 }}>{importState.current}</span>
              </>
            )}
          </div>
        ) : null}

        {error ? <div className="notice notice-error">出错：{error}</div> : null}
        {notice ? <div className="notice notice-ok">{notice}</div> : null}

        <div className="main-inner">
          <Header
            title={title}
            titleHint={titleHint}
            query={query}
            onQueryChange={setQuery}
            view={viewMode}
            onViewChange={setViewMode}
            hideAdd={view === 'trash'}
            onAddContent={() => {
              if (projects.length === 0) setProjectOpen(true);
              else setAddOpen(true);
            }}
            addDisabled={busy}
            sidebarOpen={panels.sidebar}
            onToggleSidebar={toggleSidebar}
            rightExtra={
              view === 'trash' && items.length > 0 ? (
                purgeArmed ? (
                  <>
                    <button type="button" className="btn btn--destructive" disabled={busy} onClick={() => void purgeTrash()}>
                      确认清空（原文件不动）
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => setPurgeArmed(false)}>取消</button>
                  </>
                ) : (
                  <button type="button" className="btn btn--outline" onClick={() => setPurgeArmed(true)}>清空回收站（{items.length} 件 · {humanBytes(trashBytes)}）</button>
                )
              ) : null
            }
          />

          {promptFilter !== null ? (
            <div className="scope-chip">
              <span className="browse-badge">只看这件提示词生成的素材</span>
              <span className="browse-spacer" />
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPromptFilter(null)}>显示全部</button>
            </div>
          ) : null}

          {/* 来源筛选：AI 生成 / 非 AI / 其他 / 未标注 */}
          {(view === 'all' || view === 'trash') && items.length > 0 ? (
            <div className="filter-bar">
            <div className="origin-filter" role="group" aria-label="模型筛选">
              {['', ...[...new Set(items.map((item) => item.model).filter((m): m is string => Boolean(m)))].sort()].map((value) => (
                <button
                  key={'model:' + value}
                  type="button"
                  className={(modelFilter ?? '') === value ? 'is-active' : undefined}
                  aria-pressed={(modelFilter ?? '') === value}
                  onClick={() => setModelFilter(value === '' ? null : value)}
                >
                  {value === '' ? '全部模型' : value}
                </button>
              ))}
            </div>
            <div className="origin-filter" role="group" aria-label="来源筛选">
              {([['', '全部来源'], ['ai', 'AI 生成'], ['real', '非 AI'], ['other', '其他'], ['unset', '未标注']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={((originFilter ?? '') === value) ? 'is-active' : undefined}
                  aria-pressed={(originFilter ?? '') === value}
                  onClick={() => setOriginFilter(value === '' ? null : (value as 'ai' | 'real' | 'other' | 'unset'))}
                >
                  {label}
                </button>
              ))}
            </div>
            <ModalityFilter
              counts={modalityCounts}
              total={items.length}
              value={modality}
              onChange={setModality}
            />
            </div>
          ) : null}

          {/* 回收站里如果有"整项目删掉"的记录，先把整项目恢复的入口摆出来：
              素材件件恢复不会带回项目归属，这是用户反馈里最直接的痛点 */}
          {view === 'trash' && trashProjects.length > 0 ? (
            <div className="trash-projects">
              <p className="trash-projects-title">可以整项目恢复</p>
              {trashProjects.map((row) => (
                <div className="trash-project" key={row.trashId}>
                  <span className={projectDotClass(row.color)} aria-hidden />
                  <strong className="truncate">{row.name}</strong>
                  <span className="muted tabular">
                    {row.restorable} / {row.total} 件还在回收站
                  </span>
                  {row.parentName ? <span className="browse-badge">原属「{row.parentName}」</span> : null}
                  <span className="browse-spacer" />
                  <button type="button" className="btn btn--default btn--sm" onClick={() => void restoreWholeProject(row)}>
                    恢复项目（含素材）
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {/* 回收站的批量动作：勾选 / 恢复所选 / 全部恢复（清空回收站在顶栏） */}
          {view === 'trash' && items.length > 0 ? (
            <div className="scope-chip">
              <span className="browse-badge tabular">已选 {trashSelection.length} / {items.length} 件</span>
              <button type="button" className="btn btn--outline btn--sm" onClick={() => setTrashSelection(items.map((item) => item.id))}>
                全选
              </button>
              {trashSelection.length > 0 ? (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTrashSelection([])}>
                  取消选择
                </button>
              ) : null}
              <span className="browse-spacer" />
              <button
                type="button"
                className="btn btn--default btn--sm"
                disabled={busy || batchBusy || trashSelection.length === 0}
                onClick={() => void restoreMany(trashSelection)}
              >
                恢复所选（{trashSelection.length}）
              </button>
              <button
                type="button"
                className="btn btn--outline btn--sm"
                disabled={busy || batchBusy}
                onClick={() => void restoreMany(items.map((item) => item.id))}
              >
                全部恢复（{items.length}）
              </button>
              <button
                type="button"
                className={batchPurgeArmed ? 'btn btn--destructive btn--sm' : 'btn btn--outline btn--sm'}
                disabled={busy || batchBusy || trashSelection.length === 0}
                onClick={() => {
                  // 彻底删除不可恢复，所以要再点一次确认
                  if (!batchPurgeArmed) { setBatchPurgeArmed(true); return; }
                  setBatchPurgeArmed(false);
                  void purgeMany(trashSelection);
                }}
              >
                {batchPurgeArmed ? '再点一次：彻底删除' : `彻底删除所选（${trashSelection.length}）`}
              </button>
            </div>
          ) : null}

          <div className="grid-area">
            {items.length === 0 ? (
              view === 'trash' ? (
                <div className="grid-scroll">
                  <div className="empty-state">
                    <p style={{ fontWeight: 500 }}>回收站是空的</p>
                    
                  </div>
                </div>
              ) : project ? (
                <div className="grid-scroll">
                  <div className="empty-state">
                    <p style={{ fontWeight: 500 }}>这个项目还没有素材</p>
                    
                    <button type="button" className="btn btn--outline" onClick={() => setAddOpen(true)}>添加第一件素材</button>
                  </div>
                </div>
              ) : (
                <div className="grid-scroll">
                  <div className="empty-state">
                    <p style={{ fontWeight: 500 }}>库里还没有素材</p>
                    
                    <button type="button" className="btn btn--outline" onClick={() => void startScan()}>开始扫描</button>
                  </div>
                </div>
              )
            ) : visible.length === 0 ? (
              <div className="grid-scroll">
                <p className="empty-hint">没有找到匹配的内容</p>
              </div>
            ) : viewMode === 'grid' ? (
              <VirtualGrid
                revision={(panels.sidebar ? 1 : 0) + (selected ? 2 : 0)}
                items={visible}
                keyOf={(item) => item.id}
                selectedKey={selected?.id ?? null}
                resetKey={`${view}-${selectedProject ?? 'all'}-${modality ?? 'all'}-${debouncedQuery}-${viewMode}`}
                onSelect={(item) => void onSelect(item)}
                onActivate={(item) => { if (FOCUSABLE.has(item.modality)) setFocusId(item.id); }}
                render={(item, size) => (
                  <ContentCard
                    item={item}
                    previewHeight={size.previewHeight}
                    selected={selected?.id === item.id}
                    armed={cardArmed === item.id}
                    selectable={view === 'trash'}
                    checked={trashSelection.includes(item.id)}
                    onToggleSelect={(target) => setTrashSelection((prev) => prev.includes(target.id) ? prev.filter((id) => id !== target.id) : [...prev, target.id])}
                    onPurge={view === 'trash' ? (target) => {
                      // 彻底删除不可恢复，两步确认；确认后再走批量接口（单件＝只删一件）
                      if (purgeArmedId !== target.id) { setPurgeArmedId(target.id); return; }
                      setPurgeArmedId(null);
                      void purgeMany([target.id]);
                    } : undefined}
                    purgeArmed={purgeArmedId === item.id}
                    bundle={
                      item.bundleId !== null && item.bundleCount > 1
                        ? {
                            title: item.bundleTitle ?? '一组',
                            count: item.bundleCount,
                            expanded: expandedBundles.includes(item.bundleId),
                          }
                        : null
                    }
                    onToggleBundle={() => {
                      if (item.bundleId === null) return;
                      setExpandedBundles((prev) =>
                        prev.includes(item.bundleId as number)
                          ? prev.filter((id) => id !== item.bundleId)
                          : [...prev, item.bundleId as number],
                      );
                    }}
                    onRestore={view === 'trash' ? (target: AssetListItem) => {
                      // 回收站里这个按钮是「恢复」——安全动作，点一下就走
                      void api.restore(target.id)
                        .then(() => {
                          setSelected(null);
                          setNotice(`已把「${target.title}」恢复到库里（磁盘上的原文件本来就没动过）`);
                          return reload();
                        })
                        .catch((err: unknown) => setError(`恢复失败：${(err as Error).message}`));
                    } : undefined}
                    onTrash={(target) => {
                      // 两步：第一次点只是进入确认态，第二次才真的移入回收站
                      if (cardArmed !== target.id) { setCardArmed(target.id); return; }
                      setCardArmed(null);
                      void api.trash(target.id)
                        .then(() => {
                          setSelected(null);
                          setNotice(`已把「${target.title}」移入回收站（磁盘上的原文件没有动）`);
                          return reload();
                        })
                        .catch((err: unknown) => setError(`移入回收站失败：${(err as Error).message}`));
                    }}
                  />
                )}
              />
            ) : (
              <div className="grid-scroll">
                <ContentList
                  items={visible}
                  selectedId={selected?.id ?? null}
                  onSelect={(item) => void onSelect(item)}
                  onActivate={(item) => { if (FOCUSABLE.has(item.modality)) setFocusId(item.id); }}
                />
              </div>
            )}
          </div>
        </div>
      </main>

      {/* 没选中任何素材时右侧栏就不占位（用户要求）；点了素材会自动打开（见 onSelect） */}
      {filePath ? (
        <Suspense fallback={null}>
          <FileViewer
            path={filePath}
            onClose={() => setFilePath(null)}
            onError={setError}
            onNotice={setNotice}
          />
        </Suspense>
      ) : null}

      {/* 详情栏完全由"有没有选中素材"决定：选中就出现，Esc / 点空白 / 面板里的 × 都会取消选中 */}
      {selected ? (
        <Inspector
          asset={selected}
          trashed={view === 'trash'}
          projects={projects}
          onError={setError}
          onNotice={setNotice}
          onOpenPath={(path) => setFilePath(path)}
          onOpenFocus={() => { if (selected) setFocusId(selected.id); }}
          onClose={() => setSelected(null)}
          onChanged={() => {
            // 改完元数据（项目/来源/提示词/关联）就地刷新详情，不再把面板关掉——
            // 关掉之后用户还得重新点一次素材，像是"改一下就丢了上下文"
            if (selected) {
              void api.asset(selected.id, view === 'trash')
                .then((detail) => setSelected(detail))
                .catch(() => undefined);
            }
            void reload();
          }}
        />
      ) : null}

      {focusId !== null ? (
        <FocusOverlay
          items={items}
          startId={focusId}
          onClose={() => setFocusId(null)}
          onChangeItem={(item) => void onSelect(item)}
          onError={setError}
          onSaved={(message) => {
            setNotice(message);
            void reload();
          }}
        />
      ) : null}

      <ProjectDialog
        open={projectOpen}
        parentId={projectParent}
        projects={projects}
        onClose={() => setProjectOpen(false)}
        onError={setError}
        onCreated={(id) => {
          setProjectOpen(false);
          selectProject(id);
          void reload();
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete && pendingDelete.parentId !== null ? '删除子项目' : '删除项目'}
        confirmLabel="删除项目"
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDeleteProject()}
      >
        {pendingDelete ? (
          <>
            <p>
              将删除项目「<strong>{pendingDelete.name}</strong>」
              {pendingDelete.childCount > 0 ? `，以及它下面的 ${pendingDelete.childCount} 个子项目` : ''}。
            </p>
            {pendingDelete.totalCount > 0 ? (
              <p>
                项目里的 <strong>{pendingDelete.totalCount}</strong> 件素材
                {pendingDelete.childCount > 0 ? '（含子项目）' : ''}会<strong>全部移入回收站</strong>，
                可以随时恢复；磁盘上被引用的原始文件不受影响。
              </p>
            ) : (
              <p>这个项目里还没有素材，删除后不会产生回收站内容。</p>
            )}
          </>
        ) : null}
      </ConfirmDialog>

      <AddContentDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        projects={projects}
        defaultProjectId={selectedProject}
        libraryBusy={busy}
        onError={setError}
        onRescan={() => void startScan()}
        onImportLibrary={() => void startImport()}
        onAdded={(assetId) => {
          setAddOpen(false);
          void reload().then(() => void api.asset(assetId).then((detail: AssetDetail) => setSelected(detail)).catch(() => undefined));
        }}
      />

      <LibraryDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        ping={ping}
        stats={stats}
        onError={setError}
      />
    </div>
  );
}
