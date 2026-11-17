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
    public void onlyPrimaryOrdinarySubdirectoriesAreSelectable() {
        assertTrue(FolderPolicy.isLocalFolderId("primary:Documents/记账本"));
        assertTrue(FolderPolicy.isLocalFolderId("primary:Download/账本"));
        assertFalse(FolderPolicy.isLocalFolderId("primary:"));
        assertFalse(FolderPolicy.isLocalFolderId("1234-ABCD:Documents"));
        assertFalse(FolderPolicy.isLocalFolderId("primary:Download"));
        assertFalse(FolderPolicy.isLocalFolderId("primary:Android/data"));
        assertFalse(FolderPolicy.isLocalFolderId("primary:Documents/../Android"));
        assertFalse(FolderPolicy.isLocalFolderId("primary:Documents//账本"));
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

}
