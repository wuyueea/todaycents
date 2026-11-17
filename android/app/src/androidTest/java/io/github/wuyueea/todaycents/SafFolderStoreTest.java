package io.github.wuyueea.todaycents;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.IOException;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** The native store must never confuse a remembered value with a system grant. */
@RunWith(AndroidJUnit4.class)
public class SafFolderStoreTest {
    private static final String LOCAL = "com.android.externalstorage.documents";
    private static final int RW = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private Context context;
    private SharedPreferences prefs;
    private SafFolderStore store;

    @Before public void setUp() throws IOException {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        prefs = context.getSharedPreferences("ledger_storage", Context.MODE_PRIVATE);
        store = new SafFolderStore(context);
        // This suite is installed only under the dedicated debug application ID.
        assertEquals("app.ledger.local", context.getPackageName());
        store.clear();
    }

    @After public void tearDown() throws IOException {
        if (store != null && "app.ledger.local".equals(context.getPackageName())) store.clear();
    }

    private void rejectSelection(Uri uri, int flags) {
        assertThrows(IOException.class, () -> store.select(new Intent().setData(uri).addFlags(flags), () -> true));
        assertFalse(store.status().has("name"));
    }

    @Test public void oldPathOnlySuppliesPickerHint() throws Exception {
        prefs.edit().putString("folder_path", android.os.Environment.getExternalStorageDirectory()
            + "/Documents/旧目录").commit();
        assertTrue(store.status().getBoolean("needsReselection"));
        assertThrows(IOException.class, () -> store.write("账本.ledger", new byte[]{1}));
        Intent picker = SafFolderStore.picker(context);
        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, picker.getAction());
        assertTrue(picker.getBooleanExtra(Intent.EXTRA_LOCAL_ONLY, false));
        assertEquals(RW, picker.getFlags() & RW);
        assertNotEquals(0, picker.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        Uri initial = picker.getParcelableExtra(DocumentsContract.EXTRA_INITIAL_URI);
        assertEquals("primary:Documents/旧目录", DocumentsContract.getDocumentId(initial));
    }

    @Test public void rememberedUriWithoutGrantCannotBeOpenedOrWritten() throws Exception {
        Uri tree = DocumentsContract.buildTreeDocumentUri(LOCAL, "primary:Documents/合成目录");
        prefs.edit().putString("folder_tree_uri", tree.toString()).commit();
        assertTrue(store.status().getBoolean("needsReselection"));
        assertNull(store.openIntent());
        assertThrows(IOException.class, () -> store.write("账本.ledger", new byte[]{1}));
        store.clear();
        assertFalse(store.status().getBoolean("needsReselection"));
    }

    @Test public void rejectsCloudProviderRestrictedDirectoryAndReadOnlyResult() {
        rejectSelection(DocumentsContract.buildTreeDocumentUri("fake.cloud", "primary:Documents/Test"), RW);
        rejectSelection(DocumentsContract.buildTreeDocumentUri(LOCAL, "primary:"), RW);
        rejectSelection(DocumentsContract.buildTreeDocumentUri(LOCAL, "primary:Android/data"), RW);
        rejectSelection(DocumentsContract.buildTreeDocumentUri(LOCAL, "primary:Download"), RW);
        rejectSelection(DocumentsContract.buildTreeDocumentUri(LOCAL, "primary:Documents/Test"),
            Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    @Test public void stalePickerResultKeepsTheExistingChoiceForReselection() throws Exception {
        prefs.edit().putString("folder_path", "/storage/emulated/0/Documents/保留").commit();
        Uri tree = DocumentsContract.buildTreeDocumentUri(LOCAL, "primary:Documents/合成目录");
        assertThrows(IOException.class, () -> store.select(new Intent().setData(tree).addFlags(RW), () -> false));
        assertTrue(store.status().getBoolean("needsReselection"));
        assertFalse(prefs.contains("folder_tree_uri"));
    }
}
