package io.github.wuyueea.todaycents;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import java.util.UUID;
import java.util.function.Consumer;

/**
 * The shell. Besides the bridge it owns the one system trip the app needs:
 * the 「所有文件访问」 settings page on Android 11+, or the storage runtime
 * dialog on API 29 and below.
 *
 * Permission trips belong to the activity, not the bridge's reflection-based
 * plugin launcher. Each trip has its own registry key, so a late result from
 * an expired trip cannot complete a newer one. Destroying the activity rejects
 * its old callers; a recreated WebView reads the actual permission afresh.
 */
public class MainActivity extends BridgeActivity {

    private final Handler accessHandler = new Handler(Looper.getMainLooper());
    private final String accessKeyPrefix = "todaycents-storage-" + UUID.randomUUID();
    private final StorageAccessRequests accessRequests = new StorageAccessRequests(
        this::launchStorageAccess,
        (action, delay) -> {
            if (!accessHandler.postDelayed(action, delay)) {
                throw new IllegalStateException("Permission timer unavailable");
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

    /**
     * Opens the system page that holds the 「所有文件访问」 switch, or requests
     * READ/WRITE_EXTERNAL_STORAGE below Android 11.
     *
     * Joins duplicate calls, rejects launch/timeout/destruction failures, and
     * dispatches from Capacitor's plugin thread onto the UI thread. Completion
     * only means "returned"; the plugin must read the real permission again.
     */
    public void requestStorageAccess(Runnable after, Consumer<String> failure) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) accessRequests.close();
            accessRequests.request(after, failure);
        });
    }

    private StorageAccessRequests.Cancellable launchStorageAccess(long requestId) {
        String key = accessKeyPrefix + "-" + requestId;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ActivityResultLauncher<Intent> launcher = getActivityResultRegistry().register(
                key, new ActivityResultContracts.StartActivityForResult(),
                result -> accessRequests.finish(requestId)
            );
            Intent appPage = new Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:" + getPackageName())
            );
            // No resolveActivity() gate: package visibility can hide a handler
            // that can still be started. Try, then fall back on failure.
            try {
                try {
                    launcher.launch(appPage);
                } catch (RuntimeException appPageError) {
                    launcher.launch(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                }
                return launcher::unregister;
            } catch (RuntimeException allAppsError) {
                launcher.unregister();
                throw allAppsError;
            }
        }

        ActivityResultLauncher<String[]> launcher = getActivityResultRegistry().register(
            key, new ActivityResultContracts.RequestMultiplePermissions(),
            result -> accessRequests.finish(requestId)
        );
        try {
            launcher.launch(new String[] {
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE
            });
            return launcher::unregister;
        } catch (RuntimeException error) {
            launcher.unregister();
            throw error;
        }
    }

    @Override
    public void onDestroy() {
        // Settle calls while the old bridge still exists, before super tears
        // down its WebView. No callbacks or timers survive this activity.
        accessRequests.close();
        super.onDestroy();
    }
}
