package io.github.wuyueea.todaycents;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** One system picker round with many callers. All methods run on the UI thread. */
final class StorageAccessRequests<T> {
    interface Cancellable { void cancel(); }
    interface Launcher { Cancellable launch(long requestId); }
    interface Scheduler { Cancellable schedule(Runnable action, long delayMs); }

    private static final String INTERRUPTED = "文件夹选择已中断，请重试。";
    private final Launcher launcher;
    private final Scheduler scheduler;
    private final long timeoutMs;
    private long nextId;
    private boolean closed;
    private Request<T> active;

    StorageAccessRequests(Launcher launcher, Scheduler scheduler, long timeoutMs) {
        this.launcher = launcher;
        this.scheduler = scheduler;
        this.timeoutMs = timeoutMs;
    }

    void request(Consumer<T> after, Consumer<String> failure) {
        Waiter<T> waiter = new Waiter<>(after, failure);
        if (closed) {
            reject(waiter, INTERRUPTED);
            return;
        }
        if (active != null) {
            active.waiters.add(waiter);
            return;
        }
        Request<T> request = new Request<>(++nextId);
        request.waiters.add(waiter);
        active = request;
        try {
            request.timer = scheduler.schedule(
                () -> fail(request, "等待系统选夹超时，请返回应用后重试。"), timeoutMs
            );
            Cancellable registration = launcher.launch(request.id);
            // The platform/test registry may deliver a result inside launch.
            if (active == request) request.registration = registration;
            else cancel(registration);
        } catch (RuntimeException launchError) {
            fail(request, "打不开系统的文件夹选择器，请重试。");
        }
    }

    void finish(long requestId, T result) {
        Request<T> request = active;
        if (request == null || request.id != requestId) return;
        detach(request);
        for (Waiter<T> waiter : request.waiters) {
            try {
                waiter.after.accept(result);
            } catch (RuntimeException callbackError) {
                reject(waiter, "读取文件夹选择结果失败，请重试。");
            }
        }
        request.waiters.clear();
    }

    void close() {
        closed = true;
        if (active != null) fail(active, INTERRUPTED);
    }

    private void fail(Request<T> request, String message) {
        if (active != request) return;
        detach(request);
        for (Waiter<T> waiter : request.waiters) reject(waiter, message);
        request.waiters.clear();
    }

    private void detach(Request<T> request) {
        active = null;
        cancel(request.timer);
        cancel(request.registration);
    }

    private static void cancel(Cancellable item) {
        if (item == null) return;
        try { item.cancel(); } catch (RuntimeException ignored) {
            // Cleanup must not strand the callers if an Activity is torn down.
        }
    }

    private static void reject(Waiter<?> waiter, String message) {
        try { waiter.failure.accept(message); } catch (RuntimeException ignored) {
            // An old bridge can already be gone. Other callers still settle.
        }
    }

    private static final class Request<T> {
        final long id;
        final List<Waiter<T>> waiters = new ArrayList<>();
        Cancellable timer;
        Cancellable registration;
        Request(long id) { this.id = id; }
    }

    private static final class Waiter<T> {
        final Consumer<T> after;
        final Consumer<String> failure;
        Waiter(Consumer<T> after, Consumer<String> failure) {
            this.after = after;
            this.failure = failure;
        }
    }
}
