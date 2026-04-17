// Short sample renderings of the same thought in each style, per category.
// Used as preview text on the style-picker cards. Hardcoded rather than
// LLM-generated so the page renders instantly and previews stay stable.

import type { CategoryId, StyleId } from "./types";

type Sample = Record<Exclude<StyleId, "custom">, string>;

export const STYLE_SAMPLES: Record<CategoryId, Sample> = {
  personal_messages: {
    formal:
      "Hey, are we still on for coffee tomorrow? I think 10 a.m. works unless you need to change it.",
    casual:
      "hey are we still on for coffee tmrw? 10 works unless u need to change it",
    excited:
      "hey!! are we still on for coffee tomorrow?? 10 works unless you need to change it!!",
  },
  work_messages: {
    formal:
      "Hi team — quick update: the API rollout is on track for Friday. Let me know if anything is blocking.",
    casual:
      "quick update — API rollout is on track for Friday. let me know if anything's blocking",
    excited:
      "quick update! API rollout is on track for Friday 🎉 lmk if anything's blocking!",
  },
  email: {
    formal:
      "Hi Alex,\n\nIt was great catching up today. I'll follow up with the proposal by Thursday and loop in Jordan once we have a draft.\n\nBest,\nJason",
    casual:
      "Hey Alex — great catching up today. I'll send the proposal by Thursday and loop Jordan in once we have a draft.\n\nThanks,\nJason",
    excited:
      "Hi Alex! Great catching up today — I'll have the proposal over by Thursday and will loop Jordan in as soon as we have a draft.\n\nBest,\nJason",
  },
  coding: {
    formal:
      "Refactor the auth middleware to validate JWT claims before hitting the database. The current flow issues a query per request, which adds avoidable latency.",
    casual:
      "refactor the auth middleware so it validates JWT claims before hitting the db — current flow fires a query per request which adds latency",
    excited:
      "refactor the auth middleware — validate JWT claims BEFORE the db call! current flow fires a query per request and it's killing latency 🔥",
  },
  other: {
    formal:
      "Reviewed the Q3 numbers. Revenue is up 12 percent quarter over quarter with stronger enterprise retention.",
    casual:
      "looked at Q3 numbers — revenue's up 12% QoQ with better enterprise retention",
    excited:
      "Q3 numbers are in — revenue up 12% QoQ and enterprise retention is way stronger!",
  },
};
