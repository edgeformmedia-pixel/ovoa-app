import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { devlog } from "../lib/devlog";
import { colors } from "../lib/theme";

// The screen almost nobody got past. device_logs, 2026-09-21: 38 devices, 123
// failed sign-ins in clusters of 4-7, 4 failed sign-ups from one of them, and 2
// accounts to show for it. Everybody landed on "Sign in", typed an address that
// had no account behind it, read "Invalid email or password" — which is what the
// server also says for a typo, and for a missing account, and for a bad password
// — and left. So: start a new phone on the form that can succeed, say which box
// is wrong, and always leave a door open.

type Field = "name" | "email" | "password";
type Fields = Partial<Record<Field, string>>;

/** Rough enough to catch a typo before a round trip; the server has the real rule. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** For the log: which mail provider, never the address. */
function domainOf(address: string) {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : "no @";
}

export default function SignIn() {
  const { signIn, signUp, hasAccountHere } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">(hasAccountHere ? "signin" : "signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({});
  /** Shown after a failed sign-in: the way on for someone who never had an account. */
  const [offerSignup, setOfferSignup] = useState(false);
  const [busy, setBusy] = useState(false);

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
    if (isSignup && !name.trim()) bad.name = "Enter your name";
    if (!email.trim()) bad.email = "Enter your email";
    else if (!LOOKS_LIKE_EMAIL.test(email.trim())) bad.email = "That email doesn't look right — check it for a typo";
    if (!password) bad.password = "Enter your password";
    else if (isSignup && password.length < 8) bad.password = "Password must be at least 8 characters";
    return bad;
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    setOfferSignup(false);
    const bad = check();
    setFields(bad);
    if (Object.keys(bad).length) {
      devlog("warn", `sign-in: ${mode} not sent`, Object.keys(bad).join(", "));
      return;
    }
    const address = email.trim();
    setBusy(true);
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
      if (Object.keys(err.fields).length) return setFields(err.fields);
      if (err.status === 409) return switchTo("signin", "You already have an account here. Sign in instead.");
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

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
        <Image source={require("../../assets/logo-wordmark.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="OVOA" />
        <Text style={styles.subtitle}>{isSignup ? "Create your account" : "Welcome back"}</Text>

        {isSignup && (
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
        )}
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
          {busy ? (
            <ActivityIndicator color={colors.paper} />
          ) : (
            <Text style={styles.buttonText}>{isSignup ? "Create account" : "Sign in"}</Text>
          )}
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  container: { flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 12 },
  // The wordmark is a white silhouette on transparency, drawn back when the
  // app was near-black. tintColor recolours it for the white base without
  // needing new artwork — it is pure alpha, so the letterforms are unchanged.
  logo: { width: "86%", height: 110, alignSelf: "center", marginBottom: 8, tintColor: colors.ink },
  subtitle: { color: colors.inkMute, fontSize: 16, textAlign: "center", marginBottom: 20 },
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
