package io.github.wuyueea.todaycents;

import java.io.IOException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Publishes a fully written new document without opening an existing file for write. */
final class FolderWriter {
    interface Destination<T> {
        T createTemporary() throws IOException;
        void writeAndSync(T temporary, byte[] bytes) throws IOException;
        Set<String> names() throws IOException;
        String publish(T temporary, String name) throws IOException;
        void discard(T temporary);
    }

    private FolderWriter() {}

    static <T> String writeNew(Destination<T> destination, String name, byte[] bytes) throws IOException {
        if (!FolderPolicy.isSafeName(name)) throw new IOException("无效的文件名。");
        T temporary = destination.createTemporary();
        boolean published = false;
        try {
            destination.writeAndSync(temporary, bytes);
            String candidate = availableName(name, destination.names());
            String actualName = destination.publish(temporary, candidate);
            published = true;
            return actualName;
        } finally {
            if (!published) destination.discard(temporary);
        }
    }

    static String availableName(String name, Set<String> names) throws IOException {
        Set<String> occupied = new HashSet<>();
        for (String existing : names) occupied.add(existing.toLowerCase(Locale.ROOT));
        if (!occupied.contains(name.toLowerCase(Locale.ROOT))) return name;

        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        // Keep -before at the end of the stem so backup files remain recognizable.
        String before = extension.equals(".ledger") && stem.endsWith("-before") ? "-before" : "";
        stem = stem.substring(0, stem.length() - before.length());
        for (int i = 2; i <= 1000; i++) {
            String candidate = stem + " (" + i + ")" + before + extension;
            if (!occupied.contains(candidate.toLowerCase(Locale.ROOT))) return candidate;
        }
        throw new IOException("找不到可用的文件名。");
    }
}
