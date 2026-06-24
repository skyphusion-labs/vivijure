// Vendored subset of the Vivijure module contract (vivijure-module/2) for the notify-email module.
// Matches src/modules/types.ts for the shapes used here. Dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "notify" | "keyframe" | "motion.backend" | "finish" | "score" | "plan.enhance" | "cast.image";

export type ConfigScope = "render" | "install";
export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string>; scope?: ConfigScope }
  | { type: "bool"; default: boolean; label?: string; scope?: ConfigScope }
  | { type: "enum"; values: string[]; default: string; label?: string; scope?: ConfigScope }
  | { type: "string"; default: string; label?: string; scope?: ConfigScope };
export type ConfigSchema = Record<string, ConfigField>;

export interface Provides { id: string; label: string; }
export interface ModuleUi { section?: string; icon?: string; order?: number; }
export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
}

export interface InvokeContext { project: string; job_id: string; }
export interface InvokeRequest<I = unknown> {
  hook: HookName;
  input: I;
  config: Record<string, unknown>;
  context: InvokeContext;
}
export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string }
  | { ok: false; error: string };

// notify payloads (vivijure-module/1).
export interface NotifyInput {
  event: "render.complete";
  film_id: string;
  project: string;
  download_url?: string;
  seconds?: number;
}
export interface NotifyOutput {
  delivered: string[];
}

// The native Cloudflare Email Service send binding (send_email).
export interface EmailServiceBinding {
  send(req: {
    to: string | string[];
    from?: string | { email: string; name?: string };
    replyTo?: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}
