package io.github.wuyueea.todaycents;

import java.io.File;
import java.io.IOException;

/** Filename and local tree rules. Legacy paths can supply picker hints only. */
final class FolderPolicy {
    private FolderPolicy() {
        // static helpers only
    }

    /** True when a filename cannot escape its folder or contain a path/NUL. */
    static boolean isSafeName(String name) {
        return name != null && !name.trim().isEmpty() && !name.equals(".")
            && !name.equals("..")
            && name.indexOf('/') < 0
            && name.indexOf('\\') < 0
            && name.indexOf('\0') < 0;
    }

    /** Restrict exports to ordinary subdirectories of the phone's main storage. */
    static boolean isLocalFolderId(String id) {
        if (id == null || !id.startsWith("primary:")) return false;
        String relative = id.substring("primary:".length());
        if (relative.isEmpty() || relative.equalsIgnoreCase("Download")) return false;
        String[] parts = relative.split("/", -1);
        if (parts[0].equalsIgnoreCase("Android")) return false;
        for (String part : parts) if (!isSafeName(part)) return false;
        return true;
    }

    /**
     * Builds the document id used by the system Files app, e.g.
     * "primary:" for the root or "primary:Documents/记账本" for a child.
     * Returns null outside the shared-storage root.
     */
    static String documentId(File sharedRoot, File folder) {
        try {
            File root = sharedRoot.getCanonicalFile();
            File target = folder.getCanonicalFile();
            String rootPath = root.getAbsolutePath();
            String targetPath = target.getAbsolutePath();
            if (!targetPath.equals(rootPath)
                && !targetPath.startsWith(rootPath + File.separator)) {
                return null;
            }

            String relative = targetPath.substring(rootPath.length());
            while (relative.startsWith(File.separator)) {
                relative = relative.substring(1);
            }
            return "primary:" + relative.replace(File.separatorChar, '/');
        } catch (IOException | SecurityException error) {
            return null;
        }
    }

}
