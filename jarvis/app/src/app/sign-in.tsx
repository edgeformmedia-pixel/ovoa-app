import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Btn } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { devlog } from "../lib/devlog";
import { appleAuth, appleSignInAvailable, signInWithApple, signInWithGoogle } from "../lib/signInWith";
import { TERMS, TERMS_UPDATED } from "../lib/terms";
import { colors, space, type } from "../lib/theme";

// The one screen a new person sees before the app, kept as small as it can be.
//
// Continue with Apple or Google is one tap and nothing after it: the server makes
// the account there and then (api/src/index.ts afterApple). Email and a password
// is the smaller link under them. The Terms are one line at the bottom, and
// continuing is agreeing (lib/auth.tsx records it), so there's no Terms screen
// to scroll. The phone's permissions are asked where each is first needed, not
// in a row up front. Only an email sign-up has one more step, the emailed code,
// because nobody has proven that address yet.
//
// History: device_logs, 2026-09-21: 38 devices, 123 failed sign-ins in clusters
// of 4-7, 4 failed sign-ups from one of them, and 2 accounts to show for it.
// Everybody landed on "Sign in", typed an address that had no account behind it,
// read "Invalid email or password" — which is what the server also says for a
// typo, and for a missing account, and for a bad password — and left. So: start
// a new phone on the form that can succeed, say which box is wrong, and always
// leave a door open.

type Field = "email" | "password";
type Fields = Partial<Record<Field, string>>;
type Provider = "Google" | "Apple";

/** Rough enough to catch a typo before a round trip; the server has the real rule. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** For the log: which mail provider, never the address. */
function domainOf(address: string) {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : "no @";
}

