// App icon imports
import appleMail from "@/assets/app-icons/apple-mail.png";
import appleNotes from "@/assets/app-icons/apple-notes.png";
import chatgpt from "@/assets/app-icons/chatgpt.png";
import claude from "@/assets/app-icons/claude.png";
import cursor from "@/assets/app-icons/cursor.png";
import discord from "@/assets/app-icons/discord.png";
import drafts from "@/assets/app-icons/drafts.png";
import figma from "@/assets/app-icons/figma.png";
import github from "@/assets/app-icons/github.png";
import gmail from "@/assets/app-icons/gmail.png";
import googleCalendar from "@/assets/app-icons/google-calendar.png";
import linear from "@/assets/app-icons/linear.png";
import messages from "@/assets/app-icons/messages.png";
import notion from "@/assets/app-icons/notion.png";
import obsidian from "@/assets/app-icons/obsidian.png";
import outlook from "@/assets/app-icons/outlook.png";
import perplexity from "@/assets/app-icons/perplexity.png";
import replit from "@/assets/app-icons/replit.png";
import slack from "@/assets/app-icons/slack.png";
import superhuman from "@/assets/app-icons/superhuman.png";
import terminal from "@/assets/app-icons/terminal.png";
import things from "@/assets/app-icons/things.png";
import vscode from "@/assets/app-icons/vscode.png";
import whatsapp from "@/assets/app-icons/whatsapp.png";
import xcode from "@/assets/app-icons/xcode.png";
import zed from "@/assets/app-icons/zed.png";

export type AppCategory = "developer" | "casual" | "email" | "structured";

// ─── Style system: visible apps per category ────────────────────────────
// Used by the Style settings page to render the "applies in" app-icon
// strip on each category tab. Uses the macOS icons we already bundle.

export type StyleCategoryId =
  | "personal_messages"
  | "work_messages"
  | "email"
  | "coding"
  | "other";

export interface StyleCategoryAppIcon {
  icon: string;
  label: string;
}

// Missing apps (Telegram, Teams, LinkedIn) are intentionally omitted — the
// category resolver still matches them server-side.
export const STYLE_CATEGORY_APPS: Record<
  StyleCategoryId,
  StyleCategoryAppIcon[]
> = {
  personal_messages: [
    { icon: messages, label: "Messages" },
    { icon: whatsapp, label: "WhatsApp" },
    { icon: discord, label: "Discord" },
  ],
  work_messages: [{ icon: slack, label: "Slack" }],
  email: [
    { icon: gmail, label: "Gmail" },
    { icon: appleMail, label: "Apple Mail" },
    { icon: outlook, label: "Outlook" },
    { icon: superhuman, label: "Superhuman" },
  ],
  coding: [
    { icon: cursor, label: "Cursor" },
    { icon: vscode, label: "VS Code" },
    { icon: terminal, label: "Claude Code" },
    { icon: zed, label: "Zed" },
    { icon: xcode, label: "Xcode" },
  ],
  other: [
    { icon: notion, label: "Notion" },
    { icon: obsidian, label: "Obsidian" },
    { icon: figma, label: "Figma" },
  ],
};

export interface AppIconInfo {
  icon: string;
  category: AppCategory;
  /** Short display label override (e.g. "VS Code" instead of "Visual Studio Code"). */
  label?: string;
}

/**
 * Category color palettes used for segment headers and app chips.
 */
export const categoryColors: Record<
  AppCategory,
  { bg: string; border: string; text: string; chipBg: string; chipBorder: string; chipText: string }
> = {
  developer: {
    bg: "bg-emerald-600",
    border: "border-emerald-500",
    text: "text-white",
    chipBg: "bg-emerald-400/10",
    chipBorder: "border-emerald-400/25",
    chipText: "text-emerald-200",
  },
  casual: {
    bg: "bg-sky-600",
    border: "border-sky-500",
    text: "text-white",
    chipBg: "bg-sky-400/10",
    chipBorder: "border-sky-400/25",
    chipText: "text-sky-200",
  },
  email: {
    bg: "bg-amber-600",
    border: "border-amber-500",
    text: "text-white",
    chipBg: "bg-amber-400/10",
    chipBorder: "border-amber-400/25",
    chipText: "text-amber-200",
  },
  structured: {
    bg: "bg-violet-600",
    border: "border-violet-500",
    text: "text-white",
    chipBg: "bg-violet-400/10",
    chipBorder: "border-violet-400/25",
    chipText: "text-violet-200",
  },
};

