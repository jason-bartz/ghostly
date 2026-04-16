// Thin typed wrappers around the new Style-system Tauri commands. These
// mirror what tauri-specta will generate in `bindings.ts` on the next
// `bun run tauri dev`. Keeping them in a standalone module avoids touching
// the auto-generated file.

import { invoke } from "@tauri-apps/api/core";
import type {
  AutoCleanupLevel,
  CategoryId,
  CategoryStyleLike,
  StyleId,
} from "@/components/settings/profiles/types";

export const styleCommands = {
  async setStyleEnabled(enabled: boolean): Promise<void> {
    await invoke("set_style_enabled", { enabled });
  },
  async getCategoryStyles(): Promise<CategoryStyleLike[]> {
    return invoke("get_category_styles");
  },
  async setCategoryStyle(
    category: CategoryId,
    style: StyleId,
  ): Promise<CategoryStyleLike[]> {
    return invoke("set_category_style", { category, style });
  },
  async setCategoryCustomPrompt(
    category: CategoryId,
    prompt: string | null,
  ): Promise<CategoryStyleLike[]> {
    return invoke("set_category_custom_prompt", { category, prompt });
  },
  async setCategoryCustomStyleName(
    category: CategoryId,
    name: string | null,
  ): Promise<CategoryStyleLike[]> {
    return invoke("set_category_custom_style_name", { category, name });
  },
  async setCategoryVocab(
    category: CategoryId,
    words: string[],
  ): Promise<CategoryStyleLike[]> {
    return invoke("set_category_vocab", { category, words });
  },
  async setAutoCleanupLevel(level: AutoCleanupLevel): Promise<void> {
    await invoke("set_auto_cleanup_level", { level });
  },
  async setCustomWordCategories(
    word: string,
    categories: CategoryId[],
  ): Promise<void> {
    await invoke("set_custom_word_categories", { word, categories });
  },
  async getCategoryApps(category: CategoryId): Promise<string[]> {
    return invoke("get_category_apps", { category });
  },
};
