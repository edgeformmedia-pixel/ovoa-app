import { useState } from "react";
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
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

export default function SignIn() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignup = mode === "signup";

  const submit = async () => {
    setError(null);
    if (isSignup && password.length < 8) return setError("Password must be at least 8 characters");
    setBusy(true);
    try {
      if (isSignup) await signUp(email.trim(), password, name.trim());
      else await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
        <Image source={require("../../assets/logo-wordmark.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="OVOA" />
        <Text style={styles.subtitle}>{isSignup ? "Create your account" : "Welcome back"}</Text>

        {isSignup && (
          <TextInput
            style={styles.input}
            placeholder="Your name"
            placeholderTextColor={colors.textDim}
            value={name}
            onChangeText={setName}
            textContentType="name"
            autoComplete="name"
          />
        )}
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textDim}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
        />
        <TextInput
          style={styles.input}
          placeholder={isSignup ? "Password (8+ characters)" : "Password"}
          placeholderTextColor={colors.textDim}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType={isSignup ? "newPassword" : "password"}
          autoComplete={isSignup ? "new-password" : "current-password"}
          onSubmitEditing={submit}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={({ pressed }) => [styles.button, (pressed || busy) && { opacity: 0.7 }]}
          onPress={submit}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.buttonText}>{isSignup ? "Create account" : "Sign in"}</Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => {
            setMode(isSignup ? "signin" : "signup");
            setError(null);
          }}
          style={styles.switch}
        >
          <Text style={styles.switchText}>
            {isSignup ? "Already have an account? " : "New here? "}
            <Text style={{ color: colors.accent }}>{isSignup ? "Sign in" : "Create an account"}</Text>
          </Text>
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 12 },
  logo: { width: "86%", height: 110, alignSelf: "center", marginBottom: 8 },
  subtitle: { color: colors.textDim, fontSize: 16, textAlign: "center", marginBottom: 20 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  error: { color: colors.danger, textAlign: "center" },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: { color: colors.bg, fontSize: 16, fontWeight: "700" },
  switch: { alignItems: "center", paddingVertical: 12 },
  switchText: { color: colors.textDim, fontSize: 15 },
});
