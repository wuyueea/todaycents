package app.ledger.local;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.FileUriExposedException;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import org.json.JSONObject;

/**
 * The only native code in the app: a visible folder written through
 * java.io.File under the 「所有文件访问」 permission.
 *
 * Android 11+ grants MANAGE_EXTERNAL_STORAGE from a system settings page; on
 * API 28 and below, READ/WRITE_EXTERNAL_STORAGE is a runtime permission. API 29
 * is the known gap between the two models. Once held, any ordinary directory
 * under shared storage can be written. SharedPreferences
 * remembers one path; with none remembered the default is
 * /storage/emulated/0/Documents/记账本, created on demand.
 *
 * Every remembered or default folder is checked by writing and deleting a
 * probe file before it is reported. A revoked permission, a deleted folder or
 * a read-only volume therefore comes back as "no folder", and the export edge
 * falls back to the cache + share sheet instead of failing the write.
 *
 * The methods are the JS wrapper's surface: getAccess, requestAccess,
 * listDirs, getFolder, setFolder, clearFolder, openFolder, writeFile.
 */
@CapacitorPlugin(name = "Folder")
public class FolderPlugin extends Plugin {

    private static final String PREFS = "ledger_storage";
    private static final String KEY_PATH = "folder_path";
    private static final String DEFAULT_FOLDER_NAME = "记账本";
    private static final String INTERNAL_STORAGE = "内部存储";
    private static final String PROBE_PREFIX = ".ledger-probe-";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The root every browsable/writable path must stay inside. */
    private File sharedRoot() {
        File root = Environment.getExternalStorageDirectory();
        if (root == null) root = new File("/storage/emulated/0");
        return root;
    }

    private File defaultFolder() {
        return new File(sharedRoot(), "Documents" + File.separator + DEFAULT_FOLDER_NAME);
    }

