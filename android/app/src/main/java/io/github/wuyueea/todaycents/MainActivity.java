package io.github.wuyueea.todaycents;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import java.util.UUID;
import java.util.function.Consumer;

/** Android shell with an Activity-owned result round for the system folder picker. */
public class MainActivity extends BridgeActivity {

    private final Handler accessHandler = new Handler(Looper.getMainLooper());
    private final String accessKeyPrefix = "todaycents-storage-" + UUID.randomUUID();
    private volatile boolean storageClosing;
    private final StorageAccessRequests<ActivityResult> accessRequests = new StorageAccessRequests<>(
        this::launchStorageAccess,
        (action, delay) -> {
            if (!accessHandler.postDelayed(action, delay)) {
                throw new IllegalStateException("Folder picker timer unavailable");
            }
            return () -> accessHandler.removeCallbacks(action);
        },
        120_000L
    );

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before super.onCreate: BridgeActivity builds the bridge there,
        // and a plugin added afterwards would miss the first page load.
        registerPlugin(FolderPlugin.class);
        super.onCreate(savedInstanceState);

        // Capacitor 8 hands the back key to its App plugin, which this app does
        // not ship, so Android finished the activity from every screen. The page
        // now answers first: it closes the newest sheet, or steps back in the
        // router, and only a page with nothing left to close lets the shell go.
        // Never call super.onBackPressed() from that callback: it dispatches
        // the press back into this same callback, which recurses until the
        // stack runs out. The page owns the decision; the shell only exits.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                askPageAboutBack();
            }
        });
    }

    /**
     * Asks the page what the back key should do. The page returns "1" when it
     * handled the press; anything else (0, null, a page that never loaded)
     * means the press belongs to Android, so the activity finishes.
     */
    private void askPageAboutBack() {
        Bridge bridge = getBridge();
        if (bridge == null) {
            finish();
            return;
        }
        try {
            bridge.eval("(window.__todaycentsBack ? window.__todaycentsBack() : 0)", value -> {
                if (!"1".equals(value)) finish();
            });
        } catch (RuntimeException bridgeError) {
            // A torn-down WebView must not turn a back press into a crash.
            finish();
        }
    }

    public void requestStorageFolder(Consumer<ActivityResult> after, Consumer<String> failure) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) accessRequests.close();
            accessRequests.request(after, failure);
        });
    }

    boolean canSaveStorageChoice(long deadline) {
        return !storageClosing && SystemClock.elapsedRealtime() < deadline;
    }

    private StorageAccessRequests.Cancellable launchStorageAccess(long requestId) {
        String key = accessKeyPrefix + "-" + requestId;
        ActivityResultLauncher<Intent> launcher = getActivityResultRegistry().register(
            key, new ActivityResultContracts.StartActivityForResult(),
            result -> accessRequests.finish(requestId, result)
        );
        try {
            launcher.launch(SafFolderStore.picker(this));
            return () -> accessHandler.post(launcher::unregister);
        } catch (RuntimeException error) {
            launcher.unregister();
            throw error;
        }
    }

    @Override
    public void onDestroy() {
        // Settle calls while the old bridge still exists, before super tears
        // down its WebView. No callbacks or timers survive this activity.
        storageClosing = true;
        accessRequests.close();
        super.onDestroy();
    }
}
