import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog } from "../lib/devlog";
import { firstOpen } from "../lib/firstOpen";
import { colors } from "../lib/theme";

// The code step, straight after signing up (the v1 release, decision 3).
//
// The server emailed a six-digit code with the sign-up (api/src/verify.ts), and
// a new account can't do anything else until it's typed. iOS offers the code
// from Mail above the keyboard (textContentType oneTimeCode), so it's usually
// one tap. A new code can be asked for once a minute.
//
// An account from before codes sees this once too, at its next open, because
// GET /me says its address isn't proven. The server doesn't hold those
// accounts, so they can put it off ("Not now", kept on this phone by
// lib/firstOpen.ts); a new account can't, but can start again with another
// address, which deletes the account it has only just made.
//
// Its own screen rather than a step inside sign-in.tsx: the account exists
// and is signed in by now, and app/_layout.tsx shows this until the address is
// proven.

const DIGITS = 6;

export default function VerifyEmail() {
  const { token, user, refreshUser, codeSentAt, clear } = useSession();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /** When "Send a new code" works again. Sign-up's own code counts. */
  const [nextAt, setNextAt] = useState(codeSentAt ? codeSentAt + 60_000 : 0);
  const [now, setNow] = useState(Date.now());
  const input = useRef<TextInput>(null);
  const isNew = !!user.mustVerify;

  // The countdown on "Send a new code".
  useEffect(() => {
    if (nextAt <= now) return;
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [nextAt, now]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await api.sendCode(token);
      // Proven since (on ovoa.ai, say): nothing to type.
      if (res.emailVerified) return void (await refreshUser());
      devlog("log", "verify: a code was sent");
      setNextAt(Date.now() + (res.resendInSeconds ?? 60) * 1000);
      setNow(Date.now());
    } catch (err) {
      // One went out less than a minute ago: that one still works, so just count down.
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) {
        setNextAt(Date.now() + err.retryAfter * 1000);
        setNow(Date.now());
        if (err.retryAfter > 60) setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Couldn't send a code");
      }
    } finally {
      setSending(false);
    }
  };

  // No code from the sign-up (an account from before codes, or it didn't go
  // out): ask for one now. Sign-up's own is left to arrive.
  useEffect(() => {
    if (!codeSentAt) void send();
  }, []);

  const confirm = async (digits: string) => {
    if (busy || digits.length !== DIGITS) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyCode(token, digits);
      devlog("log", "verify: address proven");
      // GET /me now says so, and the next step comes up (app/_layout.tsx).
      await refreshUser();
    } catch (err) {
      setBusy(false);
      setCode("");
      setError(err instanceof Error ? err.message : "That didn't work");
      input.current?.focus();
    }
  };

  const onChange = (raw: string) => {
    // Digits only, so a code pasted as "123 456" still fits.
    const digits = raw.replace(/\D/g, "").slice(0, DIGITS);
    setCode(digits);
    setError(null);
    if (digits.length === DIGITS) void confirm(digits);
  };

  const startAgain = () =>
    Alert.alert("Use a different email?", "This removes the account you just made, so you can make it again with the right address.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Start again",
        style: "destructive",
        onPress: async () => {
          try {
            await api.deleteAccount(token);
          } catch (err) {
            devlog("err", "verify: couldn't delete the new account", err instanceof Error ? err.message : String(err));
          }
          await clear();
        },
      },
    ]);

  const wait = Math.max(0, Math.ceil((nextAt - now) / 1000));

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.body}>
          We sent a 6-digit code to <Text style={styles.email}>{user.email}</Text>. Type it here to finish {isNew ? "making your account" : "confirming your email"}.
        </Text>

        <TextInput
          ref={input}
          style={[styles.input, !!error && styles.inputBad]}
          value={code}
          onChangeText={onChange}
          placeholder="123456"
          placeholderTextColor={colors.inkMute}
          keyboardType="number-pad"
          // iOS offers the code from Mail above the keyboard.
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoFocus
          maxLength={DIGITS + 4}
          returnKeyType="done"
          onSubmitEditing={() => void confirm(code)}
          accessibilityLabel="The 6-digit code from the email"
        />
        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={({ pressed }) => [styles.button, (pressed || busy || code.length !== DIGITS) && { opacity: 0.6 }]}
          onPress={() => void confirm(code)}
          disabled={busy || code.length !== DIGITS}
        >
          {busy ? <ActivityIndicator color={colors.paper} /> : <Text style={styles.buttonText}>Confirm</Text>}
        </Pressable>

        <Pressable style={styles.link} onPress={() => void send()} disabled={sending || wait > 0}>
          <Text style={[styles.linkText, (sending || wait > 0) && { color: colors.inkMute }]}>
            {sending ? "Sending…" : wait > 0 ? `Send a new code in ${wait} s` : "Send a new code"}
          </Text>
        </Pressable>
        <Text style={styles.meta}>Nothing yet? Check your junk folder. It comes from no-reply@ovoa.ai.</Text>

        {isNew ? (
          <Pressable style={styles.link} onPress={startAgain}>
            <Text style={styles.quiet}>Wrong email? Start again</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.link} onPress={() => firstOpen.codeLater(user.id)}>
            <Text style={styles.quiet}>Not now</Text>
          </Pressable>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  container: { flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 12 },
  title: { color: colors.ink, fontSize: 26, fontWeight: "700", textAlign: "center" },
  body: { color: colors.inkMute, fontSize: 16, lineHeight: 22, textAlign: "center", marginBottom: 12 },
  email: { color: colors.ink, fontWeight: "600" },
  input: {
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.ink,
    fontSize: 28,
    letterSpacing: 8,
    textAlign: "center",
    paddingVertical: 14,
    fontVariant: ["tabular-nums"],
  },
  inputBad: { borderColor: colors.stop },
  error: { color: colors.stop, textAlign: "center" },
  button: { backgroundColor: colors.now, borderRadius: 12, paddingVertical: 15, alignItems: "center", marginTop: 8 },
  buttonText: { color: colors.paper, fontSize: 16, fontWeight: "700" },
  link: { alignItems: "center", paddingVertical: 10 },
  linkText: { color: colors.now, fontSize: 15, fontWeight: "600" },
  meta: { color: colors.inkMute, fontSize: 13, textAlign: "center" },
  quiet: { color: colors.inkMute, fontSize: 15 },
});
