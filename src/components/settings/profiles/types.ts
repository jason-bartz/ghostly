// Mirror of the Rust-side `Profile` / `MatchRule` types. Once
// bindings.ts regenerates post-compile, the types will come from @/bindings
// — these are here so the frontend can build before the first `cargo check`.

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
}
