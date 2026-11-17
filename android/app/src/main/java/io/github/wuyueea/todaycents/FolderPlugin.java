package io.github.wuyueea.todaycents;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.app.Activity;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Base64;

/** The WebView can use the selected folder, and cannot supply a URI or path. */
@CapacitorPlugin(name = "Folder")
public final class FolderPlugin extends Plugin {
    private SafFolderStore store() {
        return new SafFolderStore(getContext());
    }

    @PluginMethod
    public void getFolder(PluginCall call) {
        call.resolve(store().status());
    }

    @PluginMethod
    public void chooseFolder(PluginCall call) {
        if (!(getActivity() instanceof MainActivity activity)) {
            call.reject("打不开系统的文件夹选择器，请重试。");
            return;
        }
        long deadline = SystemClock.elapsedRealtime() + 120_000L;
        activity.requestStorageFolder(result -> {
            Intent data = result.getData();
            if (result.getResultCode() != Activity.RESULT_OK || data == null) {
                call.resolve(new JSObject().put("canceled", true));
                return;
            }
            // Persist now, while Android's result grant is live. Provider I/O
            // belongs on Capacitor's worker, not the UI thread.
            getBridge().execute(() -> {
                try {
                    store().select(data, () -> activity.canSaveStorageChoice(deadline));
                    call.resolve(new JSObject().put("canceled", false));
                } catch (Exception error) {
                    call.reject("无法授权这个文件夹，请选择可写的本机文件夹。");
                }
            });
        }, call::reject);
    }

    @PluginMethod
    public void clearFolder(PluginCall call) {
        try {
            store().clear();
            call.resolve();
        } catch (Exception error) {
            call.reject("暂时无法取消文件夹授权，请重试。");
        }
    }

    @PluginMethod
    public void openFolder(PluginCall call) {
        Intent intent = store().openIntent();
        if (intent == null || getActivity() == null) {
            call.resolve(new JSObject().put("opened", false));
            return;
        }
        getActivity().runOnUiThread(() -> {
            boolean opened = false;
            try {
                getActivity().startActivity(intent);
                opened = true;
            } catch (RuntimeException ignored) {
                // Some file managers have no handler for a directory document.
            }
            call.resolve(new JSObject().put("opened", opened));
        });
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        String name = call.getString("name");
        String base64 = call.getString("base64");
        if (!FolderPolicy.isSafeName(name) || base64 == null) {
            call.reject("文件名或写入内容无效。");
            return;
        }
        try {
            call.resolve(store().write(name, Base64.decode(base64, Base64.DEFAULT)));
        } catch (Exception error) {
            call.reject("写入文件夹失败，请检查所选目录。");
        }
    }
}
