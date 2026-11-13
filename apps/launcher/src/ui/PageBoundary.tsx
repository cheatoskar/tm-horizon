// A crash on one page shows a short message instead of a black window; the sidebar keeps working.
import { Component, type ReactNode } from 'react';
import { tr } from '../i18n';

export class PageBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown) {
    console.error('page crashed', e);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <section className="panel">
          <h2>{tr('common.pageError')}</h2>
          <p className="dim small">{this.state.error}</p>
          <button className="btn ghost" onClick={() => this.setState({ error: null })}>{tr('common.retry')}</button>
        </section>
      </div>
    );
  }
}
