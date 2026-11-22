import React from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  variant?: 'fullscreen' | 'modal';
  title?: string;
  onDismiss?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  errorStack: string | null;
}

/**
 * React ErrorBoundary for ZONI AI (supports both root full-screen recovery and scoped modal recovery).
 * Prevents unrecoverable blank screens inside Android WebView or desktop browsers
 * by rendering a clear recovery screen with real diagnostic details.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
      errorStack: null,
    };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message =
      error instanceof Error
        ? error.message || error.name
        : typeof error === 'string'
        ? error
        : 'Unexpected UI rendering error';
    const stack = error instanceof Error && error.stack ? error.stack : null;
    return {
      hasError: true,
      errorMessage: message,
      errorStack: stack,
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // Log error details for diagnostics without exposing secrets
    console.error('[ZONI ErrorBoundary] Unhandled render exception:', error, info.componentStack);
  }

  handleRecover = (): void => {
    this.setState({
      hasError: false,
      errorMessage: '',
      errorStack: null,
    });
  };

  handleDismiss = (): void => {
    this.setState({
      hasError: false,
      errorMessage: '',
      errorStack: null,
    });
    this.props.onDismiss?.();
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const isModal = this.props.variant === 'modal';
    const heading = this.props.title || 'ZONI AI — INTERFACE RECOVERY';

    const card = (
      <div className="w-full max-w-lg rounded-2xl border border-rose-500/40 bg-slate-900/95 p-5 sm:p-6 shadow-[0_0_40px_rgba(244,63,94,0.2)] space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-rose-950/80 border border-rose-500/50 flex items-center justify-center text-rose-400">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="font-sci-fi text-base font-bold tracking-wider text-rose-200 uppercase">
              {heading}
            </h1>
            <p className="text-xs text-slate-300 mt-0.5">
              একটি অপ্রত্যাশিত ইন্টারফেস ত্রুটি ধরা পড়েছে। অ্যাপটি রিকভার বা রিলোড করুন।
            </p>
          </div>
        </div>

        <div className="p-3 rounded-xl bg-slate-950/80 border border-rose-500/30 font-mono text-xs text-rose-200 break-words">
          <div className="text-[10px] uppercase text-rose-400 mb-1">Error Summary</div>
          <div>{this.state.errorMessage || 'Unknown rendering error'}</div>
          {this.state.errorStack && (
            <details className="mt-2 text-[10px] text-slate-400">
              <summary className="cursor-pointer text-cyan-300">Technical Details</summary>
              <pre className="mt-1 whitespace-pre-wrap max-h-36 overflow-y-auto">
                {this.state.errorStack.slice(0, 1200)}
              </pre>
            </details>
          )}
        </div>

        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            onClick={this.handleRecover}
            className="flex-1 min-w-[140px] py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2 cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
            <span>{isModal ? 'RETRY PANEL' : 'RECOVER UI'}</span>
          </button>
          {isModal && this.props.onDismiss ? (
            <button
              type="button"
              onClick={this.handleDismiss}
              className="flex-1 min-w-[140px] py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-cyan-500/30 text-cyan-200 font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>CLOSE PANEL</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={this.handleReload}
              className="flex-1 min-w-[140px] py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-cyan-500/30 text-cyan-200 font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              <span>RELOAD ZONI AI</span>
            </button>
          )}
        </div>
      </div>
    );

    if (isModal) {
      return (
        <div
          role="alertdialog"
          aria-modal="true"
          className="zoni-modal-backdrop bg-black/80 backdrop-blur-md text-cyan-100 p-4 sm:p-6"
        >
          {card}
        </div>
      );
    }

    return (
      <div
        role="alert"
        className="min-h-screen w-full bg-slate-950 text-cyan-100 flex items-center justify-center p-4 sm:p-6"
      >
        {card}
      </div>
    );
  }
}
