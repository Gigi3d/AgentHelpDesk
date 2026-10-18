import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A render crash on one page should not blank the whole console. The desk's own
 * rule is "never guess, hand it to a human" — this is the UI version of it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AgentHelpDesk console crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl px-6 py-24 text-center">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-error">This page failed to render</p>
        <h1 className="mt-2 text-[24px] font-semibold text-ink">The console hit an error, so it stopped instead of showing you wrong numbers.</h1>
        <p className="mt-2 text-[14px] text-muted">Nothing was shipped and nothing was billed. The error is in the browser console.</p>
        <pre className="mt-4 overflow-x-auto rounded-card border border-line bg-surface p-4 text-left font-mono text-[12px] text-ink">{error.message}</pre>
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" onClick={() => this.setState({ error: null })} className="h-9 rounded-ctl border border-line bg-white px-4 text-[14px] font-medium text-ink hover:bg-surface">Try this page again</button>
          <a href="/app" className="h-9 rounded-ctl bg-pink px-4 text-[14px] font-medium leading-9 text-white hover:bg-pink-hover">Back to the console</a>
        </div>
      </div>
    );
  }
}
