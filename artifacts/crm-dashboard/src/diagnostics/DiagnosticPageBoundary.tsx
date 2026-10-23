import { Component, type ErrorInfo, type ReactNode } from 'react';
import { DiagnosticsButton } from './DiagnosticsProvider';

/** Keep the shell/report action alive when a page's React rendering fails. */
export class DiagnosticPageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    window.dispatchEvent(new ErrorEvent('error', { message: error.message }));
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="empty-state" role="alert">
      <h2>این بخش بارگذاری نشد</h2>
      <p>برای ثبت جزئیات مشکل، گزارش خطا را باز کنید. می‌توانید از منو به بخش دیگری بروید.</p>
      <DiagnosticsButton />
    </section>;
  }
}
