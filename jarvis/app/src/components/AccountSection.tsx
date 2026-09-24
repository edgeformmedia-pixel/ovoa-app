import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { GoogleConnection } from "./GoogleConnection";
import { YourPlan } from "./Plan";
import { Btn, Row } from "./ui";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/auth";
import { colors, space, type } from "../lib/theme";

// Who you are to OVOA: your plan, your email, your name, your password, your
// Google accounts, and the ways out. Settings → Account (2026-09-24: Settings
// became groups that open and close, and the Google accounts moved up here with
// the rest of the account). The password fields stay folded away behind
// "Change password" until they're wanted.

export function AccountSection({ google }: { /** Show the Google accounts (not on the free plan: they're the assistant's). */ google: boolean }) {
  const { token, user, setUser, signOut, clear, refreshUser } = useSession();
  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [sending, setSending] = useState(false);

  if (!user) return null; // signing out

  const saveName = async () => {
    setSaving(true);
    try {
      setUser((await api.updateMe(token, { name: name.trim() })).user);
    } catch (err) {
      Alert.alert("Couldn't save", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    if (newPw.length < 8) return Alert.alert("New password must be at least 8 characters");
    try {
      await api.changePassword(token, currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      setPasswordOpen(false);
      Alert.alert("Password changed", "Other devices have been signed out.");
    } catch (err) {
      Alert.alert("Couldn't change password", (err as Error).message);
    }
  };

  /** The email with the Confirm button (and a code, as a backup) goes out; the server proves it when it's tapped. */
  const confirmEmail = async () => {
    setSending(true);
    try {
      const res = await api.sendCode(token);
      if (res.emailVerified) return void (await refreshUser());
      Alert.alert("Check your email", `We sent an email to ${user.email}. Tap Confirm my email in it, and you're done.`);
    } catch (err) {
      const soon = err instanceof ApiError && err.status === 429;
      Alert.alert(soon ? "Already on its way" : "Couldn't send it", (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const deleteAccount = () =>
    Alert.alert("Delete your account?", "This permanently deletes your account, chats, and memories.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          api
            .deleteAccount(token)
            .then(clear)
            .catch((err) => Alert.alert("Something went wrong", err.message)),
      },
    ]);

  return (
    <View style={styles.section}>
      <YourPlan />

      <Row icon="mail-outline" tone="blue" title="Email" value={user.email} first />
      {user.emailVerified === false && (
        <View style={{ gap: space.s2 }}>
          <Text style={styles.meta}>Not confirmed yet.</Text>
          <Btn label={sending ? "Sending…" : "Confirm my email"} onPress={() => void confirmEmail()} disabled={sending} style={styles.btn} />
        </View>
      )}

      <Field label="Your name" value={name} onChangeText={setName} />
      <Btn
        label={saving ? "Saving…" : "Save name"}
        onPress={saveName}
        disabled={!name.trim() || name.trim() === user.name || saving}
        style={styles.btn}
      />

      <Pressable
        style={styles.disclosure}
        onPress={() => setPasswordOpen((open) => !open)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: passwordOpen }}
      >
        <Text style={styles.label}>Change password</Text>
        <Text style={styles.chevron}>{passwordOpen ? "▾" : "▸"}</Text>
      </Pressable>
      {passwordOpen && (
        <View style={{ gap: space.s3 }}>
          <Field label="Current password" value={currentPw} onChangeText={setCurrentPw} secureTextEntry />
          <Field label="New password" value={newPw} onChangeText={setNewPw} secureTextEntry />
          <Btn label="Change password" onPress={changePassword} disabled={!currentPw || !newPw} style={styles.btn} />
        </View>
      )}

      {google && (
        <>
          <Text style={styles.sub}>Google accounts</Text>
          <GoogleConnection token={token} />
        </>
      )}

      <Text style={styles.sub}>Session</Text>
      <Btn label="Sign out" onPress={signOut} style={styles.btn} />
      <Btn label="Delete account" kind="danger" onPress={deleteAccount} style={styles.btn} />
    </View>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.inkMute}
        autoCorrect={!props.secureTextEntry}
        autoCapitalize={props.secureTextEntry ? "none" : "words"}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.s3 },
  label: { ...type.body, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  sub: { ...type.meta, fontWeight: "600", color: colors.inkMute, marginTop: space.s3 },
  chevron: { ...type.meta, color: colors.inkMute },
  disclosure: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: space.s1 },
  btn: { alignSelf: "flex-start" },
  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },
});
