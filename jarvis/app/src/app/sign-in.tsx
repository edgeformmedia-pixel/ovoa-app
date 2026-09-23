import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { devlog } from "../lib/devlog";
import { appleAuth, appleSignInAvailable, signInWithApple, signInWithGoogle } from "../lib/signInWith";
import { colors } from "../lib/theme";

// The screen almost nobody got past. device_logs, 2026-09-21: 38 devices, 123
// failed sign-ins in clusters of 4-7, 4 failed sign-ups from one of them, and 2
// accounts to show for it. Everybody landed on "Sign in", typed an address that
// had no account behind it, read "Invalid email or password" — which is what the
// server also says for a typo, and for a missing account, and for a bad password
// — and left. So: start a new phone on the form that can succeed, say which box
// is wrong, and always leave a door open.
//
// Google and Apple are two more doors, on both forms: they sign in to the
// account with that address. When there isn't one, Google asks only for a name
// and a password to make it, and Apple makes it without asking anything. An
// account made with the address before anyone proved it gets a new password
// from the person Google just proved it for (lib/signInWith.ts, api/src/signin.ts).

type Field = "name" | "email" | "password";
type Fields = Partial<Record<Field, string>>;
type Provider = "Google" | "Apple";
/**
 * Google proved an address with no account yet: the name + password step.
 * (Apple never hands back a ticket now, api/src/index.ts afterApple, but the
 * step takes one from either.) `existing`: there is an account, never proven,
 * and this gives it a new password.
 */
type Finishing = { ticket: string; email: string; via: Provider; existing: boolean };

/** Rough enough to catch a typo before a round trip; the server has the real rule. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** For the log: which mail provider, never the address. */
function domainOf(address: string) {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : "no @";
}

