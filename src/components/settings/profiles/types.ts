// Mirror of the Rust-side `Profile` / `MatchRule` / `CategoryStyle` types.
// Once bindings.ts regenerates post-compile, the types will come from
// @/bindings — these are here so the frontend can build before the first
// `cargo check`.

export type MatchRuleKind =
  | "bundle_id"
  | "process_name"
  | "window_class"
  | "exe_path_contains"
  | "window_title_contains";

export interface MatchRuleLike {
  kind: MatchRuleKind;
  value: string;
}

export interface ProfileLike {
  id: string;
  name: string;
  enabled: boolean;
  match_rules: MatchRuleLike[];
  prompt_id: string | null;
  post_process_override: boolean | null;
  custom_vocab: string[];
  append_trailing_space: boolean | null;
  provider_override: string | null;
  image_paste_uses_shift: boolean;
}

// ─── Style + Category system ─────────────────────────────────────────────

export type CategoryId =
  | "personal_messages"
  | "work_messages"
  | "email"
  | "coding"
  | "other";

export type StyleId = "formal" | "casual" | "excited" | "custom";

export type AutoCleanupLevel = "none" | "light" | "medium" | "high";

export interface CategoryStyleLike {
  category_id: CategoryId;
  selected_style: StyleId;
  custom_vocab: string[];
  custom_style_prompt: string | null;
  custom_style_name: string | null;
}

export const CATEGORY_ORDER: CategoryId[] = [
  "personal_messages",
  "work_messages",
  "email",
  "coding",
  "other",
];

export const STYLE_ORDER: StyleId[] = ["formal", "casual", "excited", "custom"];

export const CLEANUP_LEVELS: AutoCleanupLevel[] = [
  "none",
  "light",
  "medium",
  "high",
];
