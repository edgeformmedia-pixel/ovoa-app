import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View, type NativeScrollEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Btn } from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog } from "../lib/devlog";
import { TERMS, TERMS_UPDATED, TERMS_VERSION } from "../lib/terms";
import { colors, space, type } from "../lib/theme";

// The Terms of Service (2026-09-24), in full.
//
// A step at first open, straight after the email is proven (app/_layout.tsx):
// the whole text, and Agree turns on only once it has been scrolled to the end.
// Not agreeing is signing out; there's no app without them. The server keeps
// when, and which wording (api/src/terms.ts); a new wording (TERMS_VERSION)
// asks everyone again. Opened from Settings → App & help once agreed, it's the
// same text to read, with Close.

/** How near the end counts as the end: the last line is on screen. */
const END_SLACK = 48;

const reachedEnd = ({ layoutMeasurement, contentOffset, contentSize }: NativeScrollEvent) =>
  layoutMeasurement.height + contentOffset.y >= contentSize.height - END_SLACK;

export default function Terms() {
  const router = useRouter();
  const { token, user, refreshUser, signOut } = useSession();
  const [atEnd, setAtEnd] = useState(false);
  const viewHeight = useRef(0);
  const contentHeight = useRef(0);
  const fits = () => {
    if (viewHeight.current > 0 && contentHeight.current > 0 && contentHeight.current <= viewHeight.current + END_SLACK) setAtEnd(true);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agreed = !!user?.terms?.accepted;
  const agreedOn = user?.terms?.at
    ? new Date(user.terms.at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })
    : null;

  const agree = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.agreeToTerms(token, TERMS_VERSION);
      devlog("log", `terms: agreed to version ${TERMS_VERSION}`);
      // The next step comes up by itself once GET /me says so (app/_layout.tsx).
      await refreshUser();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.page}
        scrollEventThrottle={100}
        onScroll={(e) => {
          if (!atEnd && reachedEnd(e.nativeEvent)) setAtEnd(true);
        }}
        // Text that fits without scrolling (a large screen, a small font) is already read to the end.
        onLayout={(e) => {
          viewHeight.current = e.nativeEvent.layout.height;
          fits();
        }}
        onContentSizeChange={(_w, h) => {
          contentHeight.current = h;
          fits();
        }}
      >
        <Text style={styles.title}>Terms of Service</Text>
        <Text style={styles.lead}>
          {agreed
            ? `You agreed${agreedOn ? ` on ${agreedOn}` : ""}. Last updated ${TERMS_UPDATED}.`
            : `Please read these to the end. Agree turns on once you've reached it. Last updated ${TERMS_UPDATED}.`}
        </Text>
        {TERMS.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.heading}>{section.title}</Text>
            {section.paragraphs.map((p, i) => (
              <Text key={i} style={styles.body}>
                {p}
              </Text>
            ))}
          </View>
        ))}
        <Text style={styles.end}>End of the Terms of Service.</Text>
      </ScrollView>

      <View style={styles.foot}>
        {error && <Text style={styles.error}>{error}</Text>}
        {agreed ? (
          <Btn label="Close" kind="go" onPress={() => (router.canGoBack() ? router.back() : router.replace("/settings"))} />
        ) : (
          <>
            <Btn label={atEnd ? "I agree" : "Scroll to the end to agree"} kind="go" onPress={() => void agree()} busy={busy} disabled={!atEnd} />
            <Btn label="I don't agree (sign out)" kind="quiet" onPress={signOut} disabled={busy} />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  page: { paddingHorizontal: space.s6, paddingTop: space.s8, paddingBottom: space.s6, gap: space.s4 },
  title: { ...type.title, color: colors.ink },
  lead: { ...type.sub, color: colors.inkDim },
  section: { gap: space.s2 },
  heading: { ...type.body, color: colors.ink, fontWeight: "700" },
  body: { ...type.meta, color: colors.inkDim, lineHeight: 20 },
  end: { ...type.meta, color: colors.inkMute, textAlign: "center", marginTop: space.s4 },
  foot: {
    paddingHorizontal: space.s6,
    paddingTop: space.s3,
    paddingBottom: space.s3,
    gap: space.s2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
  },
  error: { color: colors.stop, textAlign: "center" },
});
