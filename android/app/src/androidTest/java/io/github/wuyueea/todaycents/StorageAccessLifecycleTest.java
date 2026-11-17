package io.github.wuyueea.todaycents;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.app.Instrumentation.ActivityMonitor;
import android.content.IntentFilter;
import android.content.Intent;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Block the native trip without a synthetic result so pending calls are real. */
@RunWith(AndroidJUnit4.class)
public class StorageAccessLifecycleTest {
    private ActivityMonitor blockPicker(Instrumentation instrumentation) {
        IntentFilter filter = new IntentFilter(Intent.ACTION_OPEN_DOCUMENT_TREE);
        // The filter/block constructor deliberately returns no ActivityResult:
        // no system picker opens and no result is delivered until we destroy.
        return instrumentation.addMonitor(filter, null, true);
    }

    @Test public void concurrentRequestsShareOneTripAndBothRejectOnDestroy() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        ActivityMonitor monitor = blockPicker(instrumentation);
        AtomicInteger completed = new AtomicInteger();
        AtomicInteger rejected = new AtomicInteger();
        AtomicReference<String> message = new AtomicReference<>();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                activity.requestStorageFolder(result -> completed.incrementAndGet(), error -> {
                    message.set(error); rejected.incrementAndGet();
                });
                activity.requestStorageFolder(result -> completed.incrementAndGet(), error -> rejected.incrementAndGet());
            });
            assertEquals("one system picker trip for two callers", 1, monitor.getHits());
            assertEquals(0, completed.get());
            assertEquals(0, rejected.get());
            scenario.close();
            assertEquals(2, rejected.get());
            assertTrue(message.get().contains("中断"));
            assertEquals(0, completed.get());
        } finally {
            instrumentation.removeMonitor(monitor);
        }
    }

    @Test public void recreationRejectsTheOldRoundAndTheNewActivityCanRequestAgain() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        ActivityMonitor monitor = blockPicker(instrumentation);
        AtomicInteger oldCompleted = new AtomicInteger();
        AtomicInteger oldRejected = new AtomicInteger();
        AtomicInteger newCompleted = new AtomicInteger();
        AtomicInteger newRejected = new AtomicInteger();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> activity.requestStorageFolder(result -> oldCompleted.incrementAndGet(), error -> oldRejected.incrementAndGet()));
            assertEquals(1, monitor.getHits());
            scenario.recreate();
            assertEquals(1, oldRejected.get());
            assertEquals(0, oldCompleted.get());
            scenario.onActivity(activity -> activity.requestStorageFolder(result -> newCompleted.incrementAndGet(), error -> newRejected.incrementAndGet()));
            assertEquals("new activity gets a fresh registry registration", 2, monitor.getHits());
            assertEquals(0, newRejected.get());
            scenario.close();
            assertEquals(1, oldRejected.get());
            assertEquals(1, newRejected.get());
            assertEquals(0, newCompleted.get());
        } finally {
            instrumentation.removeMonitor(monitor);
        }
    }
}