export default function SignIn() {
  const { signIn, signUp, signInWithSession, signUpWithTicket, hasAccountHere } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">(hasAccountHere ? "signin" : "signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({});
  /** Shown after a failed sign-in: the way on for someone who never had an account. */
  const [offerSignup, setOfferSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Which of Google or Apple is on screen or being checked. */
  const [provider, setProvider] = useState<Provider | null>(null);
  const [finishing, setFinishing] = useState<Finishing | null>(null);
  /** Only where Apple's sheet can open: iOS, in the installed app. */
  const [appleShown, setAppleShown] = useState(false);

  useEffect(() => {
    let live = true;
    void appleSignInAvailable().then((ok) => live && setAppleShown(ok));
    return () => {
      live = false;
    };
  }, []);

  const isSignup = mode === "signup";
  /** Either form that ends with a new account asks for a name and an 8+ password. */
  const makesAccount = isSignup || !!finishing;

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
    if (makesAccount && !name.trim()) bad.name = "Enter your name";
    if (!finishing) {
      if (!email.trim()) bad.email = "Enter your email";
      else if (!LOOKS_LIKE_EMAIL.test(email.trim())) bad.email = "That email doesn't look right — check it for a typo";
    }
    if (!password) bad.password = finishing ? "Pick a password" : "Enter your password";
    else if (makesAccount && password.length < 8) bad.password = "Password must be at least 8 characters";
    return bad;
  };

  /** The name + password step after Google, making (or claiming) the account with the proven address. */
  const finish = async (done: Finishing) => {
    const what = done.existing ? "new password" : "sign-up";
    devlog("log", `sign-in: finishing a ${done.via} ${what} · ${domainOf(done.email)}`);
    try {
      await signUpWithTicket(done.ticket, name.trim(), password);
      devlog("log", `sign-in: ${done.existing ? "password set" : "account created"} with ${done.via}`);
    } catch (err) {
      setBusy(false);
      devlog("err", "sign-in: finishing refused", err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && Object.keys(err.fields).length) return setFields(err.fields);
      // Most likely the half hour ran out. Starting again is one tap away.
      setFinishing(null);
      setPassword("");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const submit = async () => {
    if (busy || provider) return;
    setError(null);
    setOfferSignup(false);
    const bad = check();
    setFields(bad);
    if (Object.keys(bad).length) {
      devlog("warn", `sign-in: ${finishing ? "finishing" : mode} not sent`, Object.keys(bad).join(", "));
      return;
    }
    setBusy(true);
    if (finishing) return finish(finishing);
    const address = email.trim();
    devlog("log", `sign-in: ${isSignup ? "creating an account" : "signing in"} · ${domainOf(address)}`);
    try {
      if (isSignup) await signUp(address, password, name.trim());
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

  /** Google or Apple: signed in, or on to the name + password step. Cancelling says nothing. */
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
      if ("token" in proven) {
        await signInWithSession(proven, !!proven.created);
        devlog("log", `sign-in: ${proven.created ? "account created" : "signed in"} with ${via}`);
        return;
      }
      const existing = !!proven.existing;
      devlog("log", `sign-in: ${via} proved an address with ${existing ? "an unproven account" : "no account yet"} · ${domainOf(proven.email)}`);
      setFinishing({ ticket: proven.ticket, email: proven.email, via, existing });
      if (proven.name) setName(proven.name);
      setPassword("");
    } catch (err) {
      devlog("err", `sign-in: ${via} failed`, err instanceof Error ? err.message : String(err));
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setProvider(null);
    }
  };

  const nameField = (
    <Field error={fields.name}>
      <TextInput
        style={[styles.input, !!fields.name && styles.inputBad]}
        placeholder="Your name"
        placeholderTextColor={colors.inkMute}
        value={name}
        onChangeText={onEdit("name", setName)}
        textContentType="name"
        autoComplete="name"
        returnKeyType="next"
      />
    </Field>
  );
  const passwordField = (
    <Field error={fields.password}>
      <TextInput
        style={[styles.input, !!fields.password && styles.inputBad]}
        placeholder={makesAccount ? "Password (8+ characters)" : "Password"}
        placeholderTextColor={colors.inkMute}
        value={password}
        onChangeText={onEdit("password", setPassword)}
        secureTextEntry
        textContentType={makesAccount ? "newPassword" : "password"}
        autoComplete={makesAccount ? "new-password" : "current-password"}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
    </Field>
  );
  const mainButton = (label: string) => (
    <Pressable
      style={({ pressed }) => [styles.button, (pressed || busy) && { opacity: 0.7 }]}
      onPress={submit}
      disabled={busy}
    >
      {busy ? <ActivityIndicator color={colors.paper} /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.safe}>
        {/* Scrolls only when it has to: a small phone with the keyboard up, now that there are more rows. */}
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled" bounces={false}>
          <Image source={require("../../assets/logo-wordmark.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="OVOA" />

          {finishing ? (
            <>
              <Text style={styles.subtitle}>One more step</Text>
              <Text style={styles.note}>
                {finishing.existing
                  ? `${finishing.via} confirmed ${finishing.email}. There's already an account with this email, made before anyone confirmed it, so pick a new password for it.`
                  : `${finishing.via} confirmed ${finishing.email}. Add your name, and a password for signing in with your email.`}
              </Text>
              {nameField}
              {passwordField}
              {error && <Text style={styles.error}>{error}</Text>}
              {mainButton(finishing.existing ? "Set password and sign in" : "Create account")}
              <Pressable
                onPress={() => {
                  devlog("log", `sign-in: left the ${finishing.via} ${finishing.existing ? "new password" : "sign-up"}`);
                  setFinishing(null);
                  setPassword("");
                  setFields({});
                  setError(null);
                }}
                style={styles.switch}
                disabled={busy}
              >
                <Text style={styles.switchText}>Cancel</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.subtitle}>{isSignup ? "Create your account" : "Welcome back"}</Text>

              <View style={[styles.providers, (!!provider || busy) && styles.waiting]}>
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

              <View style={styles.or}>
                <View style={styles.orLine} />
                <Text style={styles.orText}>or with your email</Text>
                <View style={styles.orLine} />
              </View>

              {isSignup && nameField}
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
              {passwordField}

              {error && <Text style={styles.error}>{error}</Text>}

              {mainButton(isSignup ? "Create account" : "Sign in")}

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
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
  note: { color: colors.inkDim, fontSize: 15, lineHeight: 21, textAlign: "center", marginTop: -12, marginBottom: 8 },
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
});
