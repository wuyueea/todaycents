package io.github.wuyueea.todaycents;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class StorageAccessRequestsTest {
    private static final class Timer implements StorageAccessRequests.Cancellable {
        final Runnable action;
        boolean cancelled;
        Timer(Runnable action) { this.action = action; }
        public void cancel() { cancelled = true; }
    }

    private static final class Harness {
        final List<Long> launches = new ArrayList<>();
        final List<Long> released = new ArrayList<>();
        final List<Timer> timers = new ArrayList<>();
        final List<String> errors = new ArrayList<>();
        final AtomicInteger completed = new AtomicInteger();
        final StorageAccessRequests requests;
        boolean launchFails;
        boolean scheduleFails;
        boolean synchronousResult;

        Harness() {
            requests = new StorageAccessRequests(id -> {
                launches.add(id);
                if (launchFails) throw new IllegalStateException("missing settings");
                if (synchronousResult) finish(id);
                return () -> released.add(id);
            }, (action, delay) -> {
                assertEquals(120000, delay);
                if (scheduleFails) throw new IllegalStateException("scheduler unavailable");
                Timer timer = new Timer(action);
                timers.add(timer);
                return timer;
            }, 120000);
        }
        void finish(long id) { requests.finish(id); }
        void request() { requests.request(completed::incrementAndGet, errors::add); }
    }

    @Test public void duplicateRequestsJoinOneLaunchAndAllCompleteOnce() {
        Harness h = new Harness();
        h.request(); h.request();
        assertEquals(1, h.launches.size());
        assertEquals(1, h.timers.size());
        h.finish(h.launches.get(0));
        h.finish(h.launches.get(0));
        assertEquals(2, h.completed.get());
        assertTrue(h.errors.isEmpty());
        assertTrue(h.timers.get(0).cancelled);
        assertEquals(h.launches, h.released);
    }

    @Test public void launchFailureRejectsAndAllowsRetry() {
        Harness h = new Harness(); h.launchFails = true;
        h.request();
        assertEquals(1, h.errors.size());
        assertTrue(h.timers.get(0).cancelled);
        h.launchFails = false; h.request();
        h.finish(h.launches.get(1));
        assertEquals(1, h.completed.get());
    }

    @Test public void timeoutRejectsAllAndLateResultCannotFinishTheRetry() {
        Harness h = new Harness(); h.request(); h.request();
        long old = h.launches.get(0);
        h.timers.get(0).action.run();
        assertEquals(2, h.errors.size());
        assertTrue(h.errors.get(0).contains("超时"));
        assertEquals(1, h.released.size());
        h.request();
        long current = h.launches.get(1);
        assertNotEquals(old, current);
        h.finish(old);
        assertEquals(0, h.completed.get());
        h.finish(current);
        assertEquals(1, h.completed.get());
        assertEquals(2, h.errors.size());
    }

    @Test public void staleTimerCannotRejectANewerRequest() {
        Harness h = new Harness(); h.request();
        h.finish(h.launches.get(0));
        h.request();
        h.timers.get(0).action.run();
        assertTrue(h.errors.isEmpty());
        h.finish(h.launches.get(1));
        assertEquals(2, h.completed.get());
    }

    @Test public void destructionRejectsAllAndNeverLaunchesAgain() {
        Harness h = new Harness(); h.request(); h.request();
        h.requests.close(); h.requests.close();
        h.finish(h.launches.get(0));
        assertEquals(2, h.errors.size());
        assertTrue(h.errors.get(0).contains("中断"));
        assertEquals(0, h.completed.get());
        assertTrue(h.timers.get(0).cancelled);
        assertEquals(1, h.released.size());
        h.request();
        assertEquals(3, h.errors.size());
        assertEquals(1, h.launches.size());
    }

    @Test public void oneThrowingCompletionCannotStrandOtherCallers() {
        Harness h = new Harness();
        h.requests.request(() -> { throw new IllegalStateException("destroyed bridge"); }, h.errors::add);
        h.request();
        h.finish(h.launches.get(0));
        assertEquals(1, h.completed.get());
        assertEquals(1, h.errors.size());
        h.request();
        assertEquals(2, h.launches.size());
    }

    @Test public void oneThrowingRejectionCannotStrandOtherCallers() {
        Harness h = new Harness();
        h.requests.request(() -> {}, message -> { throw new IllegalStateException("destroyed bridge"); });
        h.request();
        h.timers.get(0).action.run();
        assertEquals(1, h.errors.size());
        h.request();
        h.finish(h.launches.get(1));
        assertEquals(1, h.completed.get());
    }

    @Test public void synchronousResultStillReleasesTheReturnedLauncher() {
        Harness h = new Harness(); h.synchronousResult = true;
        h.request();
        assertEquals(1, h.completed.get());
        assertEquals(h.launches, h.released);
        assertTrue(h.timers.get(0).cancelled);
    }

    @Test public void completionCanStartANewRequestWithoutOldCleanupCancellingIt() {
        Harness h = new Harness();
        h.requests.request(h::request, h.errors::add);
        h.finish(h.launches.get(0));
        assertEquals(2, h.launches.size());
        assertTrue(h.timers.get(0).cancelled);
        assertFalse(h.timers.get(1).cancelled);
        h.finish(h.launches.get(1));
        assertEquals(1, h.completed.get());
        assertEquals(2, h.released.size());
    }

    @Test public void schedulerFailureRejectsWithoutLaunchingAndAllowsRetry() {
        Harness h = new Harness(); h.scheduleFails = true;
        h.request();
        assertEquals(1, h.errors.size());
        assertTrue(h.launches.isEmpty());
        h.scheduleFails = false; h.request();
        h.finish(h.launches.get(0));
        assertEquals(1, h.completed.get());
    }
}