/**
 * Map from builtin profile id → icon asset + category.
 * Also used for display-name-based lookups in history.
 */
const byProfileId: Record<string, AppIconInfo> = {
  builtin_vscode: { icon: vscode, category: "developer" },
  builtin_cursor: { icon: cursor, category: "developer" },
  builtin_zed: { icon: zed, category: "developer" },
  builtin_xcode: { icon: xcode, category: "developer" },
  builtin_replit: { icon: replit, category: "developer" },
  builtin_github: { icon: github, category: "developer" },
  builtin_terminal: { icon: terminal, category: "developer" },
  // CLI — runs inside a terminal window; use the terminal icon.
  builtin_claude_code: { icon: terminal, category: "developer", label: "Claude Code" },
  // Windsurf ships no bundled icon in this repo; fall back to terminal.
  builtin_windsurf: { icon: terminal, category: "developer", label: "Windsurf" },
  builtin_slack: { icon: slack, category: "casual" },
  builtin_discord: { icon: discord, category: "casual" },
  builtin_imessage: { icon: messages, category: "casual" },
  builtin_whatsapp: { icon: whatsapp, category: "casual" },
  builtin_chatgpt: { icon: chatgpt, category: "casual" },
  builtin_claude: { icon: claude, category: "casual" },
  builtin_gmail: { icon: gmail, category: "email" },
  builtin_apple_mail: { icon: appleMail, category: "email" },
  builtin_outlook: { icon: outlook, category: "email" },
  builtin_notion: { icon: notion, category: "structured" },
  builtin_obsidian: { icon: obsidian, category: "structured" },
  builtin_figma: { icon: figma, category: "structured" },
  builtin_things: { icon: things, category: "structured" },
  builtin_linear: { icon: linear, category: "structured" },
};

/**
 * Map from display name (as stored in source_app) → icon + category.
 * Keys are lowercase for case-insensitive matching.
 */
const byDisplayName: Record<string, AppIconInfo> = {
  "visual studio code": { icon: vscode, category: "developer", label: "VS Code" },
  "vs code": { icon: vscode, category: "developer" },
  code: { icon: vscode, category: "developer", label: "VS Code" },
  electron: { icon: vscode, category: "developer", label: "VS Code" },
  cursor: { icon: cursor, category: "developer" },
  zed: { icon: zed, category: "developer" },
  xcode: { icon: xcode, category: "developer" },
  replit: { icon: replit, category: "developer" },
  github: { icon: github, category: "developer" },
  terminal: { icon: terminal, category: "developer" },
  iterm2: { icon: terminal, category: "developer" },
  wezterm: { icon: terminal, category: "developer" },
  alacritty: { icon: terminal, category: "developer" },
  kitty: { icon: terminal, category: "developer" },
  slack: { icon: slack, category: "casual" },
  discord: { icon: discord, category: "casual" },
  messages: { icon: messages, category: "casual" },
  whatsapp: { icon: whatsapp, category: "casual" },
  chatgpt: { icon: chatgpt, category: "casual" },
  claude: { icon: claude, category: "casual" },
  perplexity: { icon: perplexity, category: "casual" },
  gmail: { icon: gmail, category: "email" },
  "apple mail": { icon: appleMail, category: "email" },
  mail: { icon: appleMail, category: "email" },
  outlook: { icon: outlook, category: "email" },
  superhuman: { icon: superhuman, category: "email" },
  notion: { icon: notion, category: "structured" },
  obsidian: { icon: obsidian, category: "structured" },
  figma: { icon: figma, category: "structured" },
  things: { icon: things, category: "structured" },
  linear: { icon: linear, category: "structured" },
  drafts: { icon: drafts, category: "structured" },
  "apple notes": { icon: appleNotes, category: "structured" },
  notes: { icon: appleNotes, category: "structured" },
  "google calendar": { icon: googleCalendar, category: "structured" },
};

/** Look up icon info by builtin profile id. */
export function getAppInfoByProfileId(profileId: string): AppIconInfo | null {
  return byProfileId[profileId] ?? null;
}

/** Look up icon info by display name (case-insensitive). */
export function getAppInfoByName(displayName: string): AppIconInfo | null {
  return byDisplayName[displayName.toLowerCase()] ?? null;
}

