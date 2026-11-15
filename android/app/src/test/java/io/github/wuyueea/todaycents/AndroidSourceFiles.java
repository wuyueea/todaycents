package io.github.wuyueea.todaycents;

import static org.junit.Assert.assertNotNull;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * 在 JVM 上读取 android/app 下的源码文件，供打包前检查 manifest 与资源。
 *
 * <p>两个测试类共用这里的解析助手：一遍 XML 解析的方式只应存在一处，否则
 * 两条测试可能对「manifest 是否真的接线」给出不同答案。
 */
final class AndroidSourceFiles {

    private AndroidSourceFiles() {
    }

    static Document documentOf(String androidRelativePath) throws Exception {
        File file = androidSourceFile(androidRelativePath);
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        Document document = factory.newDocumentBuilder().parse(file);
        assertNotNull(document.getDocumentElement());
        return document;
    }

    /**
     * 从当前工作目录向上找 android/app/&lt;androidRelativePath&gt;。
     * 直接跑 JUnitCore 时工作目录是仓库根；Gradle 单测工作目录是 android/app。
     */
    static File androidSourceFile(String androidRelativePath) {
        File start = new File(System.getProperty("user.dir"));
        for (File dir = start; dir != null; dir = dir.getParentFile()) {
            File direct = new File(dir, androidRelativePath);
            if (direct.isFile()) {
                return direct;
            }
            File module = new File(dir, "android/app/" + androidRelativePath);
            if (module.isFile()) {
                return module;
            }
        }
        throw new AssertionError("从 " + start + " 找不到 android/app/" + androidRelativePath);
    }

    static Element onlyChild(Element parent, String tagName) {
        NodeList nodes = parent.getChildNodes();
        Element found = null;
        for (int i = 0; i < nodes.getLength(); i++) {
            Node node = nodes.item(i);
            if (node.getNodeType() == Node.ELEMENT_NODE && tagName.equals(((Element) node).getTagName())) {
                if (found != null) {
                    throw new AssertionError("重复的 <" + tagName + ">");
                }
                found = (Element) node;
            }
        }
        if (found == null) {
            throw new AssertionError("缺少 <" + tagName + ">");
        }
        return found;
    }

    static List<Element> children(Element parent, String tagName) {
        List<Element> found = new ArrayList<Element>();
        NodeList nodes = parent.getChildNodes();
        for (int i = 0; i < nodes.getLength(); i++) {
            Node node = nodes.item(i);
            if (node.getNodeType() == Node.ELEMENT_NODE && tagName.equals(((Element) node).getTagName())) {
                found.add((Element) node);
            }
        }
        return found;
    }
}
