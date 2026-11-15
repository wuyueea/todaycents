package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.Test;
import org.w3c.dom.Element;

/**
 * 在 JVM 上检查打包前的存储权限配置。
 *
 * <p>仪器测试依赖真机与已安装包，本机暂时离线；这里直接读源码，锁住
 * Android 10（API 29）需要的两件事：读写权限声明覆盖 API 29，以及
 * requestLegacyExternalStorage 让 targetSdk 35 的应用在 Android 10 上
 * 仍能走旧版存储模型。少了任何一个，Android 10 的文件夹备份都会静默失效。
 */
public class StorageConfigSourceTest {

    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
    private static final String READ = "android.permission.READ_EXTERNAL_STORAGE";
    private static final String WRITE = "android.permission.WRITE_EXTERNAL_STORAGE";

    @Test
    public void runtimeStoragePermissionsCoverAndroid10() throws Exception {
        Element manifest = AndroidSourceFiles
                .documentOf("src/main/AndroidManifest.xml")
                .getDocumentElement();
        Map<String, Element> permissions = permissionsByName(manifest);

        for (String name : new String[] { READ, WRITE }) {
            Element permission = permissions.get(name);
            assertNotNull(name + " 未在 manifest 中声明", permission);
            assertEquals(name + " 的 maxSdkVersion 需要覆盖 API 29",
                    "29", permission.getAttributeNS(ANDROID_NS, "maxSdkVersion"));
        }
    }

    @Test
    public void manifestRequestsLegacyExternalStorageForAndroid10() throws Exception {
        Element application = AndroidSourceFiles.onlyChild(
                AndroidSourceFiles.documentOf("src/main/AndroidManifest.xml").getDocumentElement(),
                "application");

        assertEquals("Android 10 需要 requestLegacyExternalStorage 才能直写普通目录",
                "true", application.getAttributeNS(ANDROID_NS, "requestLegacyExternalStorage"));
    }

    private static Map<String, Element> permissionsByName(Element manifest) {
        Map<String, Element> byName = new LinkedHashMap<String, Element>();
        for (Element permission : AndroidSourceFiles.children(manifest, "uses-permission")) {
            byName.put(permission.getAttributeNS(ANDROID_NS, "name"), permission);
        }
        return byName;
    }
}
