package io.github.wuyueea.todaycents;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.BridgeActivity;

/**
 * The shell. Besides the bridge it owns the one system trip the app needs:
 * the 「所有文件访问」 settings page on Android 11+, or the storage runtime
 * dialog on API 28 and below.
 *
 * The launcher lives on the activity, not in the plugin. Capacitor can also
 * start an activity for a plugin and call an annotated method back, but that
 * path runs through the bridge's own registry and reflection. The old folder
 * picker used it and never came back on the owner's device, leaving the JS
 * promise pending forever. A launcher registered on the activity is created
 * before the bridge exists and cannot be lost.
 */
public class MainActivity extends BridgeActivity {

    /** The plugin's callback; runs on the UI thread after the owner returns. */
    private Runnable pendingAccess;

    private final ActivityResultLauncher<Intent> accessSettings = registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(),
        result -> finishAccessRequest()
    );

    private final ActivityResultLauncher<String[]> accessPermission = registerForActivityResult(
        new ActivityResultContracts.RequestMultiplePermissions(),
        result -> finishAccessRequest()
    );

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before super.onCreate: BridgeActivity builds the bridge there,
        // and a plugin added afterwards would miss the first page load.
        registerPlugin(FolderPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Opens the system page that holds the 「所有文件访问」 switch, or requests
     * READ/WRITE_EXTERNAL_STORAGE below Android 11.
     *
     * Returns false when no activity can handle the request, so the plugin can
     * reject immediately instead of waiting for a callback that never arrives.
     * The callback fires only after the owner comes back; the plugin then reads
     * the permission again and resolves the call with the fresh answer.
     */
    public boolean requestStorageAccess(Runnable after) {
        pendingAccess = after;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Intent appPage = new Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:" + getPackageName())
            );
            // No resolveActivity() gate: package visibility can hide a handler
            // that can still be started. Try, then fall back on failure.
            try {
                accessSettings.launch(appPage);
                return true;
            } catch (Exception appPageError) {
                Intent allApps = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                try {
                    accessSettings.launch(allApps);
                    return true;
                } catch (Exception allAppsError) {
                    pendingAccess = null;
                    return false;
                }
            }
        }

        try {
            accessPermission.launch(new String[] {
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE
            });
            return true;
        } catch (Exception error) {
            pendingAccess = null;
            return false;
        }
    }

    private void finishAccessRequest() {
        Runnable callback = pendingAccess;
        pendingAccess = null;
        if (callback != null) callback.run();
    }
}
