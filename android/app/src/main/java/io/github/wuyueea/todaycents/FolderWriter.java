package io.github.wuyueea.todaycents;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.UUID;

/**
 * 以临时文件 + fsync + 原子替换的方式写入用户文件夹中的文件。
 *
 * <p>备份文件是离线账本唯一的恢复来源，写入过程中不能被截断或写坏：
 * 先把内容写进同目录的临时文件并 sync，再原子替换目标文件。
 * 目标文件已存在时，替换成功之前旧文件始终完整；任何一步失败都保留旧文件，
 * 只清理本次临时文件。
 *
 * <p>必须使用 {@link StandardCopyOption#ATOMIC_MOVE}：Android libcore 的
 * {@code sun.nio.fs.UnixCopyFile.move} 在设置了 {@code REPLACE_EXISTING} 时会先
 * {@code unlink} 目标再 {@code rename}，旧文件会短暂消失，失败时直接丢失；
 * 只有 atomicMove 分支才直接调用 {@code rename(2)}，由内核原子替换已有目标。
 *
 * <p>边界：临时文件内容已 fsync，但没有对父目录做 fsync。整机掉电时目录项可能
 * 回退（最坏是保留旧文件）或残留临时文件；不宣称“返回成功即掉电持久化”。
 */
final class FolderWriter {

    static final String TEMP_PREFIX = ".ledger-writing-";
    static final String TEMP_SUFFIX = ".tmp";
    private static final long STALE_TEMP_MILLIS = 60L * 60L * 1000L;

    private FolderWriter() {
    }

    /**
     * 把 {@code bytes} 原子写入 {@code target}。
     *
     * @param target 已由调用方校验过的目标文件（父目录必须存在且可写）
     * @throws IOException 写入或替换失败；此时目标文件保持原样
     */
    static void writeAtomically(File target, byte[] bytes) throws IOException {
        File folder = target.getParentFile();
        if (folder == null) {
            throw new IOException("目标文件没有父目录。");
        }
        removeStaleTemporaryFiles(folder);

        File temporary = new File(folder, TEMP_PREFIX + UUID.randomUUID() + TEMP_SUFFIX);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write(bytes);
                output.flush();
                output.getFD().sync();
            }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);
        } finally {
            // 替换成功后临时文件已不存在；失败时清理，目标文件保持原样。
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
        }
    }

    private static void removeStaleTemporaryFiles(File folder) {
        File[] files = folder.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - STALE_TEMP_MILLIS;
        for (File file : files) {
            if (isTemporaryFile(file.getName()) && file.lastModified() < cutoff) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    /**
     * 只认本类生成的临时文件名（前缀 + UUID + 后缀），避免误删文件夹里
     * 用户或其它程序放入的同前后缀文件。
     */
    private static boolean isTemporaryFile(String name) {
        if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) {
            return false;
        }
        String middle = name.substring(TEMP_PREFIX.length(), name.length() - TEMP_SUFFIX.length());
        if (middle.length() != 36) {
            return false;
        }
        try {
            UUID.fromString(middle);
            return true;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }
}
