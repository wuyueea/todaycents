package io.github.wuyueea.todaycents;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.ApplicationInfo;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;

import com.getcapacitor.JSObject;

import java.io.File;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;

/** Holds one persisted tree grant. Directory I/O is restricted to the system local provider. */
final class SafFolderStore {
    private static final String AUTHORITY = "com.android.externalstorage.documents";
    private static final String PREFS = "ledger_storage";
    private static final String TREE_KEY = "folder_tree_uri";
    private static final String LEGACY_PATH = "folder_path";
    private static final int GRANT = Intent.FLAG_GRANT_READ_URI_PERMISSION
        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private static final Object LOCK = new Object();
    private static final String[] DOCUMENT_COLUMNS = {
        Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS
    };

    private final Context context;
    private final SharedPreferences prefs;
    private final ContentResolver resolver;

    SafFolderStore(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.resolver = this.context.getContentResolver();
    }

    static Intent picker(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String id = null;
        String stored = prefs.getString(TREE_KEY, null);
        if (stored != null) id = localTreeId(Uri.parse(stored));
        if (id == null) {
            String path = prefs.getString(LEGACY_PATH, null);
            if (path != null) id = FolderPolicy.documentId(Environment.getExternalStorageDirectory(), new File(path));
        }
        if (!FolderPolicy.isLocalFolderId(id)) id = "primary:Documents";
        return new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(GRANT | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            .putExtra(Intent.EXTRA_LOCAL_ONLY, true)
            .putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(AUTHORITY, id));
    }

