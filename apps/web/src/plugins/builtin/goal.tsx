// Goal mode: the sidebar's mark for threads working toward a goal, and how
// the goal and wake tools look in the timeline. The goal bar and the
// composer's goal mode are the agent view's (components/agent/goal.tsx).

import { AlarmClockIcon, TargetIcon } from "lucide-react";
import { GoalBadge } from "@/components/agent/goal";
import { definePlugin } from "../types";

export const goal = definePlugin({
  id: "goal",
  title: "Goal mode and wakes",
  requires: { plugins: ["goal"], features: ["goal"] },
  sidebar: { threadBadges: [GoalBadge] },
  timeline: {
    tools: [
      {
        match: /^mcp__everywhere__goal_update$/,
        icon: TargetIcon,
        label: () => "Goal",
        summary: (input) => [input.status, input.reason].filter((s) => typeof s === "string" && s).join(": ") || undefined,
      },
      { match: /^mcp__everywhere__goal_get$/, icon: TargetIcon, label: () => "Read the goal", summary: () => "" },
      {
        match: /^mcp__everywhere__thread_wake$/,
        icon: AlarmClockIcon,
        label: () => "Wake me",
        summary: (input) =>
          input.minutes === 0
            ? "cancel"
            : `in ${String(input.minutes)} min${typeof input.reason === "string" ? `: ${input.reason}` : ""}`,
      },
    ],
  },
});
