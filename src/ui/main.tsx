import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";

import {
  LayoutDashboard,
  Columns3,
  GitBranch,
  Activity,
  Network,
  BookOpen,
  Settings2,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Play,
  Pause,
  RefreshCw,
  X,
  Check,
  AlertTriangle,
  Search,
  FolderOpen,
  ChevronDown,
  CheckCircle2,
  Clock3,
  CircleDot,
  Link2,
  ShieldCheck,
  Archive,
  FileText,
  LoaderCircle,
  Terminal,
  ListChecks,
} from "lucide-react";
import type {
  Snapshot,
  TaskView,
  Project,
  KnowledgeRecord,
  Run,
} from "../core/types.js";
import "@xyflow/react/dist/style.css";
import "./style.css";
const stateLabels: Record<string, string> = {
  draft: "待澄清",
  queued: "待执行",
  running: "执行中",
  verifying: "验证中",
  acceptance: "待验收",
  done: "已完成",
};
const runLabels: Record<string, string> = {
  starting: "正在创建会话",
  running: "执行中",
  reviewing: "独立审查",
  verifying: "真实验证",
  awaiting_input: "等待回答",
  paused: "已暂停",
  failed: "执行失败",
  unknown: "需要核对",
  completed: "执行结束",
};
const roleLabels: Record<string, string> = {
  delivery: "交付负责人",
  product: "产品与体验",
  architect: "架构",
  engineer: "实现工程师",
  quality: "质量与审查",
  knowledge: "知识维护",
};
const kindLabels: Record<string, string> = {
  requirement: "需求",
  capability: "现有能力",
  decision: "决策",
  bug: "缺陷",
  lesson: "经验教训",
  postmortem: "事故复盘",
  note: "项目笔记",
};
const navs = [
  { id: "overview", label: "项目总览", Icon: LayoutDashboard },
  { id: "board", label: "任务看板", Icon: Columns3 },
  { id: "dependencies", label: "依赖网络", Icon: GitBranch },
  { id: "runs", label: "执行追踪", Icon: Activity },
  { id: "impact", label: "影响地图", Icon: Network },
  { id: "memory", label: "项目记忆", Icon: BookOpen },
  { id: "settings", label: "配置与接入", Icon: Settings2 },
];
const initialToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (initialToken) {
  sessionStorage.setItem("harness-token", initialToken);
  history.replaceState({}, "", location.pathname);
}
let token = sessionStorage.getItem("harness-token") || "";
async function api<T = any>(url: string, input?: unknown): Promise<T> {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: input === undefined ? "GET" : "POST",
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "请求失败");
  return data;
}
const fmt = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
function Badge({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <GitBranch size={27} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(""),
    [snapshot, setSnapshot] = useState<Snapshot>(),
    [page, setPage] = useState("overview");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [historyVisible, setHistoryVisible] = useState(false);
  const [taskModal, setTaskModal] = useState<TaskView | "new" | null>(null),
    [recordModal, setRecordModal] = useState<KnowledgeRecord | "new" | null>(
      null,
    ),
    [addingProject, setAddingProject] = useState(false),
    [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const loading = useRef(false);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const ps = await api<Project[]>("/api/projects");
      setProjects(ps);
      const current = projectId || ps[0]?.id;
      if (current) {
        setProjectId(current);
        setSnapshot(await api<Snapshot>(`/api/projects/${current}/snapshot`));
      }
    } finally {
      loading.current = false;
    }
  }, [projectId]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    async function stream() {
      try {
        const r = await fetch("/api/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!r.ok) throw new Error("连接断开");
        setConnected(true);
        const reader = r.body!.getReader();
        while (alive) {
          const { done } = await reader.read();
          if (done) break;
          void load().catch((e) => setError(e.message));
        }
      } catch {
      } finally {
        if (alive) {
          setConnected(false);
          timer = setTimeout(() => void stream(), 3000);
        }
      }
    }
    void stream();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [load]);
  useEffect(() => {
    const t = setInterval(
      () => void load().catch(() => setConnected(false)),
      15000,
    );
    return () => clearInterval(t);
  }, [load]);
  const act = async (action: string, input: any = {}) => {
    setBusy(true);
    setError("");
    try {
      const value = await api(`/api/projects/${projectId}/action`, {
        action,
        input,
      });
      await load();
      return value;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const safe = (fn: () => Promise<any>) => void fn().catch(() => {});
  const tasks = (snapshot?.tasks || []).filter(
    (t) =>
      (historyVisible ||
        (!t.archived &&
          (t.version === snapshot?.project.currentVersion ||
            t.state !== "done"))) &&
      (t.title + " " + t.description)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const currentTask =
    taskModal && taskModal !== "new"
      ? snapshot?.tasks.find((t) => t.id === taskModal.id) || taskModal
      : taskModal;
  const currentRun = selectedRun
    ? snapshot?.runs.find((r) => r.id === selectedRun.id) || selectedRun
    : null;
  const issues =
    snapshot?.tasks.filter(
      (t) =>
        t.run && ["failed", "unknown", "awaiting_input"].includes(t.run.state),
    ) || [];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            h<span>↗</span>
          </div>
          <div>
            <strong>Harness</strong>
            <small>让开发有序生长</small>
          </div>
        </div>
        <div className="sidebar-project">
          <span className="eyebrow">WORKSPACE</span>
          <div className="project-switch">
            <select
              aria-label="选择项目"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSnapshot(undefined);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </div>
          <button
            className="quiet add-project"
            onClick={() => setAddingProject(true)}
          >
            <Plus size={14} />
            接入另一个项目
          </button>
        </div>
        <nav>
          {navs.map(({ id, label, Icon }) => (
            <button
              key={id}
              aria-label={label}
              className={page === id ? "active" : ""}
              onClick={() => {
                setPage(id);
                setQuery("");
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "board" && (
                <small>
                  {snapshot?.tasks.filter((t) => !t.archived).length || 0}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={`dot ${connected ? "green" : "amber"}`} />
            {connected ? "本地服务已连接" : "正在重新连接"}
          </div>
          <small>项目记录保存在你的设备上</small>
          <div className="sidebar-foot">
            PROJECT HARNESS <span>v0.1</span>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <span>/</span>{" "}
            <strong>{snapshot?.project.name || "正在读取项目"}</strong>
          </div>
          <div className="mobile-projects">
            <select
              aria-label="当前项目"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSnapshot(undefined);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="接入项目"
              onClick={() => setAddingProject(true)}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="top-actions">
            <span className="freshness">更新于 {fmt(snapshot?.at)}</span>
            <button
              className="icon-button"
              title="刷新"
              onClick={() => safe(load)}
            >
              <RefreshCw size={17} />
            </button>
            <span className="avatar">你</span>
          </div>
        </header>
        <div className="content">
          {error && (
            <div role="alert" className="alert error">
              <AlertTriangle size={17} />
              <span>{error}</span>
              <button onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="alert success">
              <Check size={17} />
              <span>{notice}</span>
              <button onClick={() => setNotice("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {!snapshot ? (
            <Empty
              title="连接项目工作台"
              description="请使用服务启动时提供的完整访问链接。"
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {page === "overview"
                      ? "BUILD WITH CONTINUITY"
                      : navs.find((n) => n.id === page)?.id.toUpperCase()}
                  </div>
                  <h1>
                    {page === "overview"
                      ? "把每一次改动，接起来。"
                      : navs.find((n) => n.id === page)?.label}
                  </h1>
                  <p>
                    {
                      (
                        {
                          overview: "从一个想法，到一个始终可用的产品。",
                          board: "目标、负责人、依赖与证据，在同一张看板上。",
                          dependencies: "沿着依赖前进，知道谁在等待什么。",
                          runs: "每一次执行，都能回到它的会话与证据。",
                          impact: "看清一次改变，会触及哪些已有能力。",
                          memory: "让有用的经验留下，让过时的信息离场。",
                          settings: "连接项目与 Codex，建立可执行的质量基线。",
                        } as any
                      )[page]
                    }
                  </p>
                </div>
                <div className="heading-actions">
                  <Badge tone="outline">
                    {snapshot.project.currentVersion}
                  </Badge>
                  {page === "memory" ? (
                    <button
                      className="primary"
                      onClick={() => setRecordModal("new")}
                    >
                      <Plus size={16} />
                      添加记录
                    </button>
                  ) : (
                    <button
                      className="primary"
                      onClick={() => setTaskModal("new")}
                    >
                      <Plus size={16} />
                      新建任务
                    </button>
                  )}
                </div>
              </div>
              {snapshot.warnings.map((w, i) => (
                <div className="alert warning" key={i}>
                  <ShieldCheck size={17} />
                  {w}
                </div>
              ))}
              {page === "overview" && (
                <>
                  <div className="summary-grid">
                    {[
                      {
                        label: "进行中的任务",
                        value: snapshot.tasks.filter((t) =>
                          ["running", "verifying"].includes(t.state),
                        ).length,
                        sub: "实现与验证",
                        Icon: Activity,
                      },
                      {
                        label: "等待你决策",
                        value:
                          issues.length +
                          snapshot.tasks.filter((t) => t.state === "acceptance")
                            .length,
                        sub: "问询、阻塞与验收",
                        Icon: CircleDot,
                      },
                      {
                        label: "已验收交付",
                        value: snapshot.tasks.filter((t) => t.state === "done")
                          .length,
                        sub: "有检查与审查依据",
                        Icon: ShieldCheck,
                      },
                      {
                        label: "沉淀的项目记忆",
                        value: snapshot.records.filter(
                          (r) => r.status !== "archived",
                        ).length,
                        sub: "规则、决策与教训",
                        Icon: BookOpen,
                      },
                    ].map(({ label, value, sub, Icon }) => (
                      <div className="stat" key={label}>
                        <div>
                          <span>{label}</span>
                          <Icon size={18} />
                        </div>
                        <strong>{String(value).padStart(2, "0")}</strong>
                        <small>{sub}</small>
                      </div>
                    ))}
                  </div>
                  <div className="overview-columns">
                    <section className="panel">
                      <div className="section-title">
                        <h2>现在需要关注</h2>
                        <Badge>
                          {issues.length +
                            snapshot.tasks.filter(
                              (t) => t.state === "acceptance",
                            ).length}{" "}
                          项
                        </Badge>
                      </div>
                      {[
                        ...issues,
                        ...snapshot.tasks.filter(
                          (t) => t.state === "acceptance",
                        ),
                      ].length === 0 ? (
                        <div className="calm">
                          <CheckCircle2 size={30} />
                          <h3>没有悬而未决的阻塞</h3>
                          <p>
                            任务准备好后，系统会按依赖推进。你只需要关注产品方向和交付效果。
                          </p>
                        </div>
                      ) : (
                        [
                          ...issues,
                          ...snapshot.tasks.filter(
                            (t) => t.state === "acceptance",
                          ),
                        ].map((t) => (
                          <button
                            className="attention-row"
                            key={t.id}
                            onClick={() => setTaskModal(t)}
                          >
                            <span
                              className={`dot ${t.state === "acceptance" ? "green" : "amber"}`}
                            />
                            <div>
                              <strong>{t.title}</strong>
                              <small>
                                {t.run?.error ||
                                  "检查和审查已结束，等待产品验收"}
                              </small>
                            </div>
                            <ArrowUpRight size={18} />
                          </button>
                        ))
                      )}
                    </section>
                    <section className="panel journey">
                      <div className="section-title">
                        <h2>你的交付路径</h2>
                        <GitBranch size={18} />
                      </div>
                      {[
                        "明确产品目标",
                        "安排任务与依赖",
                        "Codex 会话执行",
                        "独立验证与审查",
                        "体验并验收版本",
                      ].map((v, i) => (
                        <div className="journey-step" key={v}>
                          <span>{i + 1}</span>
                          <div>
                            <strong>{v}</strong>
                            <small>
                              {
                                [
                                  "保留业务规则和验收标准",
                                  "每个任务有清晰的完成条件",
                                  "隔离工作区，保留全部改动",
                                  "用真实结果判断是否可用",
                                  "沉淀决定、修复与经验",
                                ][i]
                              }
                            </small>
                          </div>
                        </div>
                      ))}
                    </section>
                  </div>
                  <section className="panel">
                    <div className="section-title">
                      <h2>近期任务</h2>
                      <button
                        className="text-button"
                        onClick={() => setPage("board")}
                      >
                        查看全部 <ArrowRight size={15} />
                      </button>
                    </div>
                    {tasks.length ? (
                      <div className="task-table">
                        {tasks
                          .slice(-5)
                          .reverse()
                          .map((t) => (
                            <button key={t.id} onClick={() => setTaskModal(t)}>
                              <span className={`dot state-${t.state}`} />
                              <strong>{t.title}</strong>
                              <span>{roleLabels[t.role]}</span>
                              <Badge>{stateLabels[t.state]}</Badge>
                            </button>
                          ))}
                      </div>
                    ) : (
                      <Empty
                        title="从第一个明确的目标开始"
                        description="先添加一个任务，写清楚预期结果和验收条件。也可以在 Codex 中与协调者一起梳理。"
                        action={
                          <button
                            className="secondary"
                            onClick={() => setTaskModal("new")}
                          >
                            <Plus size={16} />
                            创建第一个任务
                          </button>
                        }
                      />
                    )}
                  </section>
                </>
              )}
              {["board", "dependencies", "impact", "memory"].includes(page) && (
                <div className="filterbar">
                  <label className="search">
                    <Search size={16} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={
                        page === "memory"
                          ? "检索规则、决定与教训…"
                          : "查找任务…"
                      }
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={historyVisible}
                      onChange={(e) => setHistoryVisible(e.target.checked)}
                    />
                    包含归档
                  </label>
                  <span>
                    {page === "memory" ? snapshot.records.length : tasks.length}{" "}
                    条记录
                  </span>
                </div>
              )}
              {page === "board" && (
                <div className="board">
                  {Object.entries(stateLabels).map(([state, label]) => (
                    <section className="board-column" key={state}>
                      <div className="column-title">
                        <span className={`dot state-${state}`} />
                        <h2>{label}</h2>
                        <span>
                          {tasks.filter((t) => t.state === state).length}
                        </span>
                      </div>
                      <div className="column-body">
                        {tasks
                          .filter((t) => t.state === state)
                          .map((t) => (
                            <button
                              className="task-card"
                              key={t.id}
                              onClick={() => setTaskModal(t)}
                            >
                              <div className="task-card-top">
                                <span className={`priority p${t.priority}`}>
                                  P{t.priority}
                                </span>
                                <span>rev {t.revision}</span>
                                {t.archived && <Archive size={13} />}
                              </div>
                              <h3>{t.title}</h3>
                              <p>{t.description || "等待补充目标与范围"}</p>
                              {t.run && (
                                <Badge
                                  tone={
                                    t.run.state === "failed"
                                      ? "red"
                                      : t.run.state === "completed"
                                        ? "green"
                                        : "amber"
                                  }
                                >
                                  {runLabels[t.run.state]}
                                </Badge>
                              )}
                              {t.assurance === "stale" && (
                                <Badge tone="amber">证据需更新</Badge>
                              )}
                              <div className="card-meta">
                                <span>{roleLabels[t.role]}</span>
                                <span>
                                  <Link2 size={12} />
                                  {t.dependsOn.length}
                                </span>
                              </div>
                              {t.blocked[0] && (
                                <div className="blocked-text">
                                  <Clock3 size={12} />
                                  {t.blocked[0]}
                                </div>
                              )}
                            </button>
                          ))}
                        {!tasks.some((t) => t.state === state) && (
                          <div className="column-empty">暂无任务</div>
                        )}
                      </div>
                    </section>
                  ))}
                </div>
              )}
              {page === "dependencies" && (
                <Graph
                  snapshot={snapshot}
                  tasks={tasks}
                  mode="dependencies"
                  onTask={setTaskModal}
                />
              )}
              {page === "impact" && (
                <Graph
                  snapshot={snapshot}
                  tasks={tasks}
                  mode="impact"
                  onTask={setTaskModal}
                />
              )}
              {page === "runs" && (
                <>
                  <Graph
                    snapshot={snapshot}
                    tasks={snapshot.tasks}
                    mode="runs"
                    onTask={setTaskModal}
                  />
                  <section className="panel run-list">
                    <div className="section-title">
                      <h2>执行记录</h2>
                      <span>{snapshot.runs.length} 次</span>
                    </div>
                    {snapshot.runs.length ? (
                      snapshot.runs
                        .slice()
                        .reverse()
                        .map((r) => (
                          <button key={r.id} onClick={() => setSelectedRun(r)}>
                            <Activity size={17} />
                            <div>
                              <strong>
                                {snapshot.tasks.find((t) => t.id === r.taskId)
                                  ?.title || r.taskId}
                              </strong>
                              <small>
                                {fmt(r.createdAt)} · 任务版本 {r.taskRevision}
                              </small>
                            </div>
                            <Badge
                              tone={
                                r.state === "failed"
                                  ? "red"
                                  : r.state === "completed"
                                    ? "green"
                                    : "amber"
                              }
                            >
                              {runLabels[r.state]}
                            </Badge>
                            <ArrowUpRight size={17} />
                          </button>
                        ))
                    ) : (
                      <Empty
                        title="还没有执行记录"
                        description="任务派发后，会话、检查与审查会自动出现在这里。"
                      />
                    )}
                  </section>
                </>
              )}
              {page === "memory" && (
                <div className="memory-layout">
                  <div className="memory-tip">
                    <BookOpen size={22} />
                    <h3>保留当前事实，追溯决定理由。</h3>
                    <p>
                      当前规则、提案和历史记录有不同的状态。归档的内容仍可检索，不会默认装入新会话。
                    </p>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        safe(async () => {
                          const r = await act("maintain");
                          setNotice(
                            r.warnings.length
                              ? r.warnings.join("；")
                              : "引用与教训护栏检查通过。",
                          );
                        })
                      }
                    >
                      <ShieldCheck size={16} />
                      检查知识健康
                    </button>
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() =>
                        safe(async () => {
                          const r = await act("maintain", { archive: true });
                          setNotice(
                            `已归档 ${r.archived} 个已结束的旧版本任务。`,
                          );
                        })
                      }
                    >
                      <Archive size={15} />
                      整理旧版本任务
                    </button>
                  </div>
                  <div className="records">
                    {snapshot.records
                      .filter(
                        (r) =>
                          (historyVisible || r.status !== "archived") &&
                          (r.title + " " + r.body).includes(query),
                      )
                      .map((r) => (
                        <button
                          className="record"
                          key={r.id}
                          onClick={() => setRecordModal(r)}
                        >
                          <div>
                            <Badge
                              tone={
                                r.kind === "bug"
                                  ? "red"
                                  : r.kind === "lesson"
                                    ? "amber"
                                    : "outline"
                              }
                            >
                              {kindLabels[r.kind]}
                            </Badge>
                            <small>
                              {r.status} · rev {r.revision}
                            </small>
                          </div>
                          <h3>{r.title}</h3>
                          <p>{r.body}</p>
                          <footer>
                            <span>
                              {r.links.length} 个关联 · {r.guards.length} 个护栏
                            </span>
                            <ArrowUpRight size={16} />
                          </footer>
                        </button>
                      ))}
                  </div>
                </div>
              )}
              {page === "settings" && (
                <Settings
                  project={snapshot.project}
                  busy={busy}
                  act={act}
                  notice={setNotice}
                  codex={snapshot.codex}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>每个结论，都有它的依据。</span>
            <span>LOCAL FIRST · CONTINUOUS MEMORY</span>
          </footer>
        </div>
      </main>
      {currentTask && (
        <TaskDialog
          task={currentTask}
          snapshot={snapshot!}
          close={() => setTaskModal(null)}
          act={act}
          busy={busy}
          onRun={setSelectedRun}
        />
      )}
      {recordModal && (
        <RecordDialog
          record={recordModal}
          snapshot={snapshot!}
          close={() => setRecordModal(null)}
          act={act}
          busy={busy}
        />
      )}
      {currentRun && (
        <RunDialog
          run={currentRun}
          snapshot={snapshot!}
          close={() => setSelectedRun(null)}
          act={act}
          busy={busy}
        />
      )}
      {addingProject && (
        <Modal title="接入项目" close={() => setAddingProject(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(async () => {
                const p = await api<Project>("/api/projects", {
                  root: f.get("root"),
                  name: f.get("name"),
                });
                setProjectId(p.id);
                setAddingProject(false);
                await load();
              });
            }}
          >
            <p className="form-help">
              新项目会建立开发入口。已有项目会保留原文件，并记录待验证的基线。
            </p>
            <label>
              项目名称
              <input name="name" required placeholder="例如：客户服务平台" />
            </label>
            <label>
              本机项目目录
              <input
                name="root"
                required
                placeholder="/Users/你的名字/projects/my-project"
              />
            </label>
            <button className="primary" type="submit">
              <FolderOpen size={16} />
              接入并盘点
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button aria-label="关闭" className="icon-button" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}
function TaskDialog({
  task,
  snapshot,
  close,
  act,
  busy,
  onRun,
}: {
  task: TaskView | "new";
  snapshot: Snapshot;
  close: () => void;
  act: (a: string, b?: any) => Promise<any>;
  busy: boolean;
  onRun: (r: Run) => void;
}) {
  const existing = task !== "new" ? task : null;
  const [editing, setEditing] = useState(!existing);
  const [localError, setLocalError] = useState("");
  const run = existing?.run;
  const invoke = (fn: () => Promise<any>) =>
    void fn().catch((e) => setLocalError(e.message));
  return (
    <Modal title={existing ? existing.title : "新建任务"} close={close} wide>
      {localError && (
        <div role="alert" className="alert error">
          {localError}
        </div>
      )}
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            invoke(async () => {
              await act("task.save", {
                id: existing?.id,
                expectedRevision: existing?.revision,
                patch: {
                  title: f.get("title"),
                  description: f.get("description"),
                  role: f.get("role"),
                  priority: Number(f.get("priority")),
                  version: f.get("version"),
                  scopes: lines(String(f.get("scopes"))),
                  acceptanceCriteria: lines(
                    String(f.get("acceptanceCriteria")),
                  ),
                  dependsOn: f.getAll("dependsOn"),
                  recordIds: f.getAll("recordIds"),
                },
              });
              close();
            });
          }}
        >
          <label>
            任务标题
            <input
              name="title"
              required
              defaultValue={existing?.title}
              placeholder="清楚描述一个可验收的结果"
            />
          </label>
          <label>
            目标与范围
            <textarea
              name="description"
              rows={4}
              defaultValue={existing?.description}
              placeholder="希望解决什么问题？哪些既有行为需要保留？"
            />
          </label>
          <label>
            验收条件 <span>每行一项</span>
            <textarea
              name="acceptanceCriteria"
              rows={3}
              defaultValue={existing?.acceptanceCriteria.join("\n")}
              placeholder="用户完成操作后，应该看到什么结果？"
            />
          </label>
          <div className="form-row">
            <label>
              负责角色
              <select name="role" defaultValue={existing?.role || "engineer"}>
                {Object.entries(roleLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <select name="priority" defaultValue={existing?.priority ?? 1}>
                {[0, 1, 2, 3].map((v) => (
                  <option key={v} value={v}>
                    P{v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              交付版本
              <input
                name="version"
                defaultValue={
                  existing?.version || snapshot.project.currentVersion
                }
              />
            </label>
          </div>
          <label>
            影响模块 <span>每行一个路径或领域；留空则保守串行</span>
            <textarea
              name="scopes"
              rows={2}
              defaultValue={existing?.scopes.join("\n")}
              placeholder="例如：src/orders"
            />
          </label>
          <div className="form-row">
            <label>
              前置任务
              <select
                multiple
                name="dependsOn"
                defaultValue={existing?.dependsOn || []}
              >
                {snapshot.tasks
                  .filter((t) => t.id !== existing?.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              相关需求与记忆
              <select
                multiple
                name="recordIds"
                defaultValue={existing?.recordIds || []}
              >
                {snapshot.records.map((r) => (
                  <option key={r.id} value={r.id}>
                    {kindLabels[r.kind]} · {r.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-help">
            保存后进入待澄清。目标与验收确认后，再纳入执行计划。修改已有任务会生成新版本。
          </div>
          <div className="form-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => (existing ? setEditing(false) : close())}
            >
              取消
            </button>
            <button className="primary" disabled={busy} type="submit">
              <Check size={16} />
              保存任务
            </button>
          </div>
        </form>
      ) : (
        existing && (
          <>
            <div className="detail-badges">
              <Badge tone="outline">{stateLabels[existing.state]}</Badge>
              <Badge>{roleLabels[existing.role]}</Badge>
              <Badge>版本 {existing.revision}</Badge>
              <Badge
                tone={
                  existing.assurance === "verified"
                    ? "green"
                    : existing.assurance === "failed"
                      ? "red"
                      : "amber"
                }
              >
                {
                  {
                    unknown: "尚未验证",
                    verified: "检查通过",
                    stale: "证据需更新",
                    failed: "检查未通过",
                  }[existing.assurance]
                }
              </Badge>
            </div>
            <h3 className="detail-title">目标与范围</h3>
            <p className="prose">{existing.description || "尚未补充"}</p>
            <h3 className="detail-title">验收条件</h3>
            <ul className="criteria">
              {existing.acceptanceCriteria.map((x, i) => (
                <li key={i}>
                  <ListChecks size={15} />
                  {x}
                </li>
              ))}
            </ul>
            {existing.blocked.map((b, i) => (
              <div key={i} className="alert warning">
                {b}
              </div>
            ))}
            {existing.dependsOn.length > 0 && (
              <>
                <h3 className="detail-title">前置任务</h3>
                <div className="detail-badges">
                  {existing.dependsOn.map((d) => (
                    <Badge key={d}>
                      {snapshot.tasks.find((t) => t.id === d)?.title || d}
                    </Badge>
                  ))}
                </div>
              </>
            )}
            {run && (
              <div className="run-preview">
                <div>
                  <Activity size={18} />
                  <strong>{runLabels[run.state]}</strong>
                  <small>{fmt(run.updatedAt)}</small>
                </div>
                {run.error && <p className="error-text">{run.error}</p>}
                <div className="button-row">
                  {run.threadId && (
                    <a
                      className="secondary"
                      href={`codex://threads/${run.threadId}`}
                    >
                      <ArrowUpRight size={15} />
                      打开 Codex 会话
                    </a>
                  )}
                  <button className="quiet" onClick={() => onRun(run)}>
                    查看执行与证据 <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            )}
            <div className="form-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                编辑任务
              </button>
              {existing.state === "draft" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    invoke(async () => {
                      await act("task.authorize", {
                        id: existing.id,
                        expectedRevision: existing.revision,
                      });
                      close();
                    })
                  }
                >
                  <Check size={16} />
                  确认范围并纳入计划
                </button>
              )}
              {existing.ready && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    invoke(async () => {
                      await act("task.dispatch", { id: existing.id });
                      close();
                    })
                  }
                >
                  <Play size={16} />
                  派发到新会话
                </button>
              )}
              {existing.state === "acceptance" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    invoke(async () => {
                      await act("task.accept", {
                        id: existing.id,
                        expectedRevision: existing.revision,
                        note: "产品负责人已体验并验收。",
                      });
                      close();
                    })
                  }
                >
                  <ShieldCheck size={16} />
                  已体验，验收并集成
                </button>
              )}
              {existing.state === "done" && !existing.archived && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    invoke(async () => {
                      await act("task.archive", {
                        id: existing.id,
                        expectedRevision: existing.revision,
                      });
                      close();
                    })
                  }
                >
                  <Archive size={15} />
                  归档
                </button>
              )}
            </div>
          </>
        )
      )}
    </Modal>
  );
}
function RecordDialog({
  record,
  snapshot,
  close,
  act,
  busy,
}: {
  record: KnowledgeRecord | "new";
  snapshot: Snapshot;
  close: () => void;
  act: (a: string, b: any) => Promise<any>;
  busy: boolean;
}) {
  const r = record === "new" ? null : record;
  const [error, setError] = useState("");
  return (
    <Modal title={r ? "编辑项目记忆" : "添加项目记忆"} close={close} wide>
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void act("record.save", {
            id: r?.id,
            expectedRevision: r?.revision,
            patch: {
              title: f.get("title"),
              kind: f.get("kind"),
              status: f.get("status"),
              body: f.get("body"),
              scopes: lines(String(f.get("scopes"))),
              guards: f.getAll("guards"),
              links: f.getAll("links"),
              ...(f.get("sourcePath")
                ? { sourcePath: f.get("sourcePath") }
                : { sourcePath: undefined }),
              ...(f.get("supersededBy")
                ? { supersededBy: f.get("supersededBy") }
                : {}),
            },
          })
            .then(close)
            .catch((e) => setError(e.message));
        }}
      >
        <label>
          标题
          <input required name="title" defaultValue={r?.title} />
        </label>
        <div className="form-row">
          <label>
            类型
            <select name="kind" defaultValue={r?.kind || "requirement"}>
              {Object.entries(kindLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select name="status" defaultValue={r?.status || "active"}>
              {Object.entries({
                proposed: "提案",
                active: "当前有效",
                unknown: "尚未验证",
                investigating: "调查中",
                reproduced: "已复现",
                fixing: "修复中",
                verified: "已验证",
                deferred: "暂缓",
                false_positive: "误报",
                superseded: "已被替代",
                archived: "已归档",
              }).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          内容
          <textarea
            rows={10}
            name="body"
            defaultValue={r?.body}
            placeholder="记录当前事实、来源、理由与适用条件。缺陷应写明症状、复现步骤和关闭条件。"
          />
        </label>
        <label>
          适用模块 <span>每行一项</span>
          <textarea
            name="scopes"
            rows={2}
            defaultValue={r?.scopes.join("\n")}
          />
        </label>
        <div className="form-row">
          <label>
            关联任务或记录
            <select name="links" multiple defaultValue={r?.links || []}>
              {[...snapshot.tasks, ...snapshot.records]
                .filter((x) => x.id !== r?.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            防复发检查
            <select name="guards" multiple defaultValue={r?.guards || []}>
              {snapshot.project.checks.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          已有原文路径 <span>项目相对路径，保留原文权威</span>
          <input name="sourcePath" defaultValue={r?.sourcePath} />
        </label>
        <label>
          替代它的新记录
          <select name="supersededBy" defaultValue={r?.supersededBy || ""}>
            <option value="">未被替代</option>
            {snapshot.records
              .filter((x) => x.id !== r?.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
          </select>
        </label>
        <div className="form-actions">
          <button className="primary" disabled={busy}>
            <Check size={16} />
            保存记录
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RunDialog({
  run,
  snapshot,
  close,
  act,
  busy,
}: {
  run: Run;
  snapshot: Snapshot;
  close: () => void;
  act: (a: string, b: any) => Promise<any>;
  busy: boolean;
}) {
  const [error, setError] = useState(""),
    [reconciled, setReconciled] = useState<any>();
  const evidence = snapshot.evidence.filter((e) => e.runId === run.id);
  const invoke = (fn: () => Promise<any>) =>
    void fn().catch((e) => setError(e.message));
  const request = run.pendingRequest;
  return (
    <Modal title="执行与证据" close={close} wide>
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <div className="detail-badges">
        <Badge tone={run.state === "failed" ? "red" : "outline"}>
          {runLabels[run.state]}
        </Badge>
        <span>
          任务版本 {run.taskRevision} · {fmt(run.createdAt)}
        </span>
      </div>
      {run.error && <div className="alert warning">{run.error}</div>}
      <div className="button-row">
        {run.threadId && (
          <a href={`codex://threads/${run.threadId}`} className="secondary">
            <ArrowUpRight size={15} />
            实现会话
          </a>
        )}
        {run.reviewThreadId && (
          <a
            href={`codex://threads/${run.reviewThreadId}`}
            className="secondary"
          >
            <ShieldCheck size={15} />
            独立审查会话
          </a>
        )}
        {["running", "reviewing", "awaiting_input"].includes(run.state) && (
          <button
            disabled={busy}
            className="secondary"
            onClick={() => invoke(() => act("run.pause", { id: run.id }))}
          >
            <Pause size={15} />
            暂停
          </button>
        )}
        {["paused", "failed", "unknown"].includes(run.state) && (
          <>
            <button
              disabled={busy}
              className="secondary"
              onClick={() =>
                invoke(async () =>
                  setReconciled(await act("run.reconcile", { id: run.id })),
                )
              }
            >
              <RefreshCw size={15} />
              核对原会话
            </button>
            <button
              disabled={busy}
              className="secondary"
              onClick={() => invoke(() => act("run.resume", { id: run.id }))}
            >
              <Play size={15} />
              继续原任务
            </button>
          </>
        )}
        {![
          "running",
          "reviewing",
          "starting",
          "verifying",
          "awaiting_input",
        ].includes(run.state) && (
          <button
            disabled={busy}
            className="secondary"
            onClick={() => invoke(() => act("run.verify", { id: run.id }))}
          >
            <ListChecks size={15} />
            重新验证与审查
          </button>
        )}
        {["completed", "failed", "paused"].includes(run.state) && (
          <button
            disabled={busy}
            className="secondary"
            onClick={() => invoke(() => act("run.sync", { id: run.id }))}
          >
            <GitBranch size={15} />
            更新基线并重验
          </button>
        )}
      </div>
      {reconciled && (
        <details open>
          <summary>核对结果</summary>
          <pre>{JSON.stringify(reconciled, null, 2)}</pre>
        </details>
      )}
      {request && (
        <div className="request-box">
          <h3>会话需要你的输入</h3>
          <pre>{JSON.stringify(request.params, null, 2)}</pre>
          {request.method.includes("requestApproval") ? (
            <div className="button-row">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  invoke(() =>
                    act("run.respond", {
                      id: run.id,
                      response: { decision: "accept" },
                    }),
                  )
                }
              >
                允许本次操作
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  invoke(() =>
                    act("run.respond", {
                      id: run.id,
                      response: { decision: "decline" },
                    }),
                  )
                }
              >
                拒绝
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const questions = (request.params as any)?.questions || [];
                const answers = Object.fromEntries(
                  questions.map((q: any) => [
                    q.id,
                    { answers: [String(f.get(q.id))] },
                  ]),
                );
                invoke(() =>
                  act("run.respond", { id: run.id, response: { answers } }),
                );
              }}
            >
              {((request.params as any)?.questions || []).map((q: any) => (
                <label key={q.id}>
                  {q.question || q.title}
                  <input required name={q.id} />
                </label>
              ))}
              <button className="primary" disabled={busy}>
                提交回答
              </button>
            </form>
          )}
        </div>
      )}
      <h3 className="detail-title">执行结果</h3>
      <p className="prose">{run.summary || "执行尚未返回结论。"}</p>
      <h3 className="detail-title">验证证据</h3>
      {evidence.length ? (
        evidence.map((e) => (
          <details key={e.id} open>
            <summary>
              <Badge tone={e.passed ? "green" : "red"}>
                {e.passed ? "通过" : "未通过"}
              </Badge>{" "}
              {fmt(e.createdAt)} · {e.baseline.digest.slice(0, 12)}
            </summary>
            {e.results.map((r) => (
              <div className="check-result" key={r.id}>
                <div>
                  <strong>{r.id}</strong>
                  <Badge tone={r.status === "passed" ? "green" : "red"}>
                    {r.status}
                  </Badge>
                  <small>
                    {r.passed} 通过 / {r.failed} 失败 / {r.skipped} 跳过
                  </small>
                </div>
                <code>{r.command.join(" ")}</code>
                <details>
                  <summary>查看实际输出</summary>
                  <pre>{r.output}</pre>
                </details>
              </div>
            ))}
          </details>
        ))
      ) : (
        <p className="muted">尚无真实检查结果。</p>
      )}
      <details>
        <summary>上下文与运行路径</summary>
        <p className="mono">{run.worktree}</p>
        <pre>{run.context}</pre>
      </details>
      <details>
        <summary>事件时间线 · {run.events.length}</summary>
        <div className="timeline">
          {run.events.map((e, i) => (
            <div key={i}>
              <span>{fmt(e.at)}</span>
              <strong>{e.type}</strong>
              {e.threadId && (
                <a href={`codex://threads/${e.threadId}`}>对应会话 ↗</a>
              )}
              {e.text && <p>{e.text}</p>}
            </div>
          ))}
        </div>
      </details>
    </Modal>
  );
}
function Graph({
  snapshot,
  tasks,
  mode,
  onTask,
}: {
  snapshot: Snapshot;
  tasks: TaskView[];
  mode: "dependencies" | "impact" | "runs";
  onTask: (t: TaskView) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]),
    [edges, setEdges] = useState<Edge[]>([]),
    [layoutError, setLayoutError] = useState("");
  const key = JSON.stringify({
    mode,
    dependencyState:
      mode === "dependencies"
        ? snapshot.tasks.map((t) => [t.id, t.revision, t.state, t.dependsOn])
        : [],
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      dependsOn: t.dependsOn,
      recordIds: t.recordIds,
    })),
    checks: snapshot.project.checks,
    evidence: snapshot.evidence.map((e) => ({
      id: e.id,
      runId: e.runId,
      passed: e.passed,
    })),
    records: snapshot.records.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      links: r.links,
      guards: r.guards,
    })),
    runs: snapshot.runs.map((r) => ({
      id: r.id,
      state: r.state,
      taskId: r.taskId,
      reviewThreadId: r.reviewThreadId,
      evidenceId: r.evidenceId,
    })),
  });
  useEffect(() => {
    let cancelled = false;
    async function layout() {
      const seedTasks = tasks.slice(0, 100);
      const seeds = new Set(seedTasks.map((t) => t.id));
      const neighborIds = new Set(seedTasks.flatMap((t) => t.dependsOn));
      const displayTasks =
        mode === "dependencies"
          ? [
              ...seedTasks,
              ...snapshot.tasks.filter(
                (t) =>
                  !seeds.has(t.id) &&
                  (neighborIds.has(t.id) ||
                    t.dependsOn.some((id) => seeds.has(id))),
              ),
            ].slice(0, 100)
          : seedTasks;
      const graphNodes: Node[] = displayTasks.map((t) => ({
        id: t.id,
        position: { x: 0, y: 0 },
        data: {
          label: (
            <div className="graph-label">
              <small>{roleLabels[t.role]}</small>
              <strong>{t.title}</strong>
              <span>
                <i className={`dot state-${t.state}`} />
                {stateLabels[t.state]}
              </span>
            </div>
          ),
        },
        style: {
          width: 210,
          borderRadius: 10,
          borderColor: "#d7ded9",
          padding: 12,
        },
      }));
      const ids = new Set(graphNodes.map((n) => n.id));
      const graphEdges: Edge[] = [];
      const edge = (source: string, target: string, label?: string) => {
        if (ids.has(source) && ids.has(target))
          graphEdges.push({
            id: `${source}:${target}:${label || ""}`,
            source,
            target,
            label,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, color: "#8b9e96" },
            style: { stroke: "#8b9e96", strokeWidth: 1.5 },
            labelStyle: { fontSize: 10 },
          });
      };
      if (mode === "dependencies")
        displayTasks.forEach((t) => t.dependsOn.forEach((d) => edge(d, t.id)));
      if (mode === "impact") {
        const relevant = new Set(tasks.flatMap((t) => t.recordIds));
        snapshot.records.forEach((r) => {
          if (r.links.some((l) => ids.has(l))) relevant.add(r.id);
        });
        const seed = new Set(relevant);
        snapshot.records.forEach((r) => {
          if (seed.has(r.id)) r.links.forEach((l) => relevant.add(l));
          if (r.links.some((l) => seed.has(l))) relevant.add(r.id);
        });
        const records = snapshot.records
          .filter((r) => relevant.has(r.id))
          .slice(0, 100);
        records.forEach((r) => {
          ids.add(r.id);
          graphNodes.push({
            id: r.id,
            position: { x: 0, y: 0 },
            data: {
              label: (
                <div className="graph-label">
                  <small>{kindLabels[r.kind]}</small>
                  <strong>{r.title}</strong>
                </div>
              ),
            },
            style: {
              width: 210,
              borderRadius: 10,
              background: "#fff7e8",
              borderColor: "#e3d2ac",
              padding: 12,
            },
          });
        });
        tasks.forEach((t) => t.recordIds.forEach((r) => edge(r, t.id, "关联")));
        records.forEach((r) => r.links.forEach((l) => edge(r.id, l, "关联")));
        snapshot.project.checks.slice(0, 50).forEach((check) => {
          const cid = `check:${check.id}`;
          ids.add(cid);
          graphNodes.push({
            id: cid,
            position: { x: 0, y: 0 },
            data: {
              label: (
                <div className="graph-label">
                  <small>回归检查 · {check.kind}</small>
                  <strong>{check.name}</strong>
                  <span>{check.requiredCases?.length || 0} 个必需用例</span>
                </div>
              ),
            },
            style: {
              width: 210,
              borderRadius: 10,
              background: "#edf5f0",
              borderColor: "#aec7b7",
              padding: 12,
            },
          });
          tasks.slice(0, 100).forEach((t) => edge(t.id, cid, "全量回归"));
          records
            .filter((r) => r.guards.includes(check.id))
            .forEach((r) => edge(r.id, cid, "防复发"));
        });
      }
      if (mode === "runs") {
        snapshot.runs.slice(-80).forEach((r) => {
          if (!ids.has(r.taskId)) return;
          ids.add(r.id);
          graphNodes.push({
            id: r.id,
            position: { x: 0, y: 0 },
            data: {
              label: (
                <div className="graph-label">
                  <small>CODEX RUN</small>
                  <strong>{runLabels[r.state]}</strong>
                  {r.threadId && (
                    <a
                      href={`codex://threads/${r.threadId}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      打开会话 ↗
                    </a>
                  )}
                </div>
              ),
            },
            style: {
              width: 210,
              borderRadius: 10,
              background: "#edf5f0",
              borderColor: "#aec7b7",
              padding: 12,
            },
          });
          edge(r.taskId, r.id, "执行");
          const reviewIds =
            r.reviewThreadIds || (r.reviewThreadId ? [r.reviewThreadId] : []);
          const proofIds = snapshot.evidence
            .filter((e) => e.runId === r.id)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(-6)
            .map((e) => e.id);
          for (const [suffix, label, url] of [
            ...reviewIds
              .slice(-5)
              .map((id, i) => [`review-${i}`, `独立审查 ${i + 1}`, id]),
            ...proofIds.map((id, i) => [
              `evidence-${i}`,
              `真实验证 ${i + 1}`,
              id,
            ]),
          ])
            if (url) {
              const eid = `${r.id}-${suffix}`;
              ids.add(eid);
              graphNodes.push({
                id: eid,
                position: { x: 0, y: 0 },
                data: {
                  label: (
                    <div className="graph-label">
                      <small>{label}</small>
                      {suffix.startsWith("review") ? (
                        <a
                          href={`codex://threads/${url}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          打开审查 ↗
                        </a>
                      ) : (
                        <strong>
                          {snapshot.evidence.find((e) => e.id === url)?.passed
                            ? "检查通过"
                            : "检查未通过"}
                        </strong>
                      )}
                    </div>
                  ),
                },
                style: {
                  width: 210,
                  borderRadius: 10,
                  borderColor: "#d7ded9",
                  padding: 12,
                },
              });
              edge(r.id, eid, label);
            }
        });
      }
      if (!graphNodes.length) {
        setNodes([]);
        setEdges([]);
        return;
      }
      const elk = new (await import("elkjs/lib/elk.bundled.js")).default();
      const result = await elk.layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": mode === "dependencies" ? "DOWN" : "RIGHT",
          "elk.spacing.nodeNode": "30",
          "elk.layered.spacing.nodeNodeBetweenLayers": "70",
        },
        children: graphNodes.map((n) => ({ id: n.id, width: 210, height: 96 })),
        edges: graphEdges.map((e) => ({
          id: e.id,
          sources: [e.source],
          targets: [e.target],
        })),
      });
      if (!cancelled) {
        setNodes(
          graphNodes.map((n) => {
            const p = result.children?.find((x) => x.id === n.id);
            return { ...n, position: { x: p?.x || 0, y: p?.y || 0 } };
          }),
        );
        setEdges(graphEdges);
      }
    }
    void layout().catch((e) => setLayoutError(e.message));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return (
    <section className="graph-panel">
      {layoutError && <div className="alert error">{layoutError}</div>}
      <div className="graph-toolbar">
        <span>
          <span className="dot green" />共 {nodes.length} 个节点 ·{" "}
          {edges.length} 条关系
        </span>
        <small>
          {tasks.length > 100
            ? "已显示前 100 个任务，请用搜索缩小范围。"
            : "点击任务查看范围与证据；滚轮缩放，拖动查看。"}
        </small>
      </div>
      {!nodes.length ? (
        <Empty
          title="关系会随着项目生长"
          description="创建任务并设置依赖或关联记录后，就可以在这里查看完整路径。"
        />
      ) : (
        <div className="graph-canvas">
          <ReactFlow
            key={mode + nodes.length}
            nodes={nodes}
            edges={edges}
            fitView
            minZoom={0.15}
            maxZoom={1.8}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_, n) => {
              const t = snapshot.tasks.find((t) => t.id === n.id);
              if (t) onTask(t);
            }}
          >
            <Background color="#d4ded6" gap={22} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </section>
  );
}
function Settings({
  project,
  busy,
  act,
  notice,
  codex,
}: {
  project: Project;
  busy: boolean;
  act: (a: string, b?: any) => Promise<any>;
  notice: (s: string) => void;
  codex: Snapshot["codex"];
}) {
  const [checks, setChecks] = useState(JSON.stringify(project.checks, null, 2)),
    [inspection, setInspection] = useState<any>(),
    [error, setError] = useState(""),
    [backupPath, setBackupPath] = useState("");
  useEffect(
    () => setChecks(JSON.stringify(project.checks, null, 2)),
    [project.revision],
  );
  const invoke = (fn: () => Promise<any>) =>
    void fn().catch((e) => setError(e.message));
  return (
    <div className="settings-grid">
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <section className="panel">
        <div className="section-title">
          <h2>项目与执行</h2>
          <Settings2 size={18} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            invoke(async () => {
              await act("project.save", {
                expectedRevision: project.revision,
                patch: {
                  name: f.get("name"),
                  description: f.get("description"),
                  currentVersion: f.get("version"),
                  autoDispatch: f.get("autoDispatch") === "on",
                  maxConcurrent: Number(f.get("maxConcurrent")),
                  model: String(f.get("model") || "") || undefined,
                },
              });
              notice("项目设置已保存。");
            });
          }}
        >
          <label>
            项目名称
            <input name="name" defaultValue={project.name} />
          </label>
          <label>
            产品目标
            <textarea
              name="description"
              defaultValue={project.description}
              rows={3}
            />
          </label>
          <div className="form-row">
            <label>
              当前交付版本
              <input name="version" defaultValue={project.currentVersion} />
            </label>
            <label>
              并发任务
              <select name="maxConcurrent" defaultValue={project.maxConcurrent}>
                {[1, 2, 3].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Codex 模型 <span>留空沿用当前 Codex 配置</span>
            <input name="model" defaultValue={project.model} />
          </label>
          <label className="checkbox">
            <input
              name="autoDispatch"
              type="checkbox"
              defaultChecked={project.autoDispatch}
            />
            自动派发已授权且依赖就绪的任务
          </label>
          <button className="primary" disabled={busy}>
            <Check size={16} />
            保存设置
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>Codex 接入</h2>
          <Terminal size={18} />
        </div>
        <Badge tone={codex.connected ? "green" : "amber"}>
          {codex.connected ? "已连接" : "等待连接"}
        </Badge>
        <p className="form-help">
          会话在本机 Codex 中创建；每个任务都保留可直接打开的会话链接。
        </p>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            invoke(async () => {
              await act("codex.connect");
              notice("Codex 协议连接成功。");
            })
          }
        >
          <Link2 size={16} />
          检查连接
        </button>
        {codex.version && <p className="mono small">{codex.version}</p>}
        {codex.error && <p className="error-text">{codex.error}</p>}
        <h3 className="detail-title">让 Codex 读取项目工作台</h3>
        <p className="form-help">
          在项目中运行一次以下命令，再重新加载 Codex 项目。现有配置会保留。
        </p>
        <pre>harness connect --project {JSON.stringify(project.root)}</pre>
        <h3 className="detail-title">项目位置</h3>
        <p className="mono small">{project.root}</p>
        <button
          className="quiet"
          disabled={busy}
          onClick={() =>
            invoke(async () => setInspection(await act("project.inspect")))
          }
        >
          <Search size={16} />
          检测已有构建与测试
        </button>
        {inspection && (
          <div className="detected">
            {inspection.detected.map((c: any, i: number) => (
              <div key={i}>
                <code>{c.command.join(" ")}</code>
                <button
                  className="text-button"
                  onClick={() => {
                    try {
                      const current = JSON.parse(checks);
                      current.push({
                        id: `check-${Date.now()}`,
                        name: c.name,
                        command: c.command,
                        kind: c.kind,
                        timeoutMs: 120000,
                      });
                      setChecks(JSON.stringify(current, null, 2));
                    } catch {
                      setError("检查配置不是有效 JSON");
                    }
                  }}
                >
                  加入配置
                </button>
              </div>
            ))}
            <small>
              {inspection.gitHead
                ? "已有 Git 基线"
                : "尚无 Git 基线：派发前需要建立初始提交"}
            </small>
          </div>
        )}
      </section>
      <section className="panel wide-setting">
        <div className="section-title">
          <h2>质量检查</h2>
          <ShieldCheck size={18} />
        </div>
        <p className="form-help">
          可以让 Codex 配置这些检查。测试须能报告实际通过用例数，支持
          TAP、常见测试摘要或 resultFile 指向的 JSON
          结果。构建成功不能代替业务测试。
        </p>
        <textarea
          aria-label="质量检查配置"
          className="code-editor"
          rows={10}
          value={checks}
          onChange={(e) => setChecks(e.target.value)}
          spellCheck={false}
        />
        <div className="button-row">
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              invoke(async () => {
                await act("project.save", {
                  expectedRevision: project.revision,
                  patch: { checks: JSON.parse(checks) },
                });
                notice("检查配置已更新；旧证据会标为需要重验。");
              })
            }
          >
            <Check size={16} />
            保存检查
          </button>
          <button
            className="secondary"
            onClick={() =>
              setChecks(
                JSON.stringify(
                  [
                    {
                      id: "tests",
                      name: "行为回归",
                      kind: "test",
                      command: ["node", "--test", "--test-reporter=tap"],
                      timeoutMs: 120000,
                    },
                  ],
                  null,
                  2,
                ),
              )
            }
          >
            填入 Node 测试示例
          </button>
        </div>
      </section>
      <section className="panel wide-setting">
        <div className="section-title">
          <h2>备份与恢复</h2>
          <Archive size={18} />
        </div>
        <p className="form-help">
          备份源码、Git、项目记录和未结束的工作区。恢复到空目录后先核对基线，任务不会自动重放。
        </p>
        <div className="backup-row">
          <input
            aria-label="备份目录"
            placeholder="项目之外的新备份目录"
            value={backupPath}
            onChange={(e) => setBackupPath(e.target.value)}
          />
          <button
            className="secondary"
            disabled={busy || !backupPath}
            onClick={() =>
              invoke(async () => {
                const r = await act("backup", { destination: backupPath });
                notice(`备份已保存到 ${r.destination}`);
              })
            }
          >
            创建备份
          </button>
        </div>
        <p className="mono small">
          harness restore &lt;备份目录&gt; &lt;目标项目目录&gt;
        </p>
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
