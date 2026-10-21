// Plugins that only change how their tools look in the timeline, and those
// whose web part is a settings page.

import { BellIcon, CircleCheckIcon, PaperclipIcon } from "lucide-react";
import { GithubMark } from "@/components/github-mark";
import { definePlugin } from "../types";

export const share = definePlugin({
  id: "share",
  title: "Share files",
  requires: { plugins: ["share"], features: ["claude"] },
  timeline: { tools: [{ match: /^mcp__everywhere__attach_file$/, icon: PaperclipIcon, label: () => "Attach files" }] },
});

export const done = definePlugin({
  id: "done",
  title: "Done threads",
  requires: { plugins: ["done"], features: ["done"] },
  timeline: { tools: [{ match: /^mcp__everywhere__thread_done$/, icon: CircleCheckIcon, label: () => "Mark thread done" }] },
});

/** GitHub: the account's connection (a Worker plugin) and cloning onto devices (the clone plugin). */
export const github = definePlugin({
  id: "github",
  title: "GitHub",
  settings: [{ to: "/settings/github", label: "GitHub", icon: GithubMark, order: 50 }],
});

/** Push notifications (a Worker plugin) and in-app alerts. */
export const push = definePlugin({
  id: "push",
  title: "Notifications",
  settings: [{ to: "/settings/notifications", label: "Notifications", icon: BellIcon, order: 30 }],
});
