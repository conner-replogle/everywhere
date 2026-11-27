import { createContext } from "react";

/**
 * Opens a terminal with a command typed in, not run, for the user to check
 * and run themselves: offered on code blocks that need root, which claude
 * can't do. Absent where there's no terminal to open.
 */
export const RunInTerminalContext = createContext<((command: string) => void) | null>(null);

/**
 * Opens a web link as a tab of the thread (a web tab, in this browser).
 * Absent where there are no tabs: links then open in a new browser tab.
 */
export const OpenLinkContext = createContext<((url: string) => void) | null>(null);