    /**
     * True on API 30+ while the all-files switch is on; below it the runtime
     * WRITE permission is the gate, and READ comes with it in the same group.
     */
    private boolean hasAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return ContextCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.WRITE_EXTERNAL_STORAGE
        ) == PackageManager.PERMISSION_GRANTED;
    }

    /** Resolves the current permission state; never prompts. */
    @PluginMethod
    public void getAccess(PluginCall call) {
        call.resolve(accessJson());
    }

    /**
     * Sends the owner to the system page (or the runtime dialog) and resolves
     * with the state after coming back. The JS re-checks getAccess as well, so
     * a settings app that returns early still cannot fake a grant.
     */
    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (hasAccess()) {
            call.resolve(accessJson());
            return;
        }
        if (!(getActivity() instanceof MainActivity)) {
            call.reject("打不开系统的权限设置。");
            return;
        }

        boolean launched = ((MainActivity) getActivity()).requestStorageAccess(
            () -> call.resolve(accessJson())
        );
        if (!launched) {
            call.reject("打不开系统的权限设置。");
        }
    }

    /**
     * Lists the immediate subdirectories of a path, sorted by name.
     *
     * No path means the shared-storage root. Paths are canonicalized before
     * the check, so "..", symlinks and absolute paths cannot escape the shared
     * storage. The response carries the parent (null at the root) so the
     * browser knows exactly where 上一级 stops.
     */
    @PluginMethod
    public void listDirs(PluginCall call) {
        if (!hasAccess()) {
            call.reject("没有文件访问权限。");
            return;
        }

        String raw = call.getString("path");
        File requested = (raw == null || raw.trim().isEmpty())
            ? sharedRoot()
            : new File(raw.trim());

        File dir = insideShared(requested);
        if (dir == null) {
            call.reject("只能浏览手机存储里的文件夹。");
            return;
        }
        if (!dir.exists()) {
            call.reject("找不到这个文件夹。");
            return;
        }
        if (!dir.isDirectory()) {
            call.reject("这不是文件夹。");
            return;
        }

        List<DirEntry> entries = new ArrayList<>();
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (!child.isDirectory()) continue;
                File inside = insideShared(child);
                if (inside == null) continue;
                entries.add(new DirEntry(inside.getName(), inside.getAbsolutePath()));
            }
        }
        Collections.sort(entries, (left, right) -> {
            int byName = left.name.compareToIgnoreCase(right.name);
            return byName != 0 ? byName : left.name.compareTo(right.name);
        });

        JSArray dirs = new JSArray();
        for (DirEntry entry : entries) {
            JSObject item = new JSObject();
            item.put("name", entry.name);
            item.put("path", entry.path);
            dirs.put(item);
        }

        File parent = dir.getParentFile();
        File parentInside = parent == null ? null : insideShared(parent);

        JSObject result = new JSObject();
        result.put("path", dir.getAbsolutePath());
        result.put("parent", parentInside == null ? JSONObject.NULL : parentInside.getAbsolutePath());
        result.put("dirs", dirs);
        call.resolve(result);
    }

    /**
     * The remembered folder, or the default one when nothing is remembered.
     * Both are probe-checked; a failure is reported as no folder, which keeps
     * exports on the cache + share path.
     */
    @PluginMethod
    public void getFolder(PluginCall call) {
        call.resolve(folderJson(currentFolder()));
    }

    /**
     * Remembers a directory only after a probe write and delete succeed, so
     * the storage screen cannot save a path that will fail on the next export.
     */
    @PluginMethod
    public void setFolder(PluginCall call) {
        if (!hasAccess()) {
            call.reject("没有文件访问权限。");
            return;
        }

        String raw = call.getString("path");
        if (raw == null || raw.trim().isEmpty()) {
            call.reject("没有选择文件夹。");
            return;
        }

        File dir = insideShared(new File(raw.trim()));
        if (dir == null) {
            call.reject("只能选择手机存储里的文件夹。");
            return;
        }
        if (!dir.isDirectory()) {
            call.reject("找不到这个文件夹。");
            return;
        }
        if (!canWrite(dir)) {
            call.reject("这个文件夹不能写，请换一个。");
            return;
        }

        prefs().edit().putString(KEY_PATH, dir.getAbsolutePath()).apply();
        call.resolve(folderJson(dir));
    }

    /** Forgets the remembered path; the default location returns on demand. */
    @PluginMethod
    public void clearFolder(PluginCall call) {
        prefs().edit().remove(KEY_PATH).apply();
        call.resolve();
    }

    /**
     * Opens the folder in a file manager.
     *
     * A file:// Uri is tried first, with a read grant, because many file
     * managers show the exact directory that way. If StrictMode raises
     * FileUriExposedException (or no app claims it), the system Files app is
     * started at internal storage instead. Nothing handling either is a normal
     * { opened: false }, not an error.
     */
    @PluginMethod
    public void openFolder(PluginCall call) {
        File folder = currentFolder();
        if (folder == null) {
            call.resolve(opened(false));
            return;
        }
        call.resolve(opened(openWithFileManager(folder) || openSystemFiles()));
    }

    /**
     * Creates or replaces one file in the remembered folder. The base64 string
     * is what Capacitor's bridge carries naturally; the bytes are decoded here
     * so a binary .xlsx never makes a text round trip.
     */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String rawName = call.getString("name");
        String base64 = call.getString("base64");
        if (rawName == null || rawName.trim().isEmpty()) {
            call.reject("文件名不能为空。");
            return;
        }
        if (base64 == null) {
            call.reject("没有要写入的内容。");
            return;
        }

        String name = rawName.trim();
        if (!isSafeName(name)) {
            call.reject("这个文件名不能用。");
            return;
        }

        File folder = currentFolder();
        if (folder == null) {
            call.reject("还没有选择文件夹。");
            return;
        }

        try {
            File target = new File(folder, name).getCanonicalFile();
            File parent = target.getParentFile();
            if (parent == null || !parent.getCanonicalPath().equals(folder.getCanonicalPath())) {
                call.reject("这个文件名不能用。");
                return;
            }

            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            try (FileOutputStream output = new FileOutputStream(target, false)) {
                output.write(bytes);
                output.flush();
            }
            call.resolve(saved(name));
        } catch (Exception error) {
            call.reject("写入「" + name + "」失败。");
        }
    }

    /** The saved path after canonicalization, or null when it is not usable. */
    private File currentFolder() {
        if (!hasAccess()) return null;

        String stored = prefs().getString(KEY_PATH, null);
        File dir;
        if (stored == null) {
            dir = defaultFolder();
            if (!dir.exists() && !dir.mkdirs()) return null;
        } else {
            dir = new File(stored);
        }

        File inside = insideShared(dir);
        if (inside == null || !inside.isDirectory()) return null;
        if (!canWrite(inside)) return null;
        return inside;
    }

    /**
     * Resolves a path and refuses anything outside shared storage. Returns null
     * for a path that cannot be canonicalized, so callers treat it as refused.
     */
    private File insideShared(File file) {
        try {
            File root = sharedRoot().getCanonicalFile();
            File target = file.getCanonicalFile();
            String rootPath = root.getAbsolutePath();
            String targetPath = target.getAbsolutePath();
            if (targetPath.equals(rootPath)) return target;
            if (targetPath.startsWith(rootPath + File.separator)) return target;
            return null;
        } catch (IOException | SecurityException error) {
            return null;
        }
    }

    /**
     * Proves a directory is writable by creating a hidden probe and deleting it
     * again. A leftover probe is harmless and retried under a new name.
     */
    private boolean canWrite(File dir) {
        if (!dir.isDirectory()) return false;
        File probe = new File(dir, PROBE_PREFIX + UUID.randomUUID());
        try (FileOutputStream output = new FileOutputStream(probe, false)) {
            output.write('l');
            output.flush();
        } catch (Exception error) {
            //noinspection ResultOfMethodCallIgnored
            probe.delete();
            return false;
        }
        return probe.delete();
    }

    private boolean openWithFileManager(File folder) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(Uri.fromFile(folder), DocumentsContract.Document.MIME_TYPE_DIR);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // No resolveActivity() gate: package visibility can hide a file manager
        // that can still be started. FileUriExposedException is the signal to
        // fall back to the system Files app.
        try {
            getActivity().startActivity(intent);
            return true;
        } catch (FileUriExposedException error) {
            return false;
        } catch (Exception error) {
            return false;
        }
    }

    /** The system Files app at internal storage, then the generic Files entry. */
    private boolean openSystemFiles() {
        Intent root = new Intent(Intent.ACTION_VIEW);
        root.setDataAndType(
            DocumentsContract.buildRootUri("com.android.externalstorage.documents", "primary"),
            DocumentsContract.Document.MIME_TYPE_DIR
        );
        root.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (startIfHandled(root)) return true;

        Intent files = new Intent(Intent.ACTION_MAIN);
        files.addCategory(Intent.CATEGORY_APP_FILES);
        return startIfHandled(files);
    }

    private boolean startIfHandled(Intent intent) {
        try {
            getActivity().startActivity(intent);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private boolean isSafeName(String name) {
        return !name.equals(".")
            && !name.equals("..")
            && name.indexOf('/') < 0
            && name.indexOf('\\') < 0
            && name.indexOf('\0') < 0;
    }

    private JSObject accessJson() {
        boolean granted = hasAccess();
        JSObject result = new JSObject();
        result.put("granted", granted);
        if (!granted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            result.put("reason", "settings");
        }
        return result;
    }

    private JSObject folderJson(File folder) {
        JSObject result = new JSObject();
        if (folder == null) {
            result.put("path", JSONObject.NULL);
            result.put("name", JSONObject.NULL);
            return result;
        }
        result.put("path", folder.getAbsolutePath());
        result.put("name", displayNameOf(folder));
        return result;
    }

    private String displayNameOf(File folder) {
        try {
            if (folder.getCanonicalPath().equals(sharedRoot().getCanonicalPath())) {
                return INTERNAL_STORAGE;
            }
        } catch (IOException ignored) {
            // The name is cosmetic; fall through to the directory name.
        }
        String name = folder.getName();
        return name == null || name.trim().isEmpty() ? INTERNAL_STORAGE : name;
    }

    private JSObject opened(boolean opened) {
        JSObject result = new JSObject();
        result.put("opened", opened);
        return result;
    }

    private JSObject saved(String name) {
        JSObject result = new JSObject();
        result.put("saved", true);
        result.put("name", name);
        return result;
    }

    private static final class DirEntry {
        final String name;
        final String path;

        DirEntry(String name, String path) {
            this.name = name;
            this.path = path;
        }
    }
}
