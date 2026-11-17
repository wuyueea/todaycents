package io.github.wuyueea.todaycents;

import static org.junit.Assert.*;
import org.junit.Test;
import org.w3c.dom.Element;

/** Manifest guard in addition to checking the actual merged APK permissions. */
public class StorageConfigSourceTest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    @Test public void manifestHasNoBroadStorageOrInternetPermissions() throws Exception {
        Element manifest = AndroidSourceFiles.documentOf("src/main/AndroidManifest.xml").getDocumentElement();
        for (Element permission : AndroidSourceFiles.children(manifest, "uses-permission")) {
            String name = permission.getAttributeNS(ANDROID_NS, "name");
            assertFalse(name, name.equals("android.permission.MANAGE_EXTERNAL_STORAGE")
                || name.equals("android.permission.READ_EXTERNAL_STORAGE")
                || name.equals("android.permission.WRITE_EXTERNAL_STORAGE")
                || name.equals("android.permission.INTERNET")
                || name.startsWith("android.permission.READ_MEDIA_"));
        }
    }

    @Test public void manifestDoesNotOptOutOfScopedStorage() throws Exception {
        Element app = AndroidSourceFiles.onlyChild(
            AndroidSourceFiles.documentOf("src/main/AndroidManifest.xml").getDocumentElement(), "application");
        assertFalse(app.hasAttributeNS(ANDROID_NS, "requestLegacyExternalStorage"));
    }
}
