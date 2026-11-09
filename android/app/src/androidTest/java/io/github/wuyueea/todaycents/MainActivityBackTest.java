package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

import android.os.SystemClock;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.getcapacitor.Bridge;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The native half of the back key.
 *
 * The page decision itself is covered by the web tests; these tests pin the
 * shell contract MainActivity implements: ask window.__todaycentsBack, keep
 * the activity when it answers 1, and finish when it answers 0 or is missing.
 */
@RunWith(AndroidJUnit4.class)
public class MainActivityBackTest {

    private static final long TIMEOUT_MS = 15000;

    private ActivityScenario<MainActivity> scenario;
    private Bridge bridge;

    @Before
    public void setUp() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(activity -> {
            bridge = activity.getBridge();
            assertNotNull("MainActivity bridge", bridge);
            assertNotNull("MainActivity WebView", bridge.getWebView());
        });
        waitForPageHandler();
    }

    @After
    public void tearDown() {
        if (scenario != null) scenario.close();
    }

    @Test
    public void backPressKeepsTheActivityWhenThePageHandlesIt() {
        setPageAnswer(1);

        pressBack();
        waitForBackCalls(1);
        assertEquals("a handled press must not finish the shell", Lifecycle.State.RESUMED, scenario.getState());

        pressBack();
        waitForBackCalls(2);
        assertEquals("the page must be asked on every press", Lifecycle.State.RESUMED, scenario.getState());
        assertFalse("the activity must still be alive", scenario.getState() == Lifecycle.State.DESTROYED);
    }

    @Test
    public void backPressFinishesTheActivityWhenThePageLetsItGo() {
        setPageAnswer(0);

        pressBack();

        waitForDestroyed();
        assertEquals(Lifecycle.State.DESTROYED, scenario.getState());
    }

    @Test
    public void backPressFinishesTheActivityWhenThePageHasNoHandler() {
        deletePageHandler();

        pressBack();

        waitForDestroyed();
        assertEquals(Lifecycle.State.DESTROYED, scenario.getState());
    }

    private void setPageAnswer(int answer) {
        eval(
            "window.__backCalls = 0; window.__todaycentsBack = function () {" +
            " window.__backCalls += 1; return " + answer + "; }; 'ok'"
        );
    }

    private void deletePageHandler() {
        eval("delete window.__todaycentsBack; 'ok'");
    }

    private void pressBack() {
        scenario.onActivity(activity -> activity.getOnBackPressedDispatcher().onBackPressed());
    }

    private void waitForBackCalls(int expected) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        String last = null;
        while (SystemClock.uptimeMillis() < deadline) {
            last = eval("window.__backCalls");
            if (String.valueOf(expected).equals(last)) return;
            SystemClock.sleep(50);
        }
        fail("expected " + expected + " back call(s), last JS value was " + last);
    }

    private void waitForPageHandler() {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        String last = null;
        while (SystemClock.uptimeMillis() < deadline) {
            last = eval("typeof window.__todaycentsBack");
            if ("\"function\"".equals(last)) return;
            SystemClock.sleep(100);
        }
        fail("the page never installed window.__todaycentsBack; last JS value was " + last);
    }

    private void waitForDestroyed() {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (scenario.getState() == Lifecycle.State.DESTROYED) return;
            SystemClock.sleep(50);
        }
        fail("the activity did not finish; state was " + scenario.getState());
    }

    private String eval(String script) {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<String> value = new AtomicReference<>();
        bridge.eval(script, result -> {
            value.set(result);
            latch.countDown();
        });
        try {
            if (!latch.await(2, TimeUnit.SECONDS)) fail("JS evaluation timed out: " + script);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            fail("JS evaluation interrupted: " + script);
        }
        return value.get();
    }
}
