package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class ActivityForegroundTest {
    @Test
    public void quickPauseAndResumeInvalidatesTheOldSessionWithoutAPageRead() {
        ActivityForeground state = new ActivityForeground();
        assertEquals(0, state.currentSession());

        state.resume();
        long before = state.currentSession();
        assertEquals(1, before);

        state.pause();
        state.resume();
        assertNotEquals(before, state.currentSession());

        state.pause();
        assertEquals(0, state.currentSession());
    }
}
