import { Component, type ReactNode } from "react";

/**
 * Around what an installed plugin's data draws: if it throws, that spot is
 * left empty (and logged) instead of taking the page down.
 */
export class PluginBoundary extends Component<{ plugin: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`plugin ${this.props.plugin}: its UI data broke`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
