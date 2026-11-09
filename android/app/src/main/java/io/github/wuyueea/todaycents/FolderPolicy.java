package io.github.wuyueea.todaycents;

import java.io.File;
import java.io.IOException;

/**
 * Pure filesystem rules shared by FolderPlugin and its JVM tests.
 *
 * Nothing here touches Android: a shared-storage root is passed in explicitly,
 * so the dangerous path checks can run on the host without Robolectric.
 */
final class FolderPolicy {

    static final String INTERNAL_STORAGE = "内部存储";

    private FolderPolicy() {
        // static helpers only
    }

    /** True when a filename cannot escape its folder or contain a path/NUL. */
    static boolean isSafeName(String name) {
        return !name.equals(".")
            && !name.equals("..")
            && name.indexOf('/') < 0
            && name.indexOf('\\') < 0
            && name.indexOf('\0') < 0;
    }

    /**
     * Resolves a file and rejects anything outside the shared-storage root.
     * Returns null for paths that cannot be canonicalized.
     */
    static File insideShared(File sharedRoot, File file) {
        try {
            File root = sharedRoot.getCanonicalFile();
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

    /** 内部存储 for the shared-storage root, otherwise the folder's name. */
    static String displayName(File sharedRoot, File folder) {
        try {
            if (folder.getCanonicalPath().equals(sharedRoot.getCanonicalPath())) {
                return INTERNAL_STORAGE;
            }
        } catch (IOException ignored) {
            // The name is cosmetic; fall through to the directory name.
        }
        String name = folder.getName();
        return name == null || name.trim().isEmpty() ? INTERNAL_STORAGE : name;
    }
}
