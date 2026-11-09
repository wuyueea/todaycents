package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class FolderPolicyTest {

    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void safeNamesAllowOrdinaryBackupAndWorkbookNames() {
        assertTrue(FolderPolicy.isSafeName("记账本-20261107.ledger"));
        assertTrue(FolderPolicy.isSafeName("账本 2026.xlsx"));
        assertTrue(FolderPolicy.isSafeName("a.b"));
    }

    @Test
    public void safeNamesRejectDotsPathSeparatorsAndNul() {
        assertFalse(FolderPolicy.isSafeName("."));
        assertFalse(FolderPolicy.isSafeName(".."));
        assertFalse(FolderPolicy.isSafeName("a/b"));
        assertFalse(FolderPolicy.isSafeName("a\\b"));
        assertFalse(FolderPolicy.isSafeName("a\0b"));
    }

    @Test
    public void insideSharedAcceptsRootAndChildren() throws Exception {
        File root = temporary.newFolder("shared");
        File child = new File(root, "Documents/记账本");
        assertTrue(child.mkdirs());

        assertEquals(root.getCanonicalFile(), FolderPolicy.insideShared(root, root));
        assertEquals(child.getCanonicalFile(), FolderPolicy.insideShared(root, child));
    }

    @Test
    public void insideSharedRejectsDotDotAndSiblingPrefix() throws Exception {
        File root = temporary.newFolder("shared");
        File outside = new File(root, "../outside");
        File sibling = new File(root.getParentFile(), root.getName() + "-evil");

        assertNull(FolderPolicy.insideShared(root, outside));
        assertNull(FolderPolicy.insideShared(root, sibling));
    }

    @Test
    public void documentIdUsesPrimaryRootAndSlashSeparatedRelativePath() throws Exception {
        File root = temporary.newFolder("shared");
        File child = new File(root, "Documents/记账本");
        assertTrue(child.mkdirs());

        assertEquals("primary:", FolderPolicy.documentId(root, root));
        assertEquals("primary:Documents/记账本", FolderPolicy.documentId(root, child));
    }

    @Test
    public void documentIdRejectsPathsOutsideSharedStorage() throws Exception {
        File root = temporary.newFolder("shared");
        File outside = new File(root, "../outside");
        File sibling = new File(root.getParentFile(), root.getName() + "-evil");

        assertNull(FolderPolicy.documentId(root, outside));
        assertNull(FolderPolicy.documentId(root, sibling));
    }

    @Test
    public void displayNameUsesInternalStorageForTheRootAndFolderNameForChildren() throws Exception {
        File root = temporary.newFolder("shared");
        File child = new File(root, "记账本");
        assertTrue(child.mkdirs());

        assertEquals(FolderPolicy.INTERNAL_STORAGE, FolderPolicy.displayName(root, root));
        assertEquals("记账本", FolderPolicy.displayName(root, child));
    }
}
