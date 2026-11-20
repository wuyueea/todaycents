package io.github.wuyueea.todaycents;

import android.webkit.JavascriptInterface;

/** A read-only snapshot of the current uninterrupted Activity foreground session. */
public final class ActivityForeground {
    // Lifecycle writes run on the main thread. WebView reads on a bridge thread.
    private volatile long session;

    void resume() {
        session = Math.abs(session) + 1;
    }

    void pause() {
        session = -Math.abs(session);
    }

    @JavascriptInterface
    public long currentSession() {
        return Math.max(0, session);
    }
}
