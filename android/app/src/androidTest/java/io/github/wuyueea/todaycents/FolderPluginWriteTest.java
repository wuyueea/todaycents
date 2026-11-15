package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.Instrumentation.ActivityMonitor;
import android.app.Instrumentation.ActivityResult;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Base64;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import org.json.JSONArray;

import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public class FolderPluginWriteTest {

    private ActivityScenario<MainActivity> scenario;
    private Bridge bridge;
    private FolderPlugin plugin;
    private File testFolder;

    @Before
    public void setUp() throws Exception {
        grantAllFilesAccess();

        scenario = ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(activity -> {
            bridge = activity.getBridge();
            assertNotNull("MainActivity bridge", bridge);
            plugin = new FolderPlugin();
            plugin.setBridge(bridge);
        });

        testFolder = new File(
            Environment.getExternalStorageDirectory(),
            "Documents/TodayCentsTest-" + UUID.randomUUID()
        );
        assertTrue(testFolder.mkdirs());

        TestCall setFolder = new TestCall("setFolder", new JSObject().put("path", testFolder.getAbsolutePath()));
        plugin.setFolder(setFolder);
        assertNull("setFolder rejected: " + setFolder.rejected, setFolder.rejected);
        assertNotNull("setFolder resolved", setFolder.resolved);
    }

    @After
    public void tearDown() throws Exception {
        if (plugin != null) {
            plugin.clearFolder(new TestCall("clearFolder", new JSObject()));
        }
        if (scenario != null) scenario.close();
        if (testFolder != null) deleteRecursively(testFolder);
    }

    @Test
    public void writesTextAndReportsSaved() throws Exception {
        String name = "记账本-test.ledger";
        byte[] bytes = "hello 世界".getBytes(StandardCharsets.UTF_8);

        TestCall call = write(name, bytes);

        assertNull("writeFile rejected: " + call.rejected, call.rejected);
        assertNotNull("writeFile resolved", call.resolved);
        assertEquals(true, call.resolved.getBoolean("saved", false));
        assertEquals(name, call.resolved.getString("name"));
        assertArrayEquals(bytes, Files.readAllBytes(new File(testFolder, name).toPath()));
    }

    @Test
    public void writesBinaryBytesAndTruncatesAnOlderFile() throws Exception {
        String name = "binary.xlsx";
        byte[] binary = new byte[] { 0, 1, 2, (byte) 0x7f, (byte) 0xff, 10, 13 };
        TestCall first = write(name, binary);
        assertNull(first.rejected);
        assertArrayEquals(binary, Files.readAllBytes(new File(testFolder, name).toPath()));

        byte[] shorter = new byte[] { 9, 8, 7 };
        TestCall second = write(name, shorter);
        assertNull(second.rejected);
        assertArrayEquals(shorter, Files.readAllBytes(new File(testFolder, name).toPath()));
    }

    @Test
    public void writesAtomicallyWithoutLeavingTemporaryFiles() throws Exception {
        String name = "atomic.ledger";
        assertNull(write(name, new byte[] { 1, 2, 3 }).rejected);

        String[] names = testFolder.list();
        assertNotNull(names);
        assertEquals(Arrays.asList(name), Arrays.asList(names));
    }

    @Test
    public void overwritesExistingFileWithoutLeavingTemporaryFiles() throws Exception {
        String name = "覆盖测试.ledger";
        byte[] first = "第一份内容，比较长".getBytes(StandardCharsets.UTF_8);
        byte[] second = "第二份".getBytes(StandardCharsets.UTF_8);

        assertNull(write(name, first).rejected);
        assertNull(write(name, second).rejected);

        assertArrayEquals(second, Files.readAllBytes(new File(testFolder, name).toPath()));
        String[] names = testFolder.list();
        assertNotNull(names);
        assertEquals(Arrays.asList(name), Arrays.asList(names));
    }

    @Test
    public void rejectsWhenTargetCannotBeReplacedAndKeepsItsContents() throws Exception {
        File blocked = new File(testFolder, "blocked.ledger");
        assertTrue(blocked.mkdir());
        File child = new File(blocked, "旧数据.txt");
        Files.write(child.toPath(), "不能被破坏".getBytes(StandardCharsets.UTF_8));

        TestCall call = write(blocked.getName(), new byte[] { 1, 2, 3 });

        assertRejected(call);
        assertTrue(blocked.isDirectory());
        assertEquals("不能被破坏", new String(Files.readAllBytes(child.toPath()), StandardCharsets.UTF_8));
        assertEquals(
            "失败后目录里只应有被封住的目标",
            Arrays.asList(blocked.getName()),
            Arrays.asList(testFolder.list())
        );
    }

    @Test
    public void rejectsBadNamesAndInvalidBase64() {
        TestCall badName = new TestCall("writeFile", new JSObject().put("name", "../escape").put("base64", "eA=="));
        plugin.writeFile(badName);
        assertNotNull("bad name should reject", badName.rejected);

        TestCall invalidBase64 = new TestCall("writeFile", new JSObject().put("name", "x.ledger").put("base64", "a"));
        plugin.writeFile(invalidBase64);
        assertNotNull("invalid base64 should reject", invalidBase64.rejected);

        assertTrue(!new File(testFolder, "x.ledger").exists());
    }


    @Test
    public void setFolderPersistsAndGetFolderReadsItBack() throws Exception {
        File nested = new File(testFolder, "nested-" + UUID.randomUUID());
        assertTrue(nested.mkdirs());

        TestCall set = setFolder(nested.getAbsolutePath());
        assertNull("setFolder rejected: " + set.rejected, set.rejected);
        assertNotNull("setFolder resolved", set.resolved);
        assertEquals(nested.getAbsolutePath(), set.resolved.getString("path"));
        assertEquals(nested.getName(), set.resolved.getString("name"));

        FolderPlugin another = new FolderPlugin();
        another.setBridge(bridge);
        TestCall get = new TestCall("getFolder", new JSObject());
        another.getFolder(get);
        assertNull("getFolder rejected: " + get.rejected, get.rejected);
        assertNotNull("getFolder resolved", get.resolved);
        assertEquals(nested.getAbsolutePath(), get.resolved.getString("path"));
        assertEquals(nested.getName(), get.resolved.getString("name"));
    }

    @Test
    public void setFolderRejectsMissingOutsideEmptyAndFilePaths() throws Exception {
        File missing = new File(testFolder, "missing-" + UUID.randomUUID());
        assertFalse(missing.exists());
        assertRejected(setFolder(missing.getAbsolutePath()));
        assertRejected(setFolder("/data/local/tmp"));
        assertRejected(setFolder(""));

        File regular = new File(testFolder, "regular.txt");
        Files.write(regular.toPath(), new byte[] { 1 });
        assertRejected(setFolder(regular.getAbsolutePath()));

        TestCall get = getFolder();
        assertNull("getFolder rejected: " + get.rejected, get.rejected);
        assertNotNull("getFolder resolved", get.resolved);
        assertEquals(testFolder.getAbsolutePath(), get.resolved.getString("path"));
    }

    @Test
    public void clearFolderForgetsTheRememberedFolder() throws Exception {
        File nested = new File(testFolder, "remembered-" + UUID.randomUUID());
        assertTrue(nested.mkdirs());
        TestCall set = setFolder(nested.getAbsolutePath());
        assertNull("setFolder rejected: " + set.rejected, set.rejected);

        SharedPreferences prefs = plugin.getContext()
            .getSharedPreferences("ledger_storage", Context.MODE_PRIVATE);
        assertEquals(nested.getAbsolutePath(), prefs.getString("folder_path", null));

        TestCall clear = clearFolder();
        assertNull("clearFolder rejected: " + clear.rejected, clear.rejected);
        assertNotNull("clearFolder resolved", clear.resolved);
        assertNull(prefs.getString("folder_path", null));
    }

    @Test
    public void getFolderReturnsNullWhenTheRememberedFolderIsGone() throws Exception {
        File nested = new File(testFolder, "gone-" + UUID.randomUUID());
        assertTrue(nested.mkdirs());
        TestCall set = setFolder(nested.getAbsolutePath());
        assertNull("setFolder rejected: " + set.rejected, set.rejected);
        deleteRecursively(nested);

        TestCall get = getFolder();
        assertNull("getFolder rejected: " + get.rejected, get.rejected);
        assertNotNull("getFolder resolved", get.resolved);
        assertTrue(get.resolved.isNull("path"));
        assertTrue(get.resolved.isNull("name"));
    }


    @Test
    public void listDirsListsOnlyImmediateSubdirectoriesSorted() throws Exception {
        File alpha = new File(testFolder, "alpha");
        File beta = new File(testFolder, "Beta");
        File gamma = new File(testFolder, "gamma");
        File inner = new File(alpha, "inner");
        assertTrue(alpha.mkdirs());
        assertTrue(beta.mkdirs());
        assertTrue(gamma.mkdirs());
        assertTrue(inner.mkdirs());
        Files.write(new File(testFolder, "plain.txt").toPath(), new byte[] { 1 });

        TestCall call = listDirs(testFolder.getAbsolutePath());
        assertNull("listDirs rejected: " + call.rejected, call.rejected);
        assertNotNull("listDirs resolved", call.resolved);
        assertEquals(testFolder.getAbsolutePath(), call.resolved.getString("path"));
        assertEquals(testFolder.getParentFile().getAbsolutePath(), call.resolved.getString("parent"));
        assertEquals(Arrays.asList("alpha", "Beta", "gamma"), dirNames(call));
    }

    @Test
    public void listDirsWithoutPathUsesSharedRoot() throws Exception {
        TestCall missing = listDirs(null);
        assertNull("listDirs rejected: " + missing.rejected, missing.rejected);
        assertNotNull("listDirs resolved", missing.resolved);
        assertEquals(Environment.getExternalStorageDirectory().getAbsolutePath(), missing.resolved.getString("path"));
        assertTrue(missing.resolved.isNull("parent"));
        assertTrue(dirNames(missing).contains("Documents"));

        TestCall empty = listDirs("");
        assertNull("listDirs rejected: " + empty.rejected, empty.rejected);
        assertNotNull("listDirs resolved", empty.resolved);
        assertEquals(Environment.getExternalStorageDirectory().getAbsolutePath(), empty.resolved.getString("path"));
        assertTrue(empty.resolved.isNull("parent"));
    }

    @Test
    public void listDirsRejectsOutsideMissingAndFilePaths() throws Exception {
        assertRejected(listDirs("/data/local/tmp"));

        File absent = new File(testFolder, "missing-" + UUID.randomUUID());
        assertFalse(absent.exists());
        assertRejected(listDirs(absent.getAbsolutePath()));

        File regular = new File(testFolder, "regular.txt");
        Files.write(regular.toPath(), new byte[] { 1 });
        assertRejected(listDirs(regular.getAbsolutePath()));
    }

    @Test
    public void requestStorageAccessLaunchesSettingsAndRunsTheCallbackAfterReturning() throws Exception {
        // Android kills the target process when MANAGE_EXTERNAL_STORAGE changes,
        // so requestAccess's denied branch cannot be exercised in-process. This
        // covers the activity-result plumbing that requestAccess uses instead.
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        ActivityMonitor monitor = null;
        final Intent[] launched = new Intent[1];
        final AtomicBoolean callbackRan = new AtomicBoolean(false);
        try {
            monitor = new ActivityMonitor() {
                @Override
                public ActivityResult onStartActivity(Intent intent) {
                    if (!Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION.equals(intent.getAction())) {
                        return null;
                    }
                    if (!("package:" + targetPackage()).equals(intent.getDataString())) return null;
                    launched[0] = new Intent(intent);
                    return new ActivityResult(Activity.RESULT_OK, null);
                }
            };
            instrumentation.addMonitor(monitor);

            scenario.onActivity(activity -> activity.requestStorageAccess(() -> callbackRan.set(true)));
            for (int i = 0; i < 40 && !callbackRan.get(); i++) {
                SystemClock.sleep(50);
            }

            assertTrue("callback should run when the settings page returns", callbackRan.get());
            assertEquals("settings page should be intercepted once", 1, monitor.getHits());
            assertNotNull("settings intent was not started", launched[0]);
            assertEquals(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, launched[0].getAction());
            assertEquals("package:" + targetPackage(), launched[0].getDataString());
        } finally {
            if (monitor != null) instrumentation.removeMonitor(monitor);
        }
    }

    @Test
    public void requestAccessResolvesImmediatelyWhenAccessIsAlreadyGranted() throws Exception {
        Assume.assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        ActivityMonitor monitor = new ActivityMonitor() {
            @Override
            public ActivityResult onStartActivity(Intent intent) {
                if (!Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION.equals(intent.getAction())) {
                    return null;
                }
                return new ActivityResult(Activity.RESULT_OK, null);
            }
        };
        instrumentation.addMonitor(monitor);
        try {
            TestCall call = new TestCall("requestAccess", new JSObject());
            scenario.onActivity(activity -> plugin.requestAccess(call));
            waitForCall(call);

            assertNull("requestAccess rejected: " + call.rejected, call.rejected);
            assertNotNull("requestAccess should resolve", call.resolved);
            assertTrue("already granted", call.resolved.getBoolean("granted", false));
            assertEquals("must not open settings when access is already granted", 0, monitor.getHits());
        } finally {
            instrumentation.removeMonitor(monitor);
        }
    }

    @Test
    public void openFolderSendsTheFolderDocumentUriToTheFilesApp() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        final Intent[] launched = new Intent[1];
        ActivityMonitor monitor = new ActivityMonitor() {
            @Override
            public ActivityResult onStartActivity(Intent intent) {
                Uri data = intent.getData();
                if (!Intent.ACTION_VIEW.equals(intent.getAction())) return null;
                if (!"com.android.documentsui".equals(intent.getPackage())) return null;
                if (data == null || !"content".equals(data.getScheme())) return null;
                if (!"com.android.externalstorage.documents".equals(data.getAuthority())) return null;
                launched[0] = new Intent(intent);
                return new ActivityResult(Activity.RESULT_OK, null);
            }
        };
        instrumentation.addMonitor(monitor);
        try {
            TestCall call = new TestCall("openFolder", new JSObject());
            scenario.onActivity(activity -> plugin.openFolder(call));
            waitForCall(call);

            assertNull("openFolder rejected: " + call.rejected, call.rejected);
            assertNotNull("openFolder should resolve", call.resolved);
            assertTrue("folder should open", call.resolved.getBoolean("opened", false));
            assertEquals("direct Files app intent should be sent once", 1, monitor.getHits());
            assertNotNull("Files app intent was not started", launched[0]);
            assertEquals(Intent.ACTION_VIEW, launched[0].getAction());
            assertEquals("com.android.documentsui", launched[0].getPackage());
            assertEquals(DocumentsContract.Document.MIME_TYPE_DIR, launched[0].getType());
            String expectedDocId = FolderPolicy.documentId(
                Environment.getExternalStorageDirectory(),
                testFolder
            );
            assertNotNull("test folder should map to a document id", expectedDocId);
            assertEquals(expectedDocId, DocumentsContract.getDocumentId(launched[0].getData()));
            assertEquals("com.android.externalstorage.documents", launched[0].getData().getAuthority());
            assertEquals(0, launched[0].getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } finally {
            instrumentation.removeMonitor(monitor);
        }
    }

    private TestCall listDirs(String path) {
        JSObject data = new JSObject();
        if (path != null) data.put("path", path);
        TestCall call = new TestCall("listDirs", data);
        plugin.listDirs(call);
        return call;
    }

    private static List<String> dirNames(TestCall call) throws Exception {
        JSONArray dirs = call.resolved.getJSONArray("dirs");
        List<String> names = new ArrayList<>();
        for (int index = 0; index < dirs.length(); index++) {
            names.add(dirs.getJSONObject(index).getString("name"));
        }
        return names;
    }

    private TestCall setFolder(String path) {
        TestCall call = new TestCall("setFolder", new JSObject().put("path", path));
        plugin.setFolder(call);
        return call;
    }

    private TestCall getFolder() {
        TestCall call = new TestCall("getFolder", new JSObject());
        plugin.getFolder(call);
        return call;
    }

    private TestCall clearFolder() {
        TestCall call = new TestCall("clearFolder", new JSObject());
        plugin.clearFolder(call);
        return call;
    }

    private static void assertRejected(TestCall call) {
        assertNotNull("expected rejection", call.rejected);
        assertNull("expected no resolution", call.resolved);
    }

    private TestCall write(String name, byte[] bytes) {
        JSObject data = new JSObject()
            .put("name", name)
            .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
        TestCall call = new TestCall("writeFile", data);
        plugin.writeFile(call);
        return call;
    }

    private static void waitForCall(TestCall call) {
        for (int i = 0; i < 40 && call.resolved == null && call.rejected == null; i++) {
            SystemClock.sleep(50);
        }
    }

    private static String targetPackage() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName();
    }

    private static void setAllFilesAccess(boolean granted) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        ParcelFileDescriptor fd = InstrumentationRegistry.getInstrumentation()
            .getUiAutomation()
            .executeShellCommand(
                "appops set " + targetPackage() + " MANAGE_EXTERNAL_STORAGE " + (granted ? "allow" : "deny")
            );
        try {
            Thread.sleep(300);
        } finally {
            fd.close();
        }
        for (int i = 0; i < 30 && Environment.isExternalStorageManager() != granted; i++) {
            SystemClock.sleep(100);
        }
        assertEquals(
            "MANAGE_EXTERNAL_STORAGE should be " + (granted ? "allowed" : "denied"),
            granted,
            Environment.isExternalStorageManager()
        );
    }

    private static void grantAllFilesAccess() throws Exception {
        setAllFilesAccess(true);
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        if (!file.delete()) fail("could not delete " + file);
    }

    private static final class TestCall extends PluginCall {
        private JSObject resolved;
        private String rejected;

        TestCall(String methodName, JSObject data) {
            super(null, "Folder", "test-callback", methodName, data);
        }

        @Override
        public void resolve(JSObject data) {
            this.resolved = data;
        }

        @Override
        public void resolve() {
            this.resolved = new JSObject();
        }

        @Override
        public void reject(String message) {
            this.rejected = message;
        }
    }
}
