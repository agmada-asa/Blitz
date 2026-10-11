/** Renders safe Markdown using native text, with scrollable code and tables. */
import { memo, type ReactNode } from "react"
import {
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native"
import type { Token, Tokens } from "marked"
import { markdownHref, markdownText, parseMarkdown, type MathToken } from "../../lib/markdown"
import { mathToText } from "../../lib/math-text"
import { Text } from "./native-text"

/** Opens only validated web/email links and reports unavailable handlers. */
function openLink(href: string) {
  void Linking.openURL(href).catch(() => Alert.alert("Could not open link"))
}

/** Keeps inline formatting within Text so sentences wrap naturally. */
function inline(tokens: Token[]): ReactNode {
  return tokens.map((token, key) => {
    const children =
      "tokens" in token && token.tokens
        ? inline(token.tokens ?? [])
        : markdownText("text" in token ? token.text : token.raw)
    switch (token.type) {
      case "strong":
        return (
          <Text key={key} style={styles.strong}>
            {children}
          </Text>
        )
      case "em":
        return (
          <Text key={key} style={styles.em}>
            {children}
          </Text>
        )
      case "del":
        return (
          <Text key={key} style={styles.del}>
            {children}
          </Text>
        )
      case "codespan":
        return (
          <Text key={key} style={styles.code}>
            {token.text}
          </Text>
        )
      case "br":
        return "\n"
      case "math":
        // Formulas cannot be typeset natively; show them as readable Unicode.
        return (
          <Text key={key} style={styles.math}>
            {mathToText((token as unknown as MathToken).text)}
          </Text>
        )
      case "link": {
        // Source citations open in the desktop reader; here they read as a quiet label.
        if (token.href.startsWith("citation:"))
          return (
            <Text key={key} style={styles.citation}>
              {children}
            </Text>
          )
        const href = markdownHref(token.href)
        return href ? (
          <Text
            key={key}
            accessibilityRole="link"
            style={styles.link}
            onPress={() => openLink(href)}
          >
            {children}
          </Text>
        ) : (
          children
        )
      }
      default:
        return <Text key={key}>{children}</Text>
    }
  })
}

/** Preserves block structure while keeping wide content inside the chat width. */
function blocks(tokens: Token[]): ReactNode {
  return tokens.map((token, key) => {
    switch (token.type) {
      case "space":
        return null
      case "heading":
        return (
          <Text
            key={key}
            selectable
            accessibilityRole="header"
            style={[
              styles.text,
              styles.strong,
              { fontSize: token.depth === 1 ? 20 : 17 },
            ]}
          >
            {inline(token.tokens ?? [])}
          </Text>
        )
      case "paragraph":
      case "text":
        return (
          <Text key={key} selectable style={styles.text}>
            {token.tokens
              ? inline(token.tokens ?? [])
              : markdownText(token.text)}
          </Text>
        )
      case "code":
        return (
          <ScrollView key={key} horizontal style={styles.codeBlock}>
            <Text
              selectable
              style={[styles.text, styles.code, styles.codeContent]}
            >
              {token.text}
            </Text>
          </ScrollView>
        )
      case "blockquote":
        return (
          <View key={key} style={styles.quote}>
            {blocks(token.tokens ?? [])}
          </View>
        )
      case "hr":
        return <View key={key} style={styles.rule} />
      case "math":
        return (
          <Text key={key} selectable style={[styles.text, styles.math, styles.mathBlock]}>
            {mathToText((token as unknown as MathToken).text)}
          </Text>
        )
      case "list":
        return (
          <View key={key} style={styles.blocks}>
            {(token.items as Tokens.ListItem[]).map((item, i) => (
              <View key={i} style={styles.listItem}>
                <Text style={styles.text}>
                  {item.task
                    ? item.checked
                      ? "☑"
                      : "☐"
                    : token.ordered
                      ? `${Number(token.start) + i}.`
                      : "•"}
                </Text>
                <View style={styles.listContent}>{blocks(item.tokens)}</View>
              </View>
            ))}
          </View>
        )
      case "table":
        return (
          <ScrollView key={key} horizontal>
            <View>
              {[token.header, ...token.rows].map(
                (row: Tokens.TableCell[], i: number) => (
                  <View key={i} style={styles.tableRow}>
                    {row.map((cell, j) => (
                      <Text
                        key={j}
                        selectable
                        style={[
                          styles.text,
                          styles.cell,
                          i === 0 && styles.strong,
                        ]}
                      >
                        {inline(cell.tokens)}
                      </Text>
                    ))}
                  </View>
                )
              )}
            </View>
          </ScrollView>
        )
      default:
        return (
          <Text key={key} selectable style={styles.text}>
            {markdownText(token.raw)}
          </Text>
        )
    }
  })
}

/** Reuses parsed output for unchanged replies; incomplete Markdown remains readable during streaming. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <View style={styles.blocks}>{blocks(parseMarkdown(text, { math: true }))}</View>
})

const styles = StyleSheet.create({
  blocks: { gap: 10, minWidth: 0 },
  text: { color: "#cccccc", fontSize: 15, lineHeight: 24 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  code: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 13,
    backgroundColor: "#ffffff0d",
  },
  codeBlock: { backgroundColor: "#101010", borderRadius: 8 },
  codeContent: { padding: 12, backgroundColor: "transparent" },
  link: { color: "#ff8065", textDecorationLine: "underline" },
  math: { color: "#f0f0f0", fontStyle: "italic" },
  citation: { color: "#ff8065", fontSize: 12 },
  mathBlock: { textAlign: "center", paddingVertical: 4 },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: "#ff8065",
    paddingLeft: 12,
    gap: 8,
  },
  rule: { height: 1, backgroundColor: "#ffffff26" },
  listItem: { flexDirection: "row", gap: 8 },
  listContent: { flex: 1, gap: 6 },
  tableRow: { flexDirection: "row" },
  cell: { width: 160, padding: 10, borderWidth: 0.5, borderColor: "#ffffff26" },
})
