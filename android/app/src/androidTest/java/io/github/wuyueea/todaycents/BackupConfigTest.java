package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.XmlResourceParser;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.xmlpull.v1.XmlPullParser;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pins the product boundary: this app is offline and its ledger never leaves the
 * device on its own, so it must not participate in Android Auto Backup and must
 * not be copied by Android 12+ device-to-device transfer either.
 */
@RunWith(AndroidJUnit4.class)
public class BackupConfigTest {

    private static final Set<String> EXPECTED_DOMAINS = new LinkedHashSet<>(Arrays.asList(
        "root", "file", "database", "sharedpref", "external"
    ));
    private static final List<String> EXPECTED_SECTIONS = Arrays.asList(
        "cloud-backup", "device-transfer"
    );

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    @Test
    public void allowBackupIsDisabled() throws Exception {
        Context context = context();
        ApplicationInfo info = context.getPackageManager()
            .getApplicationInfo(context.getPackageName(), 0);

        assertEquals(
            "android:allowBackup must be false so the system never uploads the ledger",
            0,
            info.flags & ApplicationInfo.FLAG_ALLOW_BACKUP
        );
    }

    @Test
    public void dataExtractionRulesExcludeEveryDomainFromCloudBackupAndDeviceTransfer() throws Exception {
        Context context = context();
        int rulesId = context.getResources().getIdentifier(
            "data_extraction_rules", "xml", context.getPackageName());
        assertTrue("res/xml/data_extraction_rules.xml must exist", rulesId != 0);

        Map<String, Set<String>> excludesBySection = new LinkedHashMap<>();
        String section = null;
        XmlResourceParser parser = context.getResources().getXml(rulesId);
        try {
            int event;
            while ((event = parser.next()) != XmlPullParser.END_DOCUMENT) {
                if (event != XmlPullParser.START_TAG) continue;

                String name = parser.getName();
                if ("data-extraction-rules".equals(name)) {
                    continue;
                }
                if (EXPECTED_SECTIONS.contains(name)) {
                    section = name;
                    assertFalse("duplicate <" + name + ">", excludesBySection.containsKey(name));
                    excludesBySection.put(name, new LinkedHashSet<String>());
                    continue;
                }
                if ("exclude".equals(name)) {
                    assertNotNull("an <exclude> must be inside a rules section", section);
                    String domain = parser.getAttributeValue(null, "domain");
                    assertNotNull("every <exclude> needs a domain attribute", domain);
                    assertTrue(
                        "duplicate domain " + domain + " in <" + section + ">",
                        excludesBySection.get(section).add(domain)
                    );
                    continue;
                }
                fail("unexpected tag <" + name + "> in data_extraction_rules.xml");
            }
        } finally {
            parser.close();
        }

        assertEquals(
            "both extraction sections are required, in this order",
            EXPECTED_SECTIONS,
            Arrays.asList(excludesBySection.keySet().toArray(new String[0]))
        );
        for (Map.Entry<String, Set<String>> entry : excludesBySection.entrySet()) {
            assertEquals(
                "<" + entry.getKey() + "> must exclude every app data domain",
                EXPECTED_DOMAINS,
                entry.getValue()
            );
        }
    }
}