    private static String localTreeId(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme()) || !AUTHORITY.equals(uri.getAuthority())
            || uri.getPathSegments().size() != 2 || !DocumentsContract.isTreeUri(uri)
            || uri.getQuery() != null || uri.getFragment() != null) return null;
        String id = DocumentsContract.getTreeDocumentId(uri);
        return FolderPolicy.isLocalFolderId(id) ? id : null;
    }

    private boolean isSystemProvider() {
        ProviderInfo provider = context.getPackageManager().resolveContentProvider(AUTHORITY, 0);
        int system = ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP;
        return provider != null && provider.applicationInfo != null && (provider.applicationInfo.flags & system) != 0;
    }

    private int persistedModes(Uri uri) {
        for (UriPermission permission : resolver.getPersistedUriPermissions()) {
            if (!uri.equals(permission.getUri())) continue;
            return (permission.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
                | (permission.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
        }
        return 0;
    }

    private Uri savedUri() {
        String value = prefs.getString(TREE_KEY, null);
        return value == null ? null : Uri.parse(value);
    }

    private static Uri folderDocument(Uri tree) {
        return DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    }

    private String writableFolderName(Uri tree) throws IOException {
        if (localTreeId(tree) == null || !isSystemProvider() || persistedModes(tree) != GRANT) {
            throw new IOException("目录授权不可用。");
        }
        try (Cursor cursor = resolver.query(folderDocument(tree), DOCUMENT_COLUMNS, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst() || !Document.MIME_TYPE_DIR.equals(cursor.getString(1))
                || (cursor.getInt(2) & Document.FLAG_DIR_SUPPORTS_CREATE) == 0) {
                throw new IOException("目录不可写。");
            }
            String name = cursor.getString(0);
            if (name == null || name.trim().isEmpty()) throw new IOException("目录没有名称。");
            return name;
        }
    }

    JSObject status() {
        synchronized (LOCK) {
            Uri tree = savedUri();
            if (tree != null) {
                try {
                    return new JSObject().put("name", writableFolderName(tree)).put("needsReselection", false);
                } catch (IOException | RuntimeException ignored) {
                    return new JSObject().put("needsReselection", true);
                }
            }
            return new JSObject().put("needsReselection", prefs.contains(LEGACY_PATH));
        }
    }

    void select(Intent result, BooleanSupplier stillCurrent) throws IOException {
        synchronized (LOCK) {
            if (!stillCurrent.getAsBoolean()) throw new IOException("选夹已失效，请重试。");
            Uri tree = result.getData();
            if (localTreeId(tree) == null || !isSystemProvider() || (result.getFlags() & GRANT) != GRANT) {
                throw new IOException("需要可读写的本机文件夹授权。");
            }
            Uri previous = savedUri();
            String legacy = prefs.getString(LEGACY_PATH, null);
            int previousModes = persistedModes(tree);
            resolver.takePersistableUriPermission(tree, GRANT);
            boolean selected = false;
            try {
                writableFolderName(tree);
                if (!stillCurrent.getAsBoolean()) throw new IOException("选夹已失效，请重试。");
                if (!prefs.edit().putString(TREE_KEY, tree.toString()).remove(LEGACY_PATH).commit()) {
                    prefs.edit().putString(TREE_KEY, previous == null ? null : previous.toString())
                        .putString(LEGACY_PATH, legacy).apply();
                    throw new IOException("无法记住所选文件夹。");
                }
                selected = true;
            } finally {
                if (!selected) release(tree, GRANT & ~previousModes);
            }
            if (previous != null && !tree.equals(previous)) release(previous, GRANT);
        }
    }

    void clear() throws IOException {
        synchronized (LOCK) {
            Uri tree = savedUri();
            if (tree != null) release(tree, GRANT);
            if (!prefs.edit().remove(TREE_KEY).remove(LEGACY_PATH).commit()) {
                throw new IOException("无法更新存储设置。");
            }
        }
    }

    private void release(Uri tree, int modes) {
        int flags = persistedModes(tree) & modes;
        if (flags == 0) return;
        try {
            resolver.releasePersistableUriPermission(tree, flags);
        } catch (SecurityException error) {
            if ((persistedModes(tree) & modes) != 0) throw error;
        }
    }

    Intent openIntent() {
        synchronized (LOCK) {
            Uri tree = savedUri();
            try {
                writableFolderName(tree);
                return new Intent(Intent.ACTION_VIEW).setDataAndType(folderDocument(tree), Document.MIME_TYPE_DIR);
            } catch (IOException | RuntimeException ignored) {
                return null;
            }
        }
    }

    JSObject write(String name, byte[] bytes) throws IOException {
        if (!FolderPolicy.isSafeName(name) || !(name.endsWith(".xlsx") || name.endsWith(".ledger"))) {
            throw new IOException("只可导出账本备份或报表。");
        }
        synchronized (LOCK) {
            Uri tree = savedUri();
            String folderName = writableFolderName(tree);
            String actualName = FolderWriter.writeNew(new Destination(tree), name, bytes);
            return new JSObject().put("saved", true).put("name", actualName).put("folderName", folderName);
        }
    }

    private final class Destination implements FolderWriter.Destination<Uri> {
        private final Uri tree;
        Destination(Uri tree) { this.tree = tree; }

        @Override public Uri createTemporary() throws IOException {
            Uri uri = DocumentsContract.createDocument(resolver, folderDocument(tree), "application/octet-stream",
                "todaycents-writing-" + UUID.randomUUID() + ".tmp");
            if (uri == null) throw new IOException("无法创建临时文件。");
            return uri;
        }

        @Override public void writeAndSync(Uri temporary, byte[] bytes) throws IOException {
            try (Cursor cursor = resolver.query(temporary, DOCUMENT_COLUMNS, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst() || (cursor.getInt(2) & Document.FLAG_SUPPORTS_RENAME) == 0) {
                    throw new IOException("目录不支持安全发布文件。");
                }
            }
            ParcelFileDescriptor fd = resolver.openFileDescriptor(temporary, "w");
            if (fd == null) throw new IOException("无法打开临时文件。");
            try (ParcelFileDescriptor.AutoCloseOutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(fd)) {
                out.write(bytes);
                out.flush();
                out.getFD().sync();
            }
        }

        @Override public Set<String> names() throws IOException {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            Set<String> names = new HashSet<>();
            try (Cursor cursor = resolver.query(children, new String[]{Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (cursor == null) throw new IOException("无法读取目录中的文件名。");
                while (cursor.moveToNext()) {
                    String name = cursor.getString(0);
                    if (name == null) throw new IOException("目录返回无效文件名。");
                    names.add(name);
                }
            }
            return names;
        }

        @Override public String publish(Uri temporary, String name) throws IOException {
            Uri finalUri = DocumentsContract.renameDocument(resolver, temporary, name);
            if (finalUri == null) throw new IOException("无法发布完整文件。");
            // The system local provider represents the post-rename path in the returned ID.
            // A concurrent external writer may cause the provider to number it again.
            String id = DocumentsContract.getDocumentId(finalUri);
            String parent = DocumentsContract.getTreeDocumentId(tree) + "/";
            if (temporary.equals(finalUri) || !AUTHORITY.equals(finalUri.getAuthority()) || !id.startsWith(parent)) {
                throw new IOException("系统没有发布完整文件。");
            }
            String actualName = id.substring(parent.length());
            String extension = name.substring(name.lastIndexOf('.'));
            if (!FolderPolicy.isSafeName(actualName) || !actualName.endsWith(extension)) {
                throw new IOException("系统返回了无效的文件名。");
            }
            return actualName;
        }

        @Override public void discard(Uri temporary) {
            try {
                DocumentsContract.deleteDocument(resolver, temporary);
            } catch (Exception ignored) {
                // A revoked grant or gone provider can leave only this session's .tmp file.
            }
        }
    }
}
