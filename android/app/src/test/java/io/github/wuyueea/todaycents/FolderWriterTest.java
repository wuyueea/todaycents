package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class FolderWriterTest {

    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void writesNewFileWithoutLeavingTemporaryFiles() throws Exception {
        File folder = temporary.newFolder("folder");
        File target = new File(folder, "记账本-20261114.ledger");
        byte[] bytes = "第一行\n第二行\n".getBytes(StandardCharsets.UTF_8);

        FolderWriter.writeAtomically(target, bytes);

        assertTrue(target.isFile());
        assertArrayEquals(bytes, Files.readAllBytes(target.toPath()));
        assertTrue(listTemporaryFiles(folder).isEmpty());
    }

    @Test
    public void overwritesExistingFileAndLeavesOnlyTheTarget() throws Exception {
        File folder = temporary.newFolder("folder");
        File target = new File(folder, "记账本-20261114.ledger");
        Files.write(target.toPath(), "一份更长的旧内容".getBytes(StandardCharsets.UTF_8));
        byte[] bytes = "新".getBytes(StandardCharsets.UTF_8);

        FolderWriter.writeAtomically(target, bytes);

        assertArrayEquals(bytes, Files.readAllBytes(target.toPath()));
        assertTrue(listTemporaryFiles(folder).isEmpty());
    }

    @Test
    public void keepsExistingTargetAndCleansUpWhenReplacementFails() throws Exception {
        File folder = temporary.newFolder("folder");
        File target = new File(folder, "记账本-20261114.ledger");
        assertTrue(target.mkdir());
        File child = new File(target, "旧数据.txt");
        Files.write(child.toPath(), "不能被破坏".getBytes(StandardCharsets.UTF_8));

        try {
            FolderWriter.writeAtomically(target, new byte[] {1, 2, 3});
            fail("目标是非空目录时应当写入失败");
        } catch (IOException expected) {
            // 预期：替换失败必须抛出异常，交给插件层 reject。
        }

        assertTrue(target.isDirectory());
        assertEquals("不能被破坏", new String(Files.readAllBytes(child.toPath()), StandardCharsets.UTF_8));
        assertTrue(listTemporaryFiles(folder).isEmpty());
    }

    @Test
    public void removesStaleTemporaryFilesButKeepsFreshOnes() throws Exception {
        File folder = temporary.newFolder("folder");
        File stale = temporaryFile(folder);
        File fresh = temporaryFile(folder);
        Files.write(stale.toPath(), new byte[] {9});
        Files.write(fresh.toPath(), new byte[] {9});
        assertTrue(stale.setLastModified(System.currentTimeMillis() - 2L * 60L * 60L * 1000L));

        FolderWriter.writeAtomically(new File(folder, "记账本-20261114.ledger"), new byte[] {1});

        assertFalse(stale.exists());
        assertTrue(fresh.exists());
    }

    @Test
    public void doesNotDeleteFilesThatOnlyLookLikeTemporaryFiles() throws Exception {
        File folder = temporary.newFolder("folder");
        File impostor = new File(folder, FolderWriter.TEMP_PREFIX + "not-a-uuid" + FolderWriter.TEMP_SUFFIX);
        Files.write(impostor.toPath(), new byte[] {9});
        assertTrue(impostor.setLastModified(System.currentTimeMillis() - 2L * 60L * 60L * 1000L));

        FolderWriter.writeAtomically(new File(folder, "记账本-20261114.ledger"), new byte[] {1});

        assertTrue("只应清理本类生成的临时文件", impostor.exists());
    }

    private File temporaryFile(File folder) {
        return new File(folder, FolderWriter.TEMP_PREFIX + UUID.randomUUID() + FolderWriter.TEMP_SUFFIX);
    }

    private List<File> listTemporaryFiles(File folder) {
        List<File> found = new ArrayList<>();
        File[] files = folder.listFiles();
        if (files == null) {
            return found;
        }
        for (File file : files) {
            String name = file.getName();
            if (name.startsWith(FolderWriter.TEMP_PREFIX) && name.endsWith(FolderWriter.TEMP_SUFFIX)) {
                found.add(file);
            }
        }
        return found;
    }
}