export default function SignIn() {
  const { signIn, signUp, signInWithSession, hasAccountHere, lastEmail } = useAuth();
  // A phone that has been signed in opens on Sign in with the last address
  // filled in (lib/auth.tsx LAST_EMAIL_KEY): what's left to type is the
  // password, and Create an account is still the link underneath.
  const [mode, setMode] = useState<"signin" | "signup">(hasAccountHere ? "signin" : "signup");
  const [email, setEmail] = useState(lastEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({});
  /** Shown after a failed sign-in: the way on for someone who never had an account. */
  const [offerSignup, setOfferSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Which of Google or Apple is on screen or being checked. */
  const [provider, setProvider] = useState<Provider | null>(null);
  /** The email form is behind a link, unless this phone already knows an address. */
  const [showEmail, setShowEmail] = useState(!!lastEmail);
  const [showTerms, setShowTerms] = useState(false);
  /** Only where Apple's sheet can open: iOS, in the installed app. */
  const [appleShown, setAppleShown] = useState(false);

  useEffect(() => {
    let live = true;
    void appleSignInAvailable().then((ok) => live && setAppleShown(ok));
    // Which form it opened on, never the address: the 409 at 16:25 on 2026-09-23
    // couldn't say whether the screen or the person had picked Create an account.
    devlog("log", `sign-in: opened on ${mode}${email ? " with the last address filled in" : ""}`);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isSignup = mode === "signup";

  const switchTo = (next: "signin" | "signup", because?: string) => {
    devlog("log", `sign-in: switching to ${next}${because ? ` — ${because}` : ""}`);
    setMode(next);
    setError(because ?? null);
    setFields({});
    setOfferSignup(false);
  };

  const onEdit = (key: Field, set: (value: string) => void) => (value: string) => {
    set(value);
    setFields((f) => (f[key] ? { ...f, [key]: undefined } : f));
  };

  /** Everything the server would reject, caught here so nobody round-trips to find out. */
  const check = () => {
    const bad: Fields = {};
    if (!email.trim()) bad.email = "Enter your email";
    else if (!LOOKS_LIKE_EMAIL.test(email.trim())) bad.email = "That email doesn't look right — check it for a typo";
    if (!password) bad.password = "Enter your password";
    else if (isSignup && password.length < 8) bad.password = "Password must be at least 8 characters";
    return bad;
  };

  const submit = async () => {
    if (busy || provider) return;
    setError(null);
    setOfferSignup(false);
    const bad = check();
    setFields(bad);
    if (Object.keys(bad).length) {
      devlog("warn", `sign-in: ${mode} not sent`, Object.keys(bad).join(", "));
      return;
    }
    setBusy(true);
    const address = email.trim();
    devlog("log", `sign-in: ${isSignup ? "creating an account" : "signing in"} · ${domainOf(address)}`);
    try {
      if (isSignup) await signUp(address, password);
      else await signIn(address, password);
      devlog("log", `sign-in: ${isSignup ? "account created" : "signed in"}`);
    } catch (err) {
      setBusy(false);
      if (!(err instanceof ApiError)) {
        devlog("err", `sign-in: ${mode} failed`, err instanceof Error ? err.message : String(err));
        setError(err instanceof Error ? err.message : "Something went wrong");
        return;
      }
      devlog("err", `sign-in: ${mode} refused with ${err.status}`, err.message);
      // Signup now says which box is wrong; put the message under that box.
      // 409 first: it now carries a `fields` of its own, and checking fields
      // before it made this branch unreachable — the returning person stayed on
      // the create-account form reading "an account with that email exists",
      // which is the exact dead end this screen exists to remove.
      if (err.status === 409) return switchTo("signin", "You already have an account here. Sign in instead.");
      if (Object.keys(err.fields).length) return setFields(err.fields);
      // Login's 401 stays deliberately vague — the server will not say whether the
      // account exists — so the way out is offered here instead of in the reply.
      if (!isSignup && err.status === 401) {
        setError("That email and password don't match an account.");
        setOfferSignup(true);
        return;
      }
      setError(err.message);
    }
  };

  /** Google or Apple: signed in, with an account made on the spot if there wasn't one. Cancelling says nothing. */
  const continueWith = async (via: Provider) => {
    if (busy || provider) return;
    setError(null);
    setOfferSignup(false);
    setFields({});
    setProvider(via);
    devlog("log", `sign-in: continuing with ${via}`);
    try {
      const proven = via === "Google" ? await signInWithGoogle() : await signInWithApple();
      if (!proven) {
        devlog("log", `sign-in: ${via} cancelled`);
        return;
      }
      // A ticket is the old two-step Google sign-up, which the server no longer sends.
      if (!("token" in proven)) throw new Error(`${via} sign-in didn't work just now. Try again.`);
      await signInWithSession(proven, !!proven.created);
      devlog("log", `sign-in: ${proven.created ? "account created" : "signed in"} with ${via}`);
    } catch (err) {
      devlog("err", `sign-in: ${via} failed`, err instanceof Error ? err.message : String(err));
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setProvider(null);
    }
  };

  const waiting = !!provider || busy;

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.safe}>
        {/* Scrolls only when it has to: a small phone with the keyboard up. */}
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled" bounces={false}>
          <Image source={require("../../assets/logo-wordmark.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="OVOA" />
          <Text style={styles.subtitle}>{hasAccountHere ? "Welcome back" : "Get started in one tap"}</Text>

          <View style={[styles.providers, waiting && styles.waiting]}>
            {appleShown && appleAuth && (
              // Apple's own button, as App Review requires: its look can't be restyled.
              <appleAuth.AppleAuthenticationButton
                buttonType={appleAuth.AppleAuthenticationButtonType.CONTINUE}
                buttonStyle={appleAuth.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={12}
                style={styles.appleButton}
                onPress={() => void continueWith("Apple")}
              />
            )}
            <Pressable
              style={({ pressed }) => [styles.google, pressed && { opacity: 0.7 }]}
              onPress={() => void continueWith("Google")}
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
            >
              {provider === "Google" ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <>
                  <GoogleG />
                  <Text style={styles.googleText}>Continue with Google</Text>
                </>
              )}
            </Pressable>
          </View>

          {error && !showEmail && <Text style={styles.error}>{error}</Text>}

          {!showEmail ? (
            <Pressable onPress={() => setShowEmail(true)} style={styles.switch} accessibilityRole="button">
              <Text style={styles.switchText}>
                Use <Text style={{ color: colors.now }}>email</Text> instead
              </Text>
            </Pressable>
          ) : (
            <View style={[styles.form, waiting && styles.waiting]}>
              <View style={styles.or}>
                <View style={styles.orLine} />
                <Text style={styles.orText}>or with your email</Text>
                <View style={styles.orLine} />
              </View>
              <Field error={fields.email}>
                <TextInput
                  style={[styles.input, !!fields.email && styles.inputBad]}
                  placeholder="Email"
                  placeholderTextColor={colors.inkMute}
                  value={email}
                  onChangeText={onEdit("email", setEmail)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  autoComplete="email"
                  returnKeyType="next"
                />
              </Field>
              <Field error={fields.password}>
                <TextInput
                  style={[styles.input, !!fields.password && styles.inputBad]}
                  placeholder={isSignup ? "Password (8+ characters)" : "Password"}
                  placeholderTextColor={colors.inkMute}
                  value={password}
                  onChangeText={onEdit("password", setPassword)}
                  secureTextEntry
                  textContentType={isSignup ? "newPassword" : "password"}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  returnKeyType="go"
                  onSubmitEditing={submit}
                />
              </Field>

              {error && <Text style={styles.error}>{error}</Text>}

              <Pressable
                style={({ pressed }) => [styles.button, (pressed || busy) && { opacity: 0.7 }]}
                onPress={submit}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={colors.paper} /> : <Text style={styles.buttonText}>{isSignup ? "Create account" : "Sign in"}</Text>}
              </Pressable>

              {offerSignup && (
                <Pressable style={styles.secondary} onPress={() => switchTo("signup")}>
                  <Text style={styles.secondaryText}>New here? Create an account</Text>
                </Pressable>
              )}

              <Pressable onPress={() => switchTo(isSignup ? "signin" : "signup")} style={styles.switch}>
                <Text style={styles.switchText}>
                  {isSignup ? "Already have an account? " : "New here? "}
                  <Text style={{ color: colors.now }}>{isSignup ? "Sign in" : "Create an account"}</Text>
                </Text>
              </Pressable>
            </View>
          )}

          {/* Continuing is agreeing: lib/auth.tsx records it once the account is in. */}
          <Text style={styles.terms}>
            By continuing you agree to the{" "}
            <Text style={styles.termsLink} onPress={() => setShowTerms(true)} accessibilityRole="link">
              Terms of Service
            </Text>
            .
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showTerms} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowTerms(false)}>
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          <ScrollView contentContainerStyle={styles.termsPage}>
            <Text style={styles.termsTitle}>Terms of Service</Text>
            <Text style={styles.termsLead}>Last updated {TERMS_UPDATED}.</Text>
            {TERMS.map((section) => (
              <View key={section.title} style={{ gap: space.s2 }}>
                <Text style={styles.termsHeading}>{section.title}</Text>
                {section.paragraphs.map((p, i) => (
                  <Text key={i} style={styles.termsBody}>
                    {p}
                  </Text>
                ))}
              </View>
            ))}
          </ScrollView>
          <View style={styles.termsFoot}>
            <Btn label="Close" kind="go" onPress={() => setShowTerms(false)} />
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

/** One input and, under it, the reason it was rejected. */
function Field({ error, children }: { error?: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      {children}
      {!!error && <Text style={styles.fieldError}>{error}</Text>}
    </View>
  );
}

/**
 * Google's "G", in Google's own colours. Its sign-in branding asks for the mark
 * as it is, so these four are the one place colours outside theme.ts belong.
 */
function GoogleG() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  container: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 28, paddingVertical: 16, gap: 12 },
  // The wordmark is a white silhouette on transparency, drawn back when the
  // app was near-black. tintColor recolours it for the white base without
  // needing new artwork — it is pure alpha, so the letterforms are unchanged.
  logo: { width: "86%", height: 110, alignSelf: "center", marginBottom: 8, tintColor: colors.ink },
  subtitle: { color: colors.inkMute, fontSize: 16, textAlign: "center", marginBottom: 20 },
  form: { gap: 12 },
  providers: { gap: 12 },
  /** While Google or Apple is being asked, or the form is sending: dimmed and not pressable. */
  waiting: { opacity: 0.6, pointerEvents: "none" },
  // Apple asks for its button to be at least as big as any other sign-in button.
  appleButton: { width: "100%", height: 50 },
  // Google's light button: white, a grey outline, the G on the left of the words.
  google: {
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#747775",
    backgroundColor: colors.paper,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  googleText: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  or: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 4 },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  orText: { color: colors.inkMute, fontSize: 13 },
  field: { gap: 6 },
  input: {
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.ink,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  inputBad: { borderColor: colors.stop },
  fieldError: { color: colors.stop, fontSize: 13, paddingHorizontal: 4 },
  error: { color: colors.stop, textAlign: "center" },
  button: {
    backgroundColor: colors.now,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: { color: colors.paper, fontSize: 16, fontWeight: "700" },
  secondary: {
    borderColor: colors.now,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  secondaryText: { color: colors.now, fontSize: 16, fontWeight: "600" },
  switch: { alignItems: "center", paddingVertical: 12 },
  switchText: { color: colors.inkMute, fontSize: 15 },
  terms: { color: colors.inkMute, fontSize: 13, lineHeight: 18, textAlign: "center", marginTop: 8 },
  termsLink: { color: colors.now, textDecorationLine: "underline" },
  termsPage: { paddingHorizontal: space.s6, paddingTop: space.s8, paddingBottom: space.s6, gap: space.s4 },
  termsTitle: { ...type.title, color: colors.ink },
  termsLead: { ...type.sub, color: colors.inkDim },
  termsHeading: { ...type.body, color: colors.ink, fontWeight: "700" },
  termsBody: { ...type.meta, color: colors.inkDim, lineHeight: 20 },
  termsFoot: {
    paddingHorizontal: space.s6,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
  },
});
