package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;

import org.junit.Test;
import org.w3c.dom.Element;

/**
 * 在 JVM 上直接检查打包前的 AndroidManifest.xml 与备份规则资源。
 *
 * <p>仪器测试 BackupConfigTest 只读「已安装包」的标志与编译后资源：如果
 * AndroidManifest.xml 里的 dataExtractionRules 接线被删掉，那两条测试仍会全绿，
 * 而 Android 12+ 的设备到设备迁移会重新带走账本。这里直接读源码文件，锁住
 * manifest → @xml/data_extraction_rules 的绑定。
 */
public class BackupConfigSourceTest {

    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    /** Android 12+ 备份/迁移流程遍历的五个 CE 应用数据域。 */
    private static final Set<String> EXCLUDED_DOMAINS =
            new LinkedHashSet<String>(Arrays.asList("root", "file", "database", "sharedpref", "external"));

    @Test
    public void manifestDisablesBackupAndWiresExtractionRules() throws Exception {
        Element application = AndroidSourceFiles.onlyChild(
                AndroidSourceFiles.documentOf("src/main/AndroidManifest.xml").getDocumentElement(),
                "application");

        assertEquals("false", application.getAttributeNS(ANDROID_NS, "allowBackup"));
        assertEquals("@xml/data_extraction_rules", application.getAttributeNS(ANDROID_NS, "dataExtractionRules"));
    }

    @Test
    public void extractionRulesExcludeEveryDomainFromCloudBackupAndDeviceTransfer() throws Exception {
        Element root = AndroidSourceFiles
                .documentOf("src/main/res/xml/data_extraction_rules.xml")
                .getDocumentElement();
        assertEquals("data-extraction-rules", root.getTagName());

        for (String section : Arrays.asList("cloud-backup", "device-transfer")) {
            Element sectionElement = AndroidSourceFiles.onlyChild(root, section);
            Set<String> domains = new LinkedHashSet<String>();
            for (Element exclude : AndroidSourceFiles.children(sectionElement, "exclude")) {
                domains.add(exclude.getAttribute("domain"));
            }
            assertTrue(section + " 未排除全部应用数据域，实际为 " + domains, domains.containsAll(EXCLUDED_DOMAINS));
        }
    }

}
