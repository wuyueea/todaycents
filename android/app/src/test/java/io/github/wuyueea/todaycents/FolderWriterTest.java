package io.github.wuyueea.todaycents;

import static org.junit.Assert.*;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public class FolderWriterTest {
    private static final class Target implements FolderWriter.Destination<String> {
        final Map<String, byte[]> documents = new HashMap<>();
        final List<String> operations = new ArrayList<>();
        boolean failWrite;
        boolean failPublish;

        @Override public String createTemporary() {
            operations.add("create");
            documents.put("test.tmp", new byte[0]);
            return "test.tmp";
        }
        @Override public void writeAndSync(String temporary, byte[] bytes) throws IOException {
            operations.add("write");
            if (failWrite) {
                documents.put(temporary, new byte[]{bytes[0]});
                throw new IOException("short write");
            }
            documents.put(temporary, bytes);
        }
        @Override public Set<String> names() { return documents.keySet(); }
        @Override public String publish(String temporary, String name) throws IOException {
            operations.add("publish");
            if (failPublish || documents.containsKey(name)) throw new IOException("rename failed");
            documents.put(name, documents.remove(temporary));
            return name;
        }
        @Override public void discard(String temporary) {
            operations.add("discard");
            documents.remove(temporary);
        }
    }

    @Test public void publishesNewWorkbookAfterWritingWithoutTouchingExistingFiles() throws Exception {
        Target target = new Target();
        byte[] old = {1};
        byte[] bytes = {0, (byte) 255};
        target.documents.put("报表.xlsx", old);
        target.documents.put("报表 (2).xlsx", old);
        assertEquals("报表 (3).xlsx", FolderWriter.writeNew(target, "报表.xlsx", bytes));
        assertArrayEquals(bytes, target.documents.get("报表 (3).xlsx"));
        assertArrayEquals(old, target.documents.get("报表.xlsx"));
        assertArrayEquals(old, target.documents.get("报表 (2).xlsx"));
        assertEquals(List.of("create", "write", "publish"), target.operations);
        assertFalse(target.documents.containsKey("test.tmp"));
    }

    @Test public void numberedBeforeCopyRetainsMarkerAndExtension() throws Exception {
        Target target = new Target();
        target.documents.put("账本-before.ledger", new byte[]{1});
        assertEquals("账本 (2)-before.ledger", FolderWriter.writeNew(target, "账本-before.ledger", new byte[]{2}));
    }

    @Test public void partialWriteNeverPublishesAndOnlyDiscardsItsTemporaryFile() {
        Target target = new Target();
        target.failWrite = true;
        byte[] old = {1, 2, 3};
        target.documents.put("账本.ledger", old);
        assertThrows(IOException.class, () -> FolderWriter.writeNew(target, "账本.ledger", new byte[]{4, 5}));
        assertEquals(List.of("create", "write", "discard"), target.operations);
        assertEquals(Set.of("账本.ledger"), target.documents.keySet());
        assertArrayEquals(old, target.documents.get("账本.ledger"));
    }

    @Test public void failedRenameKeepsExistingFileAndDiscardsOnlyItsOwnTemporaryFile() {
        Target target = new Target();
        target.failPublish = true;
        target.documents.put("账本.ledger", new byte[]{1});
        target.documents.put("someone-elses.tmp", new byte[]{2});
        assertThrows(IOException.class, () -> FolderWriter.writeNew(target, "账本.ledger", new byte[]{9}));
        assertEquals(Set.of("账本.ledger", "someone-elses.tmp"), target.documents.keySet());
        assertArrayEquals(new byte[]{1}, target.documents.get("账本.ledger"));
    }

    @Test public void rejectsUnsafeNameBeforeCreatingAnyDocument() {
        Target target = new Target();
        assertThrows(IOException.class, () -> FolderWriter.writeNew(target, "../账本.ledger", new byte[]{1}));
        assertTrue(target.operations.isEmpty());
    }
}
