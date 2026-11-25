import { createContext, useContext } from "react";

/**
 * Whether the thread a pane belongs to is the one in focus. With threads side
 * by side, panes in the others mustn't take the keyboard on their own (a
 * terminal attaching, a composer mounting), or typing would land in the
 * wrong thread. A thread shown alone is always in focus.
 */
export const CellFocusContext = createContext(true);

export const useCellFocused = () => useContext(CellFocusContext);
