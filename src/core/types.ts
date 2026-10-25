import { z } from "zod";
export const roles = [
  "delivery",
  "product",
  "architect",
  "engineer",
  "quality",
  "knowledge",
] as const;
export const roleLabels: Record<string, string> = {
  delivery: "交付负责人",
  product: "产品与体验",
  architect: "架构",
  engineer: "实现工程师",
  quality: "质量与审查",
  knowledge: "知识维护",
};
export const TaskState = z.enum([
  "draft",
  "queued",
  "running",
  "verifying",
  "acceptance",
  "done",
]);
export const CheckSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  name: z.string().min(1),
  command: z.array(z.string()).min(1),
  kind: z.enum(["test", "e2e", "build", "lint"]),
  timeoutMs: z.number().int().positive().default(120000),
  resultFile: z.string().optional(),
  requiredCases: z.array(z.string().min(1)).default([]),
});
export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  autoDispatch: z.boolean().default(false),
  maxConcurrent: z.number().int().min(1).max(3).default(3),
  runTimeoutMs: z.number().int().positive().default(3600000),
  model: z.string().optional(),
  checks: z.array(CheckSchema).default([]),
  contextMaxChars: z.number().int().min(4000).default(24000),
  currentVersion: z.string().default("v1"),
  root: z.string(),
  codexBin: z.string().optional(),
});
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(240),
  description: z.string().default(""),
  revision: z.number().int().positive(),
  state: TaskState.default("draft"),
  role: z.enum(roles).default("engineer"),
  priority: z.number().int().min(0).max(3).default(1),
  version: z.string().default("v1"),
  scopes: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  recordIds: z.array(z.string()).default([]),
  checkIds: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  authorizedRevision: z.number().nullable().default(null),
  currentRunId: z.string().nullable().default(null),
  archived: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  acceptance: z
    .object({
      by: z.string(),
      note: z.string(),
      at: z.string(),
      runId: z.string(),
    })
    .optional(),
});
export const RecordSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "requirement",
    "capability",
    "decision",
    "bug",
    "lesson",
    "postmortem",
    "note",
  ]),
  title: z.string().min(1),
  body: z.string().default(""),
  revision: z.number().int().positive(),
  status: z
    .enum([
      "proposed",
      "active",
      "unknown",
      "investigating",
      "reproduced",
      "fixing",
      "verified",
      "deferred",
      "false_positive",
      "superseded",
      "archived",
    ])
    .default("active"),
  scopes: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  guards: z.array(z.string()).default([]),
  sourcePath: z.string().optional(),
  supersededBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type KnowledgeRecord = z.infer<typeof RecordSchema>;
export type Check = z.input<typeof CheckSchema>;
export interface Baseline {
  head: string;
  digest: string;
}
export interface CheckResult {
  id: string;
  kind: Check["kind"];
  command: string[];
  status: "passed" | "failed" | "unknown" | "timeout";
  exitCode: number | null;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  output: string;
  missingCases?: string[];
}
export interface Evidence {
  id: string;
  taskId: string;
  taskRevision: number;
  runId: string;
  baseline: Baseline;
  checksDigest: string;
  results: CheckResult[];
  passed: boolean;
  createdAt: string;
  location: string;
}
export interface Run {
  id: string;
  taskId: string;
  taskRevision: number;
  state:
    | "starting"
    | "running"
    | "reviewing"
    | "verifying"
    | "awaiting_input"
    | "paused"
    | "failed"
    | "unknown"
    | "completed";
  phase: "implementation" | "review";
  threadId?: string;
  reviewThreadId?: string;
  turnId?: string;
  reviewTurnId?: string;
  createdAt: string;
  updatedAt: string;
  worktree: string;
  branch?: string;
  baseline: Baseline;
  candidate?: Baseline;
  resultCommit?: string;
  summary?: string;
  error?: string;
  evidenceId?: string;
  integrated?: boolean;
  integrationHead?: string;
  contextDigest: string;
  knowledgeDigest?: string;
  context: string;
  repairAttempts?: number;
  integrationIntent?: string;
  review?: { passed: boolean; summary: string; issues: string[] };
  reviewThreadIds?: string[];
  pendingRequest?: { id: number | string; method: string; params: unknown };
  events: {
    at: string;
    type: string;
    text?: string;
    threadId?: string;
    turnId?: string;
  }[];
}
export interface TaskView extends Task {
  ready: boolean;
  blocked: string[];
  assurance: "unknown" | "verified" | "stale" | "failed";
  run?: Run;
}
export interface Snapshot {
  project: Project;
  tasks: TaskView[];
  records: KnowledgeRecord[];
  runs: Run[];
  evidence: Evidence[];
  warnings: string[];
  codex: { connected: boolean; version?: string; error?: string };
  at: string;
}
export class HarnessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new HarnessError(code, message, status);
}
